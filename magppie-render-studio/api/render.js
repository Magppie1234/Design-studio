// api/render.js
//
// Vercel serverless function for Magppie Render Studio (OpenAI build).
//
// Staged guardrail pipeline for faithful renders:
//   1. Analyze  - a vision pass reads the uploaded kitchen's exact layout.
//   2. Compose  - that becomes a strict "keep this layout, change only these
//                 surfaces" instruction.
//   3. Edit     - gpt-image-2 renders at high input fidelity.
//   4. Verify   - a vision pass compares the render to the original and reports
//                 whether the layout held.
//
// Steps 1 and 4 degrade gracefully: if they fail, the render still returns.
// Only OPENAI_API_KEY is needed.

import OpenAI, { toFile } from "openai";

export const config = { maxDuration: 60 };

const IMAGE_MODEL   = process.env.OPENAI_IMAGE_MODEL   || "gpt-image-2";
const VISION_MODEL  = process.env.OPENAI_VISION_MODEL  || "gpt-4o";
const IMAGE_SIZE    = process.env.OPENAI_IMAGE_SIZE    || "1536x1024"; // 3:2 to fit the proposal perspective slots
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "high";

// ---- Silverstone finishes (used for both countertop and cabinet) ----
const STONES = {
  "bianco-lasa":   { name: "Bianco Lasa",    desc: "a warm ivory-white engineered stone crossed by soft, feather-fine diagonal striations in pale taupe-grey, delicate and linear, with a polished surface that catches light softly" },
  "statuario-gold":{ name: "Statuario Gold", desc: "a crisp bright-white marble-look stone with bold flowing grey veining from charcoal to soft silver, threaded with fine warm golden-ochre accent veins, polished and reflective" },
  "onyx-gold":     { name: "Onyx Gold",      desc: "a milky ivory translucent onyx with swirling agate-like rings and warm golden-amber veins, a luminous high-gloss surface where light appears to glow from within" },
  "taj":           { name: "Taj",            desc: "a warm sandy-beige quartzite-look stone with soft feathered, brushstroke-like movement in tonal beige and light taupe, in a satin-honed low sheen" },
  "cosmic":        { name: "Cosmic",         desc: "a soft sand-beige limestone-look stone with a finely mottled, lightly pitted surface, small natural inclusions and gentle cloudy variation, in a matte honed finish" },
  "trevi":         { name: "Trevi",          desc: "a soft, even light-grey stone with a smooth concrete-like surface, subtle vertical cloud movement and faint hairline veining, in a quiet matte finish" }
};

const GLASS = {
  clear:   "clear glass, fully transparent with crisp clean edges",
  frosted: "frosted glass, softly opaque and evenly diffusing",
  fluted:  "vertical fluted glass with a soft ribbed texture, semi-translucent and gently diffusing the light behind it",
  bronze:  "bronze-tinted glass, smoky and warm, semi-transparent"
};

const LIGHTING = {
  default: "Integrated lighting, shown as genuinely installed LED and styled like a high-end architectural render: warm 2700K to 3000K accents, layered and subtle, never theatrical. Soft, slightly cool daylight fills the room from a ceiling sunroof above, keeping the walls and upper cabinets bright and clean. Warm under-cabinet LED washes down the backsplash and across the countertop. Warm under-counter LED runs beneath the worktop front overhang and glows onto the cabinetry below. A warm skirting LED at the plinth casts a soft pool of light onto the floor along the full run of cabinets. Warm in-cabinet LED lights the interiors and shelves of the glass-fronted and open brass-framed cabinets so they glow from within. Balance the warm accents against the neutral daylight so the overall image reads bright, warm, and realistic, with soft shadows and gentle reflections on the polished stone."
};

const PROFILE = "slim brushed brass frames with a warm satin finish and soft highlights";

const ANALYZE_PROMPT =
  "Describe the exact spatial layout of this kitchen in 3 to 4 sentences: the positions and counts of tall units, wall and upper cabinets, base cabinets, any island, and the cooktop, oven, sink, and window, using clear left, centre, and right and upper and lower references, plus the camera viewpoint. Be concrete and factual. This description will be used to keep the layout identical while only the surface materials are changed.";

