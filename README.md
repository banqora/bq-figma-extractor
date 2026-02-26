# BQ Figma Extractor

Extract Figma designs into a structured format that AI coding tools can consume directly. Select components in Figma, run the extractor, point your AI dev tool at the output, and tell it to build.

> **Note:** This is a prototype. It works well for common Figma patterns but may not handle every edge case. Use at your own risk and expect rough edges.

## What You Get

For each Figma component, the extractor outputs:

- **`component.tsx`** — React/Tailwind JSX generated from the Figma layout tree
- **`figma-raw.json`** — The full Figma node structure (layout modes, fills, effects, text styles, constraints)
- **`screenshot.png`** — A 2x visual reference
- **`metadata.json`** — Dimensions, asset counts, subcomponent paths
- **`assets/`** — Extracted images (PNG) and vectors (SVG)

Large components are automatically split into subcomponents based on complexity.

## The AI Workflow

The real value isn't the generated code — it's the structured context. The `component.tsx` gives AI a starting point, the `figma-raw.json` gives it exact specs, the screenshot gives it a visual target, and the assets are ready to serve.

**The flow:**

1. Extract your designs from Figma
2. Open your project in an AI coding tool (Claude Code, Cursor, Windsurf, etc.)
3. Point it at the extracted output
4. Tell it what framework/stack to use
5. It builds production components using the Figma data as a spec

### Example: Next.js with Tailwind

After extracting a hero section and navbar from Figma:

```
You: @output/components/hero-section @output/components/navbar

Implement these Figma designs as Next.js components using Tailwind CSS.
Use the screenshots as the visual target, the figma-raw.json for exact
spacing/colors/typography, and the assets in each component's assets/ folder.
Put the components in src/components/ and copy assets to public/figma-assets/.
```

The AI gets the full picture — layout structure, exact hex colors, font sizes, spacing values, gradients, shadows, and the visual reference to check against. It's substantially more context than a screenshot alone.

## Prerequisites

1. **Figma desktop app** — The plugin requires the Figma desktop client (not the browser version). Download it from [figma.com/downloads](https://www.figma.com/downloads/).
2. **Node.js** — v18 or later.

## Install

```bash
git clone <this-repo>
cd bq-figma-extractor
npm install
npm run build
```

This bundles `src/*.ts` into `code.js` which the Figma plugin loads.

## Setup

1. Open the Figma desktop app.
2. Go to **Plugins > Development > Import plugin from manifest** and select `manifest.json` from this repo.
3. Start the local server:

```bash
npm run server
```

The server runs on `http://localhost:3846`.

## Usage

1. Keep `npm run server` running.
2. Open the plugin in Figma (**Plugins > Development > BQ Figma Extractor**).
3. Click **Browse** to choose your output directory (or type a path directly).
4. Select frames/components in Figma, click **Load from Selection**, then **Extract Components**.

### Configuration in the Plugin UI

- **Output Directory** — Where extracted components are saved. Use the Browse button to pick a folder on your machine.
- **Asset Path Prefix** — The path prefix used in generated `src` attributes (default `/figma-assets`). Set this to match where you'll serve assets in your app (e.g. `/images`, `/assets/figma`).

## Output Structure

```
output/
  components/
    hero-section/
      component.tsx
      figma-raw.json
      metadata.json
      screenshot.png
      assets/
        abc123.png
        icon_456_789.svg
      nav-bar/              # Auto-extracted subcomponent
        component.tsx
        figma-raw.json
        metadata.json
        screenshot.png
        assets/
```

## Server Options

```bash
# Lock the output directory (ignores changes from the plugin UI)
npm run server -- --output-dir ./my-project/figma-output

# Mirror all extracted assets to a second directory (e.g. your app's public folder)
npm run server -- --assets-dir ./public/figma-assets

# Combine both
npm run server -- --output-dir ./figma-output --assets-dir ./public/figma-assets
```

`--output-dir` fixes the output path so the plugin UI can't change it. Without this flag, the output directory can be set from the plugin UI at runtime.

`--assets-dir` copies every extracted image/SVG to the specified directory as they're extracted, so assets are immediately servable during development.

## Development

```bash
npm run build:watch   # Rebuild plugin on file changes
npm run typecheck     # Type check without emitting
```

## Port

The server and plugin both use port `3846`. This is set in `manifest.json` (network access whitelist) and `ui.html` (fetch URL). To change it, update both files and run `npm run build`.

## Security

The local server provides filesystem access (directory browsing, file writing) so the Figma plugin can save extracted components. It binds to `127.0.0.1` (localhost only) and is **not intended to be exposed to a network**. Do not run it behind a reverse proxy or on `0.0.0.0`.

If you want to restrict what the server can write to, use the `--output-dir` flag to lock it to a specific path.

## Troubleshooting

- **"Server not running"** in the plugin — Make sure `npm run server` is running in a terminal.
- **Components not found** — The plugin searches by node ID. If a component was deleted and recreated, re-select it and click "Load from Selection" to get the new IDs.
- **Missing assets** — Some complex image fills (crops, transforms, effects) are exported via Figma's `exportAsync` which bakes in visual effects. Simple fills use the original source image.

## License

MIT
