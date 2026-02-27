# Contributing

Thanks for your interest in contributing to BQ Figma Extractor.

## Setup

```bash
git clone <repo-url>
cd bq-figma-extractor
npm install
npm run build
```

## Development

The plugin has two parts:

- **`src/`** — TypeScript source for the Figma plugin, bundled into `code.js` by esbuild.
- **`server.js`** — Node.js server that receives extracted data from the plugin and writes files to disk.
- **`ui.html`** — Plugin UI loaded inside Figma.

Run `npm run build:watch` to rebuild the plugin on file changes. Run `npm run typecheck` to check types without emitting.

To test changes, import the plugin into Figma via **Plugins > Development > Import plugin from manifest** and point it at `manifest.json`.

## Visual Fidelity Testing

The project includes an automated visual diff pipeline that compares rendered TSX output against Figma screenshots to catch codegen regressions.

### Prerequisites

```bash
npm install --save-dev playwright pixelmatch pngjs
npx playwright install chromium
```

### How it works

The test script (`scripts/test-visual-fidelity.js`) drives the entire pipeline end to end — you run one command and it handles triggering, waiting, screenshotting, and comparing automatically.

1. **Trigger** — The test script sends component config to `POST /trigger-extract` on the server (port 3846).
2. **Plugin polls** — The Figma plugin UI polls `GET /pending-extract` every 2 seconds. When it picks up a pending request, it auto-runs extraction as if you clicked "Extract Components".
3. **Wait** — The test script polls `GET /extraction-status` until the plugin reports completion.
4. **Screenshot** — Playwright opens each component's preview page (`http://localhost:3846/view/preview/...?no-header=1`) at 2x device scale (matching Figma's 2x export resolution) and screenshots the rendered component element.
5. **Compare** — Figma's reference screenshot is composited onto a white background (Figma exports with transparency, the browser renders on white), then compared pixel-by-pixel using pixelmatch.
6. **Report** — Diff images and a JSON results file are saved to `output/test-results/`.

### Running the tests

Start the server first (runs on port 3846):

```bash
npm run server
```

Then run the test script. For the full pipeline, Figma must be open with the plugin loaded:

```bash
# Full pipeline: trigger extraction → wait → screenshot → compare
node scripts/test-visual-fidelity.js --config scripts/test-config.json

# Or use the npm shortcut
npm run test:visual -- --config scripts/test-config.json
```

To test against existing output (no Figma needed):

```bash
# Skip extraction, just screenshot and compare what's already in output/
node scripts/test-visual-fidelity.js --skip-extract

# Test a single component
node scripts/test-visual-fidelity.js --skip-extract --component contact-page/contact-page/page-container

# Adjust the pass/fail threshold (default 15%)
node scripts/test-visual-fidelity.js --skip-extract --threshold 0.20
```

### Config file format

Create a JSON file (see `scripts/test-config.json` for an example):

```json
{
  "components": [
    { "id": "1538:3250", "name": "contact-page", "title": "Contact page", "children": [...] }
  ],
  "outputDir": "./output",
  "decompose": true,
  "threshold": 0.15
}
```

The `components` array uses the same format as the plugin UI's JSON config panel. You can get the IDs by selecting frames in Figma and clicking "Load from Selection" — the config textarea shows the JSON.

### Interpreting results

- **Diff images** in `output/test-results/` show red pixels where the render differs from the Figma screenshot.
- **0% diff** = pixel-perfect match. Font rendering, anti-aliasing, and minor layout rounding typically produce 1-5% noise.
- **>15% diff** (default threshold) = likely a real codegen issue — layout, spacing, colors, or missing elements.
- Check `output/test-results/results.json` for structured results including dimensions and pixel counts.

### Technical details: how screenshots are matched

There are three gotchas that the test script handles to get accurate comparisons. If you're modifying the test pipeline or debugging false positives/negatives, you need to understand these:

#### 1. No-header mode (`?no-header=1`)

The viewer preview page (`/view/preview/:path`) normally renders a dark header bar with the component name and a "Back to all components" link. This bar is not part of the component and would cause every diff to fail.

Adding `?no-header=1` to the preview URL suppresses the header bar entirely and sets the page background to white. The test script always uses this param. You can also use it manually in a browser for a cleaner preview.

#### 2. 2x device scale factor (Figma exports at retina resolution)

Figma's `exportAsync()` produces screenshots at **2x resolution** (retina). A component that is 500px wide in Figma produces a 1000px wide screenshot.

The browser renders at CSS pixel dimensions (1x). To make the screenshots match, the test script creates a Playwright browser context with `deviceScaleFactor: 2` and sets the viewport to **half** the Figma screenshot dimensions:

```
Figma screenshot: 3024 x 3778 px (2x)
Playwright viewport: 1512 x 1889 CSS px
deviceScaleFactor: 2
Resulting screenshot: 3024 x 3778 px (matches Figma)
```

If you change the Figma export scale or the Playwright device scale factor, the dimensions will mismatch and diffs will be meaningless.

#### 3. Transparent backgrounds (Figma) vs white backgrounds (browser)

Figma exports screenshots with **transparent backgrounds** (PNG alpha channel). The browser always renders on a **white background**. Without handling this, every pixel with partial transparency in the Figma screenshot would register as different.

The test script composites the Figma screenshot onto a solid white background before comparison (`compositeOntoWhite()`), so both images have the same opaque white base.

#### 4. Component element targeting

The test script screenshots `#preview-root > *:first-child` (the actual rendered React component element) rather than the full `#preview-root` wrapper div. This avoids capturing extra whitespace around the component that would inflate the diff.

### Key server endpoints for automation

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/trigger-extract` | POST | Queue extraction (body: `{ components, outputDir, decompose }`) |
| `/pending-extract` | GET | Plugin polls this to pick up queued work |
| `/extraction-status` | GET | Poll for extraction completion |
| `/extraction-status` | POST | Plugin reports progress/completion |
| `/view/preview/:path?no-header=1` | GET | Render component without viewer header bar |

## Pull Requests

- Keep changes focused — one feature or fix per PR.
- Run `npm run typecheck` before submitting.
- If you're changing the server or plugin communication, test with the actual Figma desktop app.

## Reporting Issues

Open an issue with:

- What you were trying to do
- What happened instead
- Figma node types involved (if relevant)
- Console output from the server or Figma dev console
