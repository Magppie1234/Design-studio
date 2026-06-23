# Magppie Render Studio

Converts a PaletteCAD kitchen view into a photorealistic render with a chosen
Silverstone finish, ready to drop into a Canva proposal. The designer uploads a
view, picks a finish, and downloads a 16:9 image. No prompting, no API knowledge.

This is the demo build: six countertop finishes are selectable, and cabinet,
glass, and profile are fixed defaults (matte greige, fluted, brass).

## What is in here

```
index.html        The two-screen designer interface
api/render.js      Serverless function: builds the prompt, calls Higgsfield
swatches/          The six finish swatch images
package.json       Declares the Higgsfield SDK
```

## Deploy to Vercel

1. Put this folder in a Git repo (GitHub, GitLab) or drag it into the Vercel
   dashboard as a new project. No framework, no build step needed.
2. In the Vercel project, open Settings, then Environment Variables, and add:

   | Name                    | Value                                          |
   | ----------------------- | ---------------------------------------------- |
   | `HIGGSFIELD_API_KEY`    | your key id from cloud.higgsfield.ai/api-keys  |
   | `HIGGSFIELD_API_SECRET` | your key secret from the same page             |

3. Deploy. Vercel installs the SDK and serves the page plus the function.

The credentials live only in Vercel. They are never sent to the browser.

## The one thing to confirm

The render runs on the editing model named in `HIGGSFIELD_MODEL`. The default
in `api/render.js` is the Flux Kontext image-to-image editor, which keeps the
existing layout and only restyles surfaces.

If you would rather run it on Nano Banana Pro or GPT Image 2, add a
`HIGGSFIELD_MODEL` environment variable in Vercel set to that model's endpoint
string, which you can copy from your Higgsfield dashboard model catalogue. No
code change needed.

If a render ever errors, the exact reason from Higgsfield is shown on screen,
which makes the endpoint or credential issue quick to spot.

## How the designer uses it

1. Upload the PaletteCAD perspective view (PNG or JPG).
2. Pick one countertop and backsplash finish.
3. Generate. The render appears in about a minute.
4. Download the 16:9 image for the proposal.

The view is the structural reference, so the rendered kitchen keeps the same
layout, cabinets, and camera angle. Only the materials change.

## Adding more finishes later

To grow the countertop list beyond the demo six:

1. Drop the new swatch image into `swatches/` (for example `calacatta.jpg`).
   Keep them small, around 800px on the long edge.
2. Add an entry to the `FINISHES` array in `index.html`
   (`{ id: "calacatta", name: "Calacatta" }`).
3. Add a matching entry with a material descriptor to the `STONES` map in
   `api/render.js`. The descriptor is what shapes the render, so describe tone,
   texture, veining, and finish.

To make cabinet, glass, and profile selectable too, the same pattern applies:
expand their maps in `api/render.js` and turn the fixed-defaults strip in
`index.html` into selectable swatch panels.

## Notes

- Desktop browser tool. Output is 16:9 for Canva.
- The view is downscaled to 1600px before upload, which keeps requests fast and
  within Vercel's request size limit.
- Renders usually finish in 10 to 40 seconds. The function is set to allow up to
  60 seconds. If you ever need longer, raise `maxDuration` in `api/render.js`
  (this needs a Vercel Pro plan).
