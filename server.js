#!/usr/bin/env node
/**
 * Local server to receive extracted data from Figma plugin
 *
 * Run this before using the plugin:
 * node server.js
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = 3846;

// Output directory — settable at runtime via the plugin UI.
// Default: ./output relative to where the server is launched.
let OUTPUT_DIR = path.resolve(process.cwd(), 'output');

// Optional: mirror assets to a secondary directory (e.g. public/figma-assets).
// Set via --assets-dir CLI flag. null = no mirroring.
let ASSETS_MIRROR_DIR = null;
if (process.argv.includes('--assets-dir')) {
  const idx = process.argv.indexOf('--assets-dir');
  if (process.argv[idx + 1]) {
    ASSETS_MIRROR_DIR = path.resolve(process.argv[idx + 1]);
  }
}

app.use(cors());
app.use(express.json({ limit: '500mb' }));

// Track subcomponent paths for re-export generation
// Maps subcomponent name (last path segment) -> { componentName, fullPath }
let subComponentRegistry = {};

// Mirror an asset to the secondary assets directory (if configured)
async function mirrorAsset(filename, data) {
  if (!ASSETS_MIRROR_DIR) return;
  await fs.ensureDir(ASSETS_MIRROR_DIR);
  await fs.writeFile(path.join(ASSETS_MIRROR_DIR, filename), data);
}

// Browse directories for the directory picker in the plugin UI
app.get('/browse', async (req, res) => {
  try {
    const requestedPath = req.query.path || process.cwd();
    const resolved = path.resolve(requestedPath);

    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({
      current: resolved,
      parent: path.dirname(resolved),
      dirs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set the output directory at runtime (called from plugin UI)
app.post('/set-output-dir', (req, res) => {
  const { outputDir } = req.body;
  if (!outputDir) {
    return res.status(400).json({ error: 'outputDir is required' });
  }
  OUTPUT_DIR = path.resolve(outputDir);
  console.log(`\n📁 Output directory set to: ${OUTPUT_DIR}`);
  res.json({ success: true, outputDir: OUTPUT_DIR });
});

// Endpoint to log errors from plugin
app.post('/log-error', (req, res) => {
  const { component, error, stack } = req.body;
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${component}: ${error}\n${stack || ''}\n`;
  console.error('❌ Plugin error:', logLine);
  fs.appendFileSync(path.join(OUTPUT_DIR, 'errors.log'), logLine);
  res.json({ logged: true });
});

// Generate top-level re-export files for all tracked subcomponents
// This creates e.g. figma-output/components/hero-section/component.tsx
// that re-exports from ./landing-page/container/hero-section/component
async function generateReExports() {
  const entries = Object.entries(subComponentRegistry);
  if (entries.length === 0) return 0;

  let count = 0;
  for (const [name, { componentName, fullPath }] of entries) {
    // Don't create re-export if it would collide with the parent component directory
    if (name === componentName) continue;

    const reexportDir = path.join(OUTPUT_DIR, 'components', name);
    const reexportFile = path.join(reexportDir, 'component.tsx');

    // Don't overwrite if the directory already has a real component (not a re-export)
    if (await fs.pathExists(reexportFile)) {
      const existing = await fs.readFile(reexportFile, 'utf-8');
      if (!existing.startsWith('// Auto-generated re-export')) continue;
    }

    const actualDir = path.join(OUTPUT_DIR, 'components', componentName, fullPath);
    const relativePath = path.relative(reexportDir, actualDir).replace(/\\/g, '/');

    await fs.ensureDir(reexportDir);
    await fs.writeFile(
      reexportFile,
      `// Auto-generated re-export by figma-plugin\nexport { default } from '${relativePath}/component';\n`
    );
    count++;
    console.log(`    ↳ Re-export: components/${name}/ → ${componentName}/${fullPath}/`);
  }

  return count;
}

// Save a single subcomponent (streaming approach)
app.post('/extract-subcomponent', async (req, res) => {
  try {
    const { componentName, subComponent: sub } = req.body;
    
    if (!componentName || !sub) {
      return res.status(400).json({ error: 'Missing componentName or subComponent' });
    }

    const subDir = path.join(OUTPUT_DIR, 'components', componentName, sub.path);
    await fs.ensureDir(subDir);
    await fs.ensureDir(path.join(subDir, 'assets'));
    
    // Save subcomponent TSX code
    await fs.writeFile(
      path.join(subDir, 'component.tsx'),
      sub.code
    );
    
    // Save subcomponent raw Figma JSON
    if (sub.rawFigma) {
      await fs.writeJson(
        path.join(subDir, 'figma-raw.json'),
        sub.rawFigma,
        { spaces: 2 }
      );
    }
    
    // Save subcomponent metadata
    await fs.writeJson(
      path.join(subDir, 'metadata.json'),
      {
        ...sub.metadata,
        title: sub.title,
        path: sub.path,
        hasCode: true,
        assetCount: (sub.assets || []).length
      },
      { spaces: 2 }
    );
    
    // Save subcomponent screenshot
    if (sub.screenshot) {
      const screenshotData = Array.isArray(sub.screenshot)
        ? Buffer.from(sub.screenshot)
        : Buffer.from(Object.values(sub.screenshot));
      await fs.writeFile(
        path.join(subDir, 'screenshot.png'),
        screenshotData
      );
    }

    // Save subcomponent assets
    for (const asset of sub.assets || []) {
      const filename = `${asset.name}.${asset.format}`;
      const assetData = Array.isArray(asset.data)
        ? Buffer.from(asset.data)
        : Buffer.from(Object.values(asset.data));
      await fs.writeFile(
        path.join(subDir, 'assets', filename),
        assetData
      );
      await mirrorAsset(filename, assetData);
    }

    // Register for top-level re-export generation (skip for section children)
    if (!sub.skipReExport) {
      const subName = sub.path.split('/').pop();
      if (subName && !subComponentRegistry[subName]) {
        subComponentRegistry[subName] = { componentName, fullPath: sub.path };
      }
    }

    console.log(`      ✓ Saved subcomponent: ${componentName}/${sub.path}`);
    res.json({ success: true, path: sub.path });

  } catch (error) {
    console.error('❌ Error saving subcomponent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save a single component (streaming approach)
app.post('/extract-single', async (req, res) => {
  try {
    const { component: comp } = req.body;
    
    if (!comp) {
      return res.status(400).json({ error: 'No component provided' });
    }

    console.log(`  → Processing: ${comp.title}`);

    const componentDir = path.join(OUTPUT_DIR, 'components', comp.name);
    await fs.ensureDir(componentDir);
    await fs.ensureDir(path.join(componentDir, 'assets'));

    // Save TSX code
    await fs.writeFile(
      path.join(componentDir, 'component.tsx'),
      comp.code
    );

    // Save raw Figma JSON
    if (comp.rawFigma) {
      await fs.writeJson(
        path.join(componentDir, 'figma-raw.json'),
        comp.rawFigma,
        { spaces: 2 }
      );
    }

    // Save screenshot
    if (comp.screenshot) {
      const screenshotData = Array.isArray(comp.screenshot)
        ? Buffer.from(comp.screenshot)
        : Buffer.from(Object.values(comp.screenshot));
      await fs.writeFile(
        path.join(componentDir, 'screenshot.png'),
        screenshotData
      );
    }

    // Save assets
    for (const asset of comp.assets || []) {
      const filename = `${asset.name}.${asset.format}`;
      const assetData = Array.isArray(asset.data)
        ? Buffer.from(asset.data)
        : Buffer.from(Object.values(asset.data));
      await fs.writeFile(
        path.join(componentDir, 'assets', filename),
        assetData
      );
      await mirrorAsset(filename, assetData);
    }

    // Save metadata
    await fs.writeJson(
      path.join(componentDir, 'metadata.json'),
      {
        ...comp.metadata,
        title: comp.title,
        hasCode: true,
        hasScreenshot: !!comp.screenshot,
        assetCount: (comp.assets || []).length,
        subComponentPaths: comp.subComponentPaths || []
      },
      { spaces: 2 }
    );

    console.log(`    ✓ Saved: ${comp.title}`);
    res.json({ success: true, name: comp.name });

  } catch (error) {
    console.error('❌ Error saving component:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync all assets from output component dirs to the assets mirror dir (if configured)
async function syncAssetsToMirror() {
  if (!ASSETS_MIRROR_DIR) return 0;
  await fs.ensureDir(ASSETS_MIRROR_DIR);
  const componentsDir = path.join(OUTPUT_DIR, 'components');
  if (!await fs.pathExists(componentsDir)) return 0;

  let copied = 0;
  async function walkDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (
        entry.name !== 'screenshot.png' &&
        /\.(png|svg|jpg|jpeg|webp)$/i.test(entry.name)
      ) {
        const destPath = path.join(ASSETS_MIRROR_DIR, entry.name);
        await fs.copyFile(fullPath, destPath);
        copied++;
      }
    }
  }

  await walkDir(componentsDir);
  return copied;
}

// Finalize extraction: generate top-level re-exports + sync assets
app.post('/finalize', async (req, res) => {
  try {
    console.log('\n  → Generating top-level re-exports...');
    const count = await generateReExports();
    console.log(`  ✓ Generated ${count} re-export(s)`);

    // Sync all assets to mirror dir (if configured)
    if (ASSETS_MIRROR_DIR) {
      console.log(`  → Syncing assets to ${ASSETS_MIRROR_DIR}...`);
      const synced = await syncAssetsToMirror();
      console.log(`  ✓ Synced ${synced} asset(s) to ${ASSETS_MIRROR_DIR}`);
    }

    // Reset registry for next extraction
    subComponentRegistry = {};

    res.json({ success: true, reExportCount: count });
  } catch (error) {
    console.error('❌ Error during finalization:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT, outputDir: OUTPUT_DIR });
});

app.listen(PORT, () => {
  console.log(`\nBQ Figma Extractor server running on http://localhost:${PORT}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  if (ASSETS_MIRROR_DIR) {
    console.log(`Assets mirror: ${ASSETS_MIRROR_DIR}`);
  }
  console.log(`\nUsage:`);
  console.log(`1. Keep this server running`);
  console.log(`2. Open the BQ Figma Extractor plugin in Figma`);
  console.log(`3. Set your output directory in the plugin`);
  console.log(`4. Select frames, click "Load from Selection", then "Extract Components"\n`);
});