const VERIFY_PROMPT =
  "The first image is an original kitchen design view. The second image is a restyled photorealistic render meant to keep the same layout. In one short sentence, state whether the render preserves the same layout, cabinet positions, island, appliances, window, and camera angle. Begin with 'Layout preserved' if it matches well, or 'Possible drift' followed by what differs, if there are notable structural changes.";

function buildPrompt({ stone, cabinet, glass, lighting, layout, imageNote }) {
  const layoutLine = layout ? "The existing kitchen layout, to preserve exactly: " + layout + "\n\n" : "";
  const noteLine = imageNote ? imageNote + "\n\n" : "";
  return [
    noteLine + "Re-render the kitchen design view as a photorealistic, photographic image of the same kitchen, fully installed and finished.",
    layoutLine + "Preserve the layout and everything that is not a restyled surface exactly: keep every cabinet and shutter position, the island and appliance placement, window positions, proportions, and the camera angle identical to the input. Keep the walls, ceiling, windows, and every appliance exactly as in the input, including the hood or chimney colour and finish, the oven, and the hob, and do not recolour or redesign them. Restyle only the surfaces that are already stone or cabinetry in the input. Do not add stone to any wall or ceiling that is not stone in the input, and do not extend stone up to the ceiling beyond where it appears in the input.",
    "",
    "Surfaces to apply:",
    "- Countertop and backsplash: " + stone + ".",
    "- Cabinet shutters, surfaced in " + cabinet + ".",
    "- Upper glass shutters: " + glass + ", framed in " + PROFILE + ".",
    "",
    "Texture mapping: map every stone surface as large-format, book-matched polished slabs. The veining must be large in scale and flow continuously across each surface and across adjacent panels, as if cut from a single slab, and it must run continuously from the countertop up into the backsplash. Never render the stone as small, busy, repeating, or visibly tiled texture. Keep the stone scale and character consistent across every surface it covers, so the countertop, backsplash, and stone-surfaced cabinet fronts read as one cohesive material. Match the reference stone swatch's actual character and subtlety exactly: reproduce its real colour, vein colour, vein density, and pattern, and if the reference is pale and lightly veined, keep it pale and lightly veined. Do not exaggerate, over-saturate, brighten, or add dramatic swirling veins that are not present in the reference swatch.",
    "",
    lighting,
    "",
    "Render it to the quality of a high-end architectural visualisation photograph: polished engineered-stone surfaces with soft, believable reflections; slim brushed-brass bar-pull handles and shelf frames with gentle metallic highlights; realistic soft shadows and contact shadows; a warm, inviting overall colour grade; and balanced exposure with no blown highlights or crushed shadows.",
    "Accurate to a real, buildable Magppie kitchen. No exaggerated glow, no impossible reflections, no fantasy elements, no people, no text, no watermarks, no logos."
  ].join("\n");
}

function mimeToFormat(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,/.exec(dataUrl || "");
  if (!m) return null;
  const t = m[1];
  if (t === "jpg" || t === "jpeg") return "jpeg";
  return t;
}

async function dataUrlToFile(dataUrl, name) {
  const f = mimeToFormat(dataUrl);
  if (!f) return null;
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  const ext = f === "jpeg" ? "jpg" : f;
  return toFile(buf, name + "." + ext, { type: "image/" + f });
}

