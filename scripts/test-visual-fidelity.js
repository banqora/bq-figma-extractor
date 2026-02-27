#!/usr/bin/env node
/**
 * Visual Fidelity Test Script
 *
 * Automates: trigger extraction → wait for completion → screenshot rendered TSX → compare to Figma screenshot.
 *
 * Prerequisites:
 *   npm install --save-dev playwright pixelmatch pngjs
 *   npx playwright install chromium
 *
 * Usage:
 *   # Run with a config file:
 *   node scripts/test-visual-fidelity.js --config test-config.json
 *
 *   # Run against already-extracted output (skip extraction):
 *   node scripts/test-visual-fidelity.js --skip-extract --output-dir ./output
 *
 *   # Run specific component path:
 *   node scripts/test-visual-fidelity.js --skip-extract --component contact-page/contact-page/page-container
 *
 * Config file format (test-config.json):
 *   {
 *     "components": [
 *       { "id": "1538:3250", "name": "contact-page", "title": "Contact page", "children": [...] }
 *     ],
 *     "outputDir": "./output",
 *     "decompose": true,
 *     "threshold": 0.15
 *   }
 */

const http = require('http');
const path = require('path');
const fs = require('fs-extra');

const SERVER_URL = 'http://localhost:3846';
const DEFAULT_THRESHOLD = 0.15; // 15% pixel diff threshold — generous for font/AA differences
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

// --- CLI Argument Parsing ---

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}

const configPath = getArg('--config');
const skipExtract = hasFlag('--skip-extract');
const singleComponent = getArg('--component');
const cliOutputDir = getArg('--output-dir');
const cliThreshold = getArg('--threshold');
const verbose = hasFlag('--verbose');

// --- Helpers ---

