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