const ORD = ["", "first", "second", "third", "fourth", "fifth"];
const ordinal = (n) => ORD[n] || (n + "th");

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { image, countertop, cabinet, glass, lighting, countertopSwatch, cabinetSwatch } = req.body || {};

    const stone = STONES[countertop];
    if (!stone) return res.status(400).json({ error: "Pick a countertop finish before rendering." });
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "Upload a PaletteCAD view before rendering." });
    }

    const format = mimeToFormat(image);
    if (!format) return res.status(400).json({ error: "The uploaded view must be a PNG or JPG image." });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });

    const client = new OpenAI({ apiKey });
    const started = Date.now();
    const visionOn = VISION_MODEL && VISION_MODEL.toLowerCase() !== "none" && VISION_MODEL.toLowerCase() !== "off";
    const verifyOn = visionOn && (process.env.OPENAI_VERIFY || "on").toLowerCase() !== "off";

    // ---- Step 1: Analyze the layout (graceful, skipped when vision is off) ----
    let layout = null;
    if (visionOn) {
      try {
        const a = await client.chat.completions.create({
          model: VISION_MODEL,
          messages: [{ role: "user", content: [
            { type: "text", text: ANALYZE_PROMPT },
            { type: "image_url", image_url: { url: image } }
          ] }]
        });
        layout = a.choices?.[0]?.message?.content?.trim() || null;
      } catch (_) {
        layout = null;
      }
    }

    // ---- Step 2: Assemble images (kitchen + stone swatch references) ----
    const kitchenFile = await dataUrlToFile(image, "view");
    const images = [kitchenFile];
    const roleLines = ["The first image is the kitchen design view to restyle; preserve its layout, cabinet positions, island, appliances, window, and camera angle exactly."];

    const useSwatches = (process.env.USE_SWATCH_REFERENCES || "on") !== "off";
    const sameStone = !!(cabinet && cabinet === countertop);

    if (useSwatches && typeof countertopSwatch === "string") {
      const cf = await dataUrlToFile(countertopSwatch, "counter");
      if (cf) {
        images.push(cf);
        roleLines.push("The " + ordinal(images.length) + " image is the exact stone for the countertop and backsplash; reproduce its colour, veining, scale, and finish faithfully on those surfaces" + (sameStone ? ", and use the same stone on the cabinet shutters" : "") + ".");
      }
    }
    if (useSwatches && !sameStone && typeof cabinetSwatch === "string") {
      const bf = await dataUrlToFile(cabinetSwatch, "cabinet");
      if (bf) {
        images.push(bf);
        roleLines.push("The " + ordinal(images.length) + " image is the exact stone for the cabinet shutters; reproduce it faithfully on the cabinet fronts.");
      }
    }

    // ---- Step 3: Compose the prompt ----
    const cabinetStone = STONES[cabinet] || STONES["taj"];
    const prompt = buildPrompt({
      stone: stone.desc,
      cabinet: cabinetStone.desc,
      glass: GLASS[glass] || GLASS.fluted,
      lighting: LIGHTING[lighting] || LIGHTING.default,
      layout,
      imageNote: roleLines.join(" ")
    });

    // ---- Step 4: Edit (core) ----
    const edit = await client.images.edit({
      model: IMAGE_MODEL,
      image: images.length === 1 ? images[0] : images,
      prompt,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      output_format: "jpeg",
      output_compression: 80
    });

    const b64 = edit.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: "The render returned no image. Please try again." });
    const renderUrl = "data:image/jpeg;base64," + b64;

    // ---- Step 5: Verify (graceful, time-budgeted, skipped when vision is off) ----
    let verify = "Layout check skipped to stay within time.";
    if (verifyOn && Date.now() - started < 48000) {
      try {
        const v = await client.chat.completions.create({
          model: VISION_MODEL,
          messages: [{ role: "user", content: [
            { type: "text", text: VERIFY_PROMPT },
            { type: "image_url", image_url: { url: image } },
            { type: "image_url", image_url: { url: renderUrl } }
          ] }]
        });
        verify = v.choices?.[0]?.message?.content?.trim() || "Layout check returned no result.";
      } catch (_) {
        verify = "Layout check unavailable for this render.";
      }
    }

    return res.status(200).json({ url: renderUrl, verify, finish: stone.name });
  } catch (err) {
    const name = err && err.name ? err.name + ": " : "";
    return res.status(500).json({ error: name + (err && err.message ? err.message : "Unexpected render error.") });
  }
}