function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForExtraction() {
  const start = Date.now();
  process.stdout.write('  Waiting for extraction to complete');
  while (Date.now() - start < MAX_WAIT_MS) {
    const { body } = await httpRequest('GET', '/extraction-status');
    if (body.state === 'complete') {
      process.stdout.write(' done!\n');
      return body;
    }
    if (body.state === 'error') {
      process.stdout.write(' ERROR\n');
      throw new Error(`Extraction failed: ${body.error || body.message}`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Extraction timed out');
}

// Recursively find all component dirs that have both component.tsx and screenshot.png
async function findComponentDirs(dir, prefix = '') {
  const results = [];
  if (!await fs.pathExists(dir)) return results;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    const componentPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    const hasCode = await fs.pathExists(path.join(fullPath, 'component.tsx'));
    const hasScreenshot = await fs.pathExists(path.join(fullPath, 'screenshot.png'));

    if (hasCode && hasScreenshot) {
      results.push({ dir: fullPath, componentPath });
    }

    // Recurse into subdirs for subcomponents
    const nested = await findComponentDirs(fullPath, componentPath);
    results.push(...nested);
  }
  return results;
}

// --- Main ---

async function main() {
  console.log('\n=== BQ Figma Extractor — Visual Fidelity Test ===\n');

  // Load config
  let config = {};
  if (configPath) {
    config = await fs.readJson(path.resolve(configPath));
    console.log(`Loaded config from ${configPath}`);
  }

  const outputDir = cliOutputDir || config.outputDir || './output';
  const threshold = parseFloat(cliThreshold || config.threshold || DEFAULT_THRESHOLD);
  const resolvedOutputDir = path.resolve(outputDir);

  console.log(`Output dir: ${resolvedOutputDir}`);
  console.log(`Pixel diff threshold: ${(threshold * 100).toFixed(0)}%`);

  // Step 1: Trigger extraction (unless --skip-extract)
  if (!skipExtract) {
    if (!config.components || config.components.length === 0) {
      console.error('ERROR: No components in config. Provide --config with a components array, or use --skip-extract.');
      process.exit(1);
    }

    console.log(`\n[1/3] Triggering extraction of ${config.components.length} component(s)...`);

    // Check server is running
    try {
      await httpRequest('GET', '/health');
    } catch {
      console.error('ERROR: Server not running at ' + SERVER_URL + '. Start it with: npm run server');
      process.exit(1);
    }

    const triggerRes = await httpRequest('POST', '/trigger-extract', {
      components: config.components,
      outputDir: resolvedOutputDir,
      decompose: config.decompose !== undefined ? config.decompose : true,
      assetPathPrefix: config.assetPathPrefix || '/figma-assets',
    });

    if (triggerRes.status !== 200) {
      console.error('ERROR: Failed to trigger extraction:', triggerRes.body);
      process.exit(1);
    }
    console.log(`  ${triggerRes.body.message}`);
    console.log('  (Make sure the Figma plugin is open and the correct file is loaded)');

    await waitForExtraction();
    console.log('  Extraction complete!');
  } else {
    console.log('\n[1/3] Skipping extraction (--skip-extract)');
  }

  // Step 2: Find components and take screenshots
  console.log('\n[2/3] Screenshotting rendered components...');

  let componentDirs;
  if (singleComponent) {
    const dir = path.join(resolvedOutputDir, 'components', singleComponent);
    if (!await fs.pathExists(path.join(dir, 'component.tsx'))) {
      console.error(`ERROR: Component not found at ${dir}`);
      process.exit(1);
    }
    componentDirs = [{ dir, componentPath: singleComponent }];
  } else {
    componentDirs = await findComponentDirs(path.join(resolvedOutputDir, 'components'));
  }

  if (componentDirs.length === 0) {
    console.error('ERROR: No components found with both component.tsx and screenshot.png');
    process.exit(1);
  }

  console.log(`  Found ${componentDirs.length} component(s) to test`);

  // Lazy-load playwright and pixelmatch
  let chromium, PNG, pixelmatch;
  try {
    ({ chromium } = require('playwright'));
    ({ PNG } = require('pngjs'));
    // pixelmatch v7 is ESM-only, use dynamic import
    const pm = await import('pixelmatch');
    pixelmatch = pm.default || pm;
  } catch (e) {
    console.error('ERROR: Missing dependencies. Install them with:');
    console.error('  npm install --save-dev playwright pixelmatch pngjs');
    console.error('  npx playwright install chromium');
    console.error('  Detail:', e.message);
    process.exit(1);
  }

  // Composite a PNG with alpha onto a white background (in-place).
  // Figma exports with transparency; browser renders on white. This ensures parity.
  function compositeOntoWhite(png) {
    for (let i = 0; i < png.data.length; i += 4) {
      const a = png.data[i + 3] / 255;
      png.data[i]     = Math.round(png.data[i]     * a + 255 * (1 - a)); // R
      png.data[i + 1] = Math.round(png.data[i + 1] * a + 255 * (1 - a)); // G
      png.data[i + 2] = Math.round(png.data[i + 2] * a + 255 * (1 - a)); // B
      png.data[i + 3] = 255; // fully opaque
    }
    return png;
  }

  // Crop a PNG to the given dimensions (top-left origin)
  function cropPng(png, w, h) {
    const cropped = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = (y * png.width + x) * 4;
        const dstIdx = (y * w + x) * 4;
        cropped.data[dstIdx]     = png.data[srcIdx];
        cropped.data[dstIdx + 1] = png.data[srcIdx + 1];
        cropped.data[dstIdx + 2] = png.data[srcIdx + 2];
        cropped.data[dstIdx + 3] = png.data[srcIdx + 3];
      }
    }
    return cropped;
  }

  const browser = await chromium.launch();
  const resultsDir = path.join(resolvedOutputDir, 'test-results');
  await fs.ensureDir(resultsDir);

  const results = [];

  for (const { dir: compDir, componentPath } of componentDirs) {
    const safeName = componentPath.replace(/\//g, '--');
    console.log(`  Testing: ${componentPath}`);

    // Load the Figma reference screenshot and composite onto white
    const figmaScreenshotPath = path.join(compDir, 'screenshot.png');
    const figmaImgBuf = await fs.readFile(figmaScreenshotPath);
    const figmaPng = compositeOntoWhite(PNG.sync.read(figmaImgBuf));

    // Figma exports screenshots at 2x resolution.
    // Set viewport to CSS-pixel size (half the screenshot) and deviceScaleFactor: 2
    // so Playwright captures at 2x, matching the Figma reference exactly.
    const cssWidth = Math.ceil(figmaPng.width / 2);
    const cssHeight = Math.ceil(figmaPng.height / 2);

    // Use no-header mode to remove the viewer bar from the render
    const previewUrl = `${SERVER_URL}/view/preview/${componentPath}?no-header=1&dir=${encodeURIComponent(resolvedOutputDir)}`;
    const context = await browser.newContext({
      viewport: { width: cssWidth, height: cssHeight },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Disable the viewer's auto-scale so the component renders at its natural CSS size
    await page.evaluate(() => {
      const root = document.getElementById('preview-root');
      if (root) {
        root.style.transform = 'none';
        root.style.width = 'auto';
      }
    });

    // Wait for Tailwind + React to fully render
    await page.waitForTimeout(2000);

    // Screenshot the first child of preview-root (the actual component element)
    // to avoid capturing any surrounding whitespace from the wrapper div
    const renderPath = path.join(resultsDir, `${safeName}--render.png`);
    const componentEl = page.locator('#preview-root > *:first-child');
    const elExists = await componentEl.count();

    if (elExists > 0) {
      await componentEl.screenshot({ path: renderPath });
    } else {
      // Fallback to preview-root if component didn't render a child
      await page.locator('#preview-root').screenshot({ path: renderPath });
    }

    await context.close();

    // Load the render screenshot
    const renderBuf = await fs.readFile(renderPath);
    const renderPng = PNG.sync.read(renderBuf);

    // Pixelmatch requires same dimensions — crop to the smaller common area
    const width = Math.min(figmaPng.width, renderPng.width);
    const height = Math.min(figmaPng.height, renderPng.height);

    const figmaFinal = figmaPng.width !== width || figmaPng.height !== height
      ? cropPng(figmaPng, width, height)
      : figmaPng;
    const renderFinal = renderPng.width !== width || renderPng.height !== height
      ? cropPng(renderPng, width, height)
      : renderPng;

    // Compare
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(
      figmaFinal.data,
      renderFinal.data,
      diffPng.data,
      width,
      height,
      { threshold: 0.1 } // pixelmatch's internal per-pixel color threshold
    );

    const totalPixels = width * height;
    const diffRatio = diffPixels / totalPixels;
    const passed = diffRatio <= threshold;

    // Save diff image
    const diffPath = path.join(resultsDir, `${safeName}--diff.png`);
    await fs.writeFile(diffPath, PNG.sync.write(diffPng));

    results.push({
      componentPath,
      passed,
      diffRatio,
      diffPixels,
      totalPixels,
      figmaDimensions: { w: figmaPng.width, h: figmaPng.height },
      renderDimensions: { w: renderPng.width, h: renderPng.height },
      comparedDimensions: { w: width, h: height },
      diffPath,
      renderPath,
    });

    const icon = passed ? '✅' : '❌';
    console.log(`    ${icon} ${(diffRatio * 100).toFixed(1)}% diff (${diffPixels}/${totalPixels} pixels)`);
  }

  await browser.close();

  // Step 3: Report
  console.log('\n[3/3] Results Summary\n');
  console.log('─'.repeat(80));

  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${icon}  ${r.componentPath}  — ${(r.diffRatio * 100).toFixed(1)}% diff`);
    if (!r.passed && verbose) {
      console.log(`         Figma: ${r.figmaDimensions.w}x${r.figmaDimensions.h}  Render: ${r.renderDimensions.w}x${r.renderDimensions.h}`);
      console.log(`         Diff image: ${r.diffPath}`);
    }
  }

  console.log('─'.repeat(80));
  console.log(`\n  ${passCount} passed, ${failCount} failed out of ${results.length} component(s)`);
  console.log(`  Threshold: ${(threshold * 100).toFixed(0)}%`);
  console.log(`  Diff images saved to: ${resultsDir}\n`);

  // Write JSON results
  const jsonPath = path.join(resultsDir, 'results.json');
  await fs.writeJson(jsonPath, { threshold, results, summary: { passCount, failCount, total: results.length } }, { spaces: 2 });
  console.log(`  JSON results: ${jsonPath}\n`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  if (verbose) console.error(err);
  process.exit(1);
});
