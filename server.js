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

// Parse CLI flags
function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

// Output directory — settable at runtime via the plugin UI.
// Use --output-dir to lock it to a fixed path (disables runtime changes from the plugin).
// Default: ./output relative to where the server is launched.
const OUTPUT_DIR_LOCKED = !!getCliArg('--output-dir');
let OUTPUT_DIR = getCliArg('--output-dir')
  ? path.resolve(getCliArg('--output-dir'))
  : path.resolve(process.cwd(), 'output');

// Optional: mirror assets to a secondary directory (e.g. public/figma-assets).
// Set via --assets-dir CLI flag. null = no mirroring.
const ASSETS_MIRROR_DIR = getCliArg('--assets-dir')
  ? path.resolve(getCliArg('--assets-dir'))
  : null;

app.use(cors());
// Large limit: Figma exports can include many base64-encoded image assets in a single request.
app.use(express.json({ limit: '500mb' }));

// Track subcomponent paths for re-export generation
// Maps subcomponent name (last path segment) -> { componentName, fullPath }
let subComponentRegistry = {};

// --- Automated extraction trigger (Approach B) ---
// Pending extraction request that the plugin UI will poll for
let pendingExtraction = null;
// Current extraction status for the test script to poll
let extractionStatus = { state: 'idle', message: '', components: [], startedAt: null, completedAt: null };

// Mirror an asset to the secondary assets directory (if configured)
async function mirrorAsset(filename, data) {
  if (!ASSETS_MIRROR_DIR) return;
  await fs.ensureDir(ASSETS_MIRROR_DIR);
  await fs.writeFile(path.join(ASSETS_MIRROR_DIR, filename), data);
}

// Walk up to the nearest existing directory
async function findExistingParent(p) {
  let current = path.resolve(p);
  while (current !== path.dirname(current)) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) return current;
    } catch {}
    current = path.dirname(current);
  }
  return current; // filesystem root
}

// Browse directories for the directory picker in the plugin UI
app.get('/browse', async (req, res) => {
  try {
    const requestedPath = req.query.path || process.cwd();
    const resolved = await findExistingParent(requestedPath);

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


// Set the output directory at runtime (called from plugin UI).
// Ignored when the server was started with --output-dir (locked mode).
app.post('/set-output-dir', (req, res) => {
  if (OUTPUT_DIR_LOCKED) {
    return res.json({ success: true, outputDir: OUTPUT_DIR, locked: true });
  }
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

// Resolve the output dir for viewer requests — uses ?dir= query param or falls back to OUTPUT_DIR
function resolveViewDir(req) {
  if (req.query.dir) return path.resolve(req.query.dir);
  return OUTPUT_DIR;
}

// Serve extracted assets at /figma-assets/ so component previews can load images.
// Searches all component asset dirs for the requested filename.
app.get('/figma-assets/:filename', async (req, res) => {
  try {
    const viewDir = resolveViewDir(req);
    const componentsDir = path.join(viewDir, 'components');
    if (!await fs.pathExists(componentsDir)) return res.status(404).send('Not found');

    // Walk component dirs to find the asset
    async function findAsset(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await findAsset(full);
          if (found) return found;
        } else if (entry.name === req.params.filename) {
          return full;
        }
      }
      return null;
    }

    const assetPath = await findAsset(componentsDir);
    if (assetPath) {
      res.sendFile(assetPath);
    } else {
      res.status(404).send('Asset not found');
    }
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Recursively resolve a component and all its imports into a single bundle.
// Returns { functions: string[], rootName: string } where functions are ordered
// leaves-first so each component is defined before it's referenced.
// expectedName: if provided, rename the function to match the parent's import alias.
// usedNames: tracks all function names across the entire bundle to avoid collisions.
async function bundleComponent(componentDir, visited, expectedName, usedNames) {
  visited = visited || new Set();
  usedNames = usedNames || new Set();
  const codePath = path.join(componentDir, 'component.tsx');

  if (!await fs.pathExists(codePath)) return { functions: [], rootName: null };
  if (visited.has(codePath)) return { functions: [], rootName: null };
  visited.add(codePath);

  const raw = await fs.readFile(codePath, 'utf-8');
  const lines = raw.split('\n');

  // Parse imports: import Foo from './bar/component'
  const imports = [];
  for (const line of lines) {
    const m = line.match(/^\s*import\s+(\w+)\s+from\s+['"](.+)['"]/);
    if (m) imports.push({ name: m[1], relPath: m[2] });
  }

  // Recursively bundle each imported subcomponent first, passing the import alias as expectedName.
  // Track renames so we can patch JSX references in this component's code.
  const renames = new Map(); // originalImportName -> actualBundledName
  const childFunctions = [];
  for (const imp of imports) {
    const resolvedDir = path.resolve(componentDir, path.dirname(imp.relPath));
    const child = await bundleComponent(resolvedDir, visited, imp.name, usedNames);
    if (child.functions.length > 0) {
      childFunctions.push(...child.functions);
    }
    if (child.rootName && child.rootName !== imp.name) {
      renames.set(imp.name, child.rootName);
    }
  }

  // Strip imports and comments-only preamble, extract function
  let code = lines.filter(l => !l.trim().startsWith('import ')).join('\n');

  // Remove 'export default' and extract the declared name
  const nameMatch = code.match(/export\s+default\s+function\s+(\w+)/);
  const declaredName = nameMatch ? nameMatch[1] : null;
  let compName = expectedName || declaredName;

  // Deduplicate: if this name is already used in the bundle, add a numeric suffix
  if (usedNames.has(compName)) {
    let suffix = 2;
    while (usedNames.has(compName + '_' + suffix)) suffix++;
    compName = compName + '_' + suffix;
  }
  usedNames.add(compName);

  code = code.replace(/export\s+default\s+function\s+\w+/, 'function ' + compName);

  // Patch JSX references for any children that were renamed due to collisions
  for (const [origName, newName] of renames) {
    // Replace <OrigName .../>, <OrigName>...</OrigName>, and <OrigName />
    code = code.replace(new RegExp('<' + origName + '(\\s|/|>)', 'g'), '<' + newName + '$1');
    code = code.replace(new RegExp('</' + origName + '>', 'g'), '</' + newName + '>');
  }

  return {
    functions: [...childFunctions, code],
    rootName: compName
  };
}

// Serve bundled component code for browser preview (recursively inlines all subcomponents)
app.get('/view/preview-code/:componentPath(*)', async (req, res) => {
  try {
    const viewDir = resolveViewDir(req);
    const componentPath = req.params.componentPath;
    const componentDir = path.join(viewDir, 'components', componentPath);

    if (!await fs.pathExists(path.join(componentDir, 'component.tsx'))) {
      return res.status(404).json({ error: 'component.tsx not found' });
    }

    const bundle = await bundleComponent(componentDir);
    const code = bundle.functions.join('\n\n');
    const compName = bundle.rootName || 'Component';

    res.json({ code, compName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Live preview of a component — renders React + Tailwind in the browser
app.get('/view/preview/:componentPath(*)', async (req, res) => {
  try {
    const viewDir = resolveViewDir(req);
    const componentPath = req.params.componentPath;
    const codePath = path.join(viewDir, 'components', componentPath, 'component.tsx');

    if (!await fs.pathExists(codePath)) {
      return res.status(404).send('component.tsx not found');
    }

    const dirParam = req.query.dir ? '?dir=' + encodeURIComponent(req.query.dir) : '';
    const dirQs = req.query.dir ? '&dir=' + encodeURIComponent(req.query.dir) : '';
    const noHeader = req.query['no-header'] === '1' || req.query['no-header'] === 'true';

    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Preview: ${escapeHtml(componentPath)}</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://unpkg.com/react@18/umd/react.development.js"><\/script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"><\/script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
<style>
  body { margin: 0; background: ${noHeader ? '#fff' : '#f0f0f0'}; }
  .preview-bar { background: #1a1a1a; color: #fff; padding: 8px 16px; font-family: -apple-system, sans-serif; font-size: 13px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 50; }
  .preview-bar a { color: #8bb4ff; text-decoration: none; }
  .preview-bar a:hover { text-decoration: underline; }
  #preview-root { background: #fff; transform-origin: top left; ${noHeader ? 'display: inline-block;' : ''} }
  .preview-error { padding: 24px; color: #d32f2f; font-family: monospace; font-size: 13px; white-space: pre-wrap; }
  .preview-loading { padding: 24px; color: #666; font-family: -apple-system, sans-serif; font-size: 14px; }
</style>
</head>
<body>
${noHeader ? '' : `<div class="preview-bar">
  <span>${escapeHtml(componentPath)}</span>
  <a href="/view${dirParam}">Back to all components</a>
</div>`}
<div id="preview-root"><div class="preview-loading">Loading preview...</div></div>
<script>
(async function() {
  var previewRoot = document.getElementById('preview-root');
  try {
    var dirQs = '${dirQs ? dirQs.slice(1) : ''}';
    var url = '/view/preview-code/${componentPath}' + (dirQs ? '?' + dirQs : '');
    var res = await fetch(url);
    var data = await res.json();
    if (data.error) throw new Error(data.error);

    // Compile bundled JSX (all subcomponents + root) to JS
    var jsxCode = data.code + '\\nwindow.__PreviewComponent = ' + data.compName + ';';
    var compiled = Babel.transform(jsxCode, { presets: ['react'] }).code;

    // Execute
    var script = document.createElement('script');
    script.textContent = compiled;
    document.body.appendChild(script);

    // Render
    var Component = window.__PreviewComponent;
    if (!Component) throw new Error('Component not found after compilation');
    var root = ReactDOM.createRoot(previewRoot);
    root.render(React.createElement(Component));

    // Scale to fit viewport
    requestAnimationFrame(function() {
      setTimeout(function() {
        var content = previewRoot.firstElementChild;
        if (content) {
          var contentWidth = content.offsetWidth || content.scrollWidth;
          var viewportWidth = window.innerWidth;
          if (contentWidth > viewportWidth) {
            var scale = viewportWidth / contentWidth;
            previewRoot.style.transform = 'scale(' + scale + ')';
            previewRoot.style.width = contentWidth + 'px';
          }
        }
      }, 100);
    });
  } catch (err) {
    previewRoot.innerHTML = '<div class="preview-error">Preview error: ' + err.message + '</div>';
    console.error('Preview error:', err);
  }
})();
<\/script>
</body>
</html>`);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// Serve screenshot images for the viewer
app.get('/view/screenshot/:componentPath(*)', async (req, res) => {
  try {
    const viewDir = resolveViewDir(req);
    const screenshotPath = path.join(viewDir, 'components', req.params.componentPath, 'screenshot.png');
    if (await fs.pathExists(screenshotPath)) {
      res.type('image/png').sendFile(screenshotPath);
    } else {
      res.status(404).send('No screenshot');
    }
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Serve raw component.tsx content as JSON
app.get('/view/code/:componentPath(*)', async (req, res) => {
  try {
    const viewDir = resolveViewDir(req);
    const codePath = path.join(viewDir, 'components', req.params.componentPath, 'component.tsx');
    if (await fs.pathExists(codePath)) {
      const code = await fs.readFile(codePath, 'utf-8');
      res.json({ code });
    } else {
      res.status(404).json({ error: 'No component.tsx found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Scan a components/ directory and return component descriptors.
// namePrefix is the path prefix relative to the root components/ dir, used when
// descending into group folders so that URLs resolve correctly via the existing
// endpoints (which all do viewDir + '/components/' + name).
// displayPrefix is prepended to titles so the UI shows which group a component is in.
// If a subdirectory doesn't contain component.tsx it's treated as a group folder
// and its children are scanned one level deeper.
async function scanComponentsDir(componentsDir, namePrefix = '', displayPrefix = '') {
  const components = [];
  if (!await fs.pathExists(componentsDir)) return components;

  const entries = await fs.readdir(componentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const entryDir = path.join(componentsDir, dirName);
    const codePath = path.join(entryDir, 'component.tsx');

    if (!await fs.pathExists(codePath)) {
      // No component.tsx — treat as a group folder and descend one level
      const nested = await scanComponentsDir(entryDir, namePrefix + dirName + '/', displayPrefix + dirName + '/');
      components.push(...nested);
      continue;
    }

    // name includes the path prefix so endpoints resolve to the correct nested dir
    const name = namePrefix + dirName;
    const metaPath = path.join(entryDir, 'metadata.json');
    const screenshotPath = path.join(entryDir, 'screenshot.png');

    let title = dirName;
    let meta = {};
    if (await fs.pathExists(metaPath)) {
      meta = await fs.readJson(metaPath);
      title = meta.title || dirName;
    }

    const hasCode = true;
    const hasScreenshot = await fs.pathExists(screenshotPath);

    // Find subcomponents
    const subComponents = [];
    if (meta.subComponentPaths && meta.subComponentPaths.length > 0) {
      for (const subPath of meta.subComponentPaths) {
        const subCodePath = path.join(entryDir, subPath, 'component.tsx');
        const subScreenshotPath = path.join(entryDir, subPath, 'screenshot.png');
        subComponents.push({
          path: subPath,
          name: subPath.split('/').pop(),
          hasCode: await fs.pathExists(subCodePath),
          hasScreenshot: await fs.pathExists(subScreenshotPath),
        });
      }
    }

    if (displayPrefix) {
      title = displayPrefix + title;
    }
    components.push({ name, title, meta, hasCode, hasScreenshot, subComponents, group: displayPrefix || null });
  }
  return components;
}

// Browser-based viewer for extracted components
app.get('/view', async (req, res) => {
  try {
    // If ?dir= is provided, update OUTPUT_DIR so plugin and viewer stay in sync
    if (req.query.dir) {
      OUTPUT_DIR = path.resolve(req.query.dir);
    }
    const viewDir = OUTPUT_DIR;
    const componentsDir = path.join(viewDir, 'components');
    let components = await scanComponentsDir(componentsDir);

    // If the root has no components, look one level down for subdirs that
    // contain their own components/ folder (e.g. viewDir/section-a/components/).
    if (components.length === 0 && await fs.pathExists(viewDir)) {
      const topEntries = await fs.readdir(viewDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (!entry.isDirectory() || entry.name === 'components') continue;
        const subComponentsDir = path.join(viewDir, entry.name, 'components');
        const subComponents = await scanComponentsDir(subComponentsDir, '', entry.name + '/');
        components.push(...subComponents);
      }
    }

    components.sort((a, b) => a.name.localeCompare(b.name));

    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>BQ Figma Extractor — Output Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #1a1a1a; }
  .header { background: #fff; border-bottom: 1px solid #e0e0e0; padding: 20px 32px; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header p { font-size: 13px; color: #666; margin-top: 4px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 32px; }
  .empty { text-align: center; padding: 60px 20px; color: #999; }
  .component-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .card-header { padding: 16px 20px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center; }
  .card-header h2 { font-size: 15px; font-weight: 600; }
  .card-header .meta { font-size: 11px; color: #888; }
  .card-body { display: flex; gap: 0; }
  .screenshot-col { flex: 0 0 300px; border-right: 1px solid #f0f0f0; padding: 16px; background: #fafafa; display: flex; align-items: flex-start; justify-content: center; }
  .screenshot-col img { max-width: 100%; max-height: 200px; object-fit: contain; border-radius: 4px; border: 1px solid #eee; }
  .screenshot-col { position: relative; }
  .screenshot-col img { cursor:pointer; }
  .screenshot-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:200; overflow:auto; cursor:grab; }
  .screenshot-overlay.dragging { cursor:grabbing; }
  .screenshot-overlay.visible { display:block; }
  .screenshot-overlay img { display:block; margin:20px auto; max-width:90%; cursor:grab; user-select:none; -webkit-user-drag:none; transform-origin:center top; }
  .screenshot-overlay.dragging img { cursor:grabbing; }
  .ss-toolbar { position:fixed; top:12px; right:16px; display:flex; gap:6px; z-index:201; }
  .ss-toolbar button { background:rgba(255,255,255,0.15); color:#fff; border:none; border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; }
  .ss-toolbar button:hover { background:rgba(255,255,255,0.3); }
  .ss-toolbar .ss-zoom-level { color:rgba(255,255,255,0.6); font-size:12px; padding:6px 4px; }
  .code-col { flex: 1; min-width: 0; position: relative; }
  .code-col pre { margin: 0; padding: 16px; font-size: 12px; line-height: 1.5; font-family: 'SF Mono', Monaco, 'Courier New', monospace; overflow-x: auto; max-height: 500px; overflow-y: auto; white-space: pre; background: #fff; }
  .code-col .loading { padding: 16px; color: #999; font-size: 12px; }
  .copy-btn { position: absolute; top: 8px; right: 8px; background: #f0f0f0; border: 1px solid #ddd; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; z-index: 1; }
  .copy-btn:hover { background: #e0e0e0; }
  .copy-btn.copied { background: #c8e6c9; border-color: #a5d6a7; }
  .sub-list { padding: 12px 20px; border-top: 1px solid #f0f0f0; background: #fafafa; }
  .sub-list summary { font-size: 12px; font-weight: 500; cursor: pointer; color: #555; }
  .sub-item { margin-top: 12px; border: 1px solid #e8e8e8; border-radius: 6px; overflow: hidden; background: #fff; }
  .sub-item .card-header { padding: 10px 16px; }
  .sub-item .card-header h3 { font-size: 13px; font-weight: 500; }
  .no-screenshot { display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 12px; min-height: 100px; }
  .dir-bar { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
  .dir-bar input { flex: 1; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; }
  .dir-bar button { padding: 6px 14px; border: 1px solid #ddd; border-radius: 4px; background: #f0f0f0; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .dir-bar button:hover { background: #e0e0e0; }
  .dir-bar button.go { background: #18A0FB; color: #fff; border-color: #18A0FB; }
  .dir-bar button.go:hover { background: #1585CC; }
  .search-bar { margin-top: 12px; }
  .search-bar input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; outline: none; }
  .search-bar input:focus { border-color: #18A0FB; box-shadow: 0 0 0 2px rgba(24,160,251,0.15); }
  .search-bar .search-count { font-size: 11px; color: #888; margin-top: 4px; display: none; }
  .dir-modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:100; align-items:center; justify-content:center; }
  .dir-modal-overlay.visible { display:flex; }
  .dir-modal { background:#fff; border-radius:8px; width:480px; max-height:500px; display:flex; flex-direction:column; box-shadow:0 8px 32px rgba(0,0,0,0.2); }
  .dir-modal-header { padding:14px 18px; border-bottom:1px solid #eee; font-weight:600; font-size:14px; display:flex; justify-content:space-between; align-items:center; }
  .dir-modal-path { padding:8px 18px; background:#f5f5f5; font-family:'SF Mono',Monaco,monospace; font-size:12px; color:#555; border-bottom:1px solid #eee; word-break:break-all; }
  .dir-modal-body { flex:1; overflow-y:auto; min-height:200px; }
  .dir-modal-item { padding:8px 18px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:8px; border-bottom:1px solid #f5f5f5; }
  .dir-modal-item:hover { background:#e3f2fd; }
  .dir-modal-item.parent { color:#888; font-style:italic; }
  .dir-modal-footer { padding:10px 18px; border-top:1px solid #eee; display:flex; gap:8px; justify-content:flex-end; }
  .dir-modal-footer button { padding:6px 18px; }
</style>
</head>
<body>
<div class="header">
  <h1>BQ Figma Extractor</h1>
  <div class="dir-bar">
    <input id="dirInput" type="text" value="${escapeHtml(viewDir)}" placeholder="Output directory path" />
    <button onclick="openBrowser()">Browse</button>
    <button class="go" onclick="goToDir()">Load</button>
  </div>
  <p style="margin-top:8px; font-size:13px; color:#666;">${components.length} component${components.length !== 1 ? 's' : ''} extracted</p>
  <div class="search-bar">
    <input id="searchInput" type="text" placeholder="Search components..." />
    <div id="searchCount" class="search-count"></div>
  </div>
</div>
<div id="browseModal" class="dir-modal-overlay">
  <div class="dir-modal">
    <div class="dir-modal-header"><span>Choose Directory</span><button onclick="closeBrowser()" style="border:none;background:none;cursor:pointer;font-size:18px;color:#999;">&times;</button></div>
    <div id="bmPath" class="dir-modal-path"></div>
    <div id="bmBody" class="dir-modal-body"></div>
    <div class="dir-modal-footer">
      <button onclick="closeBrowser()">Cancel</button>
      <button class="go" onclick="selectDir()">Select</button>
    </div>
  </div>
</div>
<div class="container">
${components.length === 0 ? '<div class="empty"><p>No components extracted yet.</p><p style="margin-top:8px">Run the plugin in Figma to extract components.</p></div>' :
components.map(c => {
  // c.name includes group path prefix (e.g. "landing-page/hero") so URLs resolve correctly
  const safeId = c.name.replace(/\//g, '--');
  return `
  <div class="component-card" data-search="${escapeHtml((c.title + ' ' + c.name + ' ' + (c.group || '') + ' ' + c.subComponents.map(s => s.name + ' ' + s.path).join(' ')).toLowerCase())}">
    <div class="card-header">
      <h2>${escapeHtml(c.title)}</h2>
      <span class="meta">
        ${c.name}${c.meta.assetCount ? ' — ' + c.meta.assetCount + ' asset(s)' : ''}
        ${c.hasCode ? ` | <a href="/view/preview/${c.name}?dir=${encodeURIComponent(viewDir)}" target="_blank" style="color:#18A0FB;text-decoration:none;">Preview</a>` : ''}
      </span>
    </div>
    <div class="card-body">
      <div class="screenshot-col">
        ${c.hasScreenshot ? `<img src="/view/screenshot/${c.name}?dir=${encodeURIComponent(viewDir)}" alt="${escapeHtml(c.title)}" loading="lazy" onclick="popScreenshot(this.src)" />` : '<div class="no-screenshot">No screenshot</div>'}
      </div>
      <div class="code-col" id="code-${safeId}">
        <button class="copy-btn" onclick="copyCode('${safeId}')">Copy</button>
        <div class="loading">Loading code...</div>
      </div>
    </div>
    ${c.subComponents.length > 0 ? `
    <div class="sub-list">
      <details>
        <summary>${c.subComponents.length} subcomponent${c.subComponents.length !== 1 ? 's' : ''}</summary>
        ${c.subComponents.map(s => `
        <div class="sub-item" data-search="${escapeHtml((s.name + ' ' + s.path).toLowerCase())}">
          <div class="card-header">
            <h3>${escapeHtml(s.name)}</h3>
            <span class="meta">${s.path}${s.hasCode ? ` | <a href="/view/preview/${c.name}/${s.path}?dir=${encodeURIComponent(viewDir)}" target="_blank" style="color:#18A0FB;text-decoration:none;">Preview</a>` : ''}</span>
          </div>
          <div class="card-body">
            <div class="screenshot-col">
              ${s.hasScreenshot ? `<img src="/view/screenshot/${c.name}/${s.path}?dir=${encodeURIComponent(viewDir)}" alt="${escapeHtml(s.name)}" loading="lazy" onclick="popScreenshot(this.src)" />` : '<div class="no-screenshot">No screenshot</div>'}
            </div>
            <div class="code-col" id="code-${safeId}--${s.path.replace(/\//g, '--')}">
              <button class="copy-btn" onclick="copyCode('${safeId}--${s.path.replace(/\//g, '--')}')">Copy</button>
              <div class="loading">Loading code...</div>
            </div>
          </div>
        </div>
        `).join('')}
      </details>
    </div>` : ''}
  </div>
`}).join('')}
</div>
<div id="ssOverlay" class="screenshot-overlay"><div class="ss-toolbar"><button onclick="ssZoom(-1)">−</button><span class="ss-zoom-level" id="ssZoomLevel">100%</span><button onclick="ssZoom(1)">+</button><button onclick="ssResetZoom()">Fit</button><button onclick="closeSsOverlay()">&times;</button></div><img id="ssOverlayImg" src="" /></div>
<script>
const codeCache = {};
const viewDir = ${JSON.stringify(viewDir)};

var ssScale = 1;
function popScreenshot(src) {
  var overlay = document.getElementById('ssOverlay');
  var img = document.getElementById('ssOverlayImg');
  img.src = src;
  ssScale = 1;
  img.style.transform = '';
  img.style.maxWidth = '90%';
  document.getElementById('ssZoomLevel').textContent = '100%';
  overlay.scrollTop = 0;
  overlay.scrollLeft = 0;
  overlay.classList.add('visible');
}
function closeSsOverlay() { document.getElementById('ssOverlay').classList.remove('visible'); }
function ssApplyZoom() {
  var img = document.getElementById('ssOverlayImg');
  if (ssScale <= 1) {
    img.style.maxWidth = '90%';
    img.style.transform = ssScale < 1 ? 'scale(' + ssScale + ')' : '';
  } else {
    img.style.maxWidth = 'none';
    img.style.transform = 'scale(' + ssScale + ')';
  }
  document.getElementById('ssZoomLevel').textContent = Math.round(ssScale * 100) + '%';
}
function ssZoom(dir) {
  var steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  var idx = steps.indexOf(ssScale);
  if (idx < 0) { idx = steps.reduce(function(best, v, i) { return Math.abs(v - ssScale) < Math.abs(steps[best] - ssScale) ? i : best; }, 0); }
  idx = Math.max(0, Math.min(steps.length - 1, idx + dir));
  ssScale = steps[idx];
  ssApplyZoom();
}
function ssResetZoom() { ssScale = 1; ssApplyZoom(); }
// Drag to pan + scroll wheel zoom
(function() {
  var ol = document.getElementById('ssOverlay');
  var dragging = false, startX, startY, scrollX, scrollY;
  ol.addEventListener('mousedown', function(e) {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SPAN') return;
    dragging = true;
    ol.classList.add('dragging');
    startX = e.clientX; startY = e.clientY;
    scrollX = ol.scrollLeft; scrollY = ol.scrollTop;
    e.preventDefault();
  });
  window.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    ol.scrollLeft = scrollX - (e.clientX - startX);
    ol.scrollTop = scrollY - (e.clientY - startY);
  });
  window.addEventListener('mouseup', function() { dragging = false; ol.classList.remove('dragging'); });
  ol.addEventListener('wheel', function(e) {
    e.preventDefault();
    ssZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeSsOverlay();
  });
})();

function dirParam() {
  return 'dir=' + encodeURIComponent(viewDir);
}

async function loadCode(componentPath, elId) {
  const el = document.getElementById('code-' + elId);
  if (!el || codeCache[elId]) return;
  try {
    const res = await fetch('/view/code/' + componentPath + '?' + dirParam());
    const data = await res.json();
    codeCache[elId] = data.code;
    el.querySelector('.loading').outerHTML = '<pre>' + escapeHtml(data.code) + '</pre>';
  } catch (e) {
    el.querySelector('.loading').textContent = 'Failed to load code';
  }
}

function copyCode(elId) {
  const code = codeCache[elId];
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('code-' + elId).querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function goToDir() {
  const dir = document.getElementById('dirInput').value.trim();
  if (dir) window.location.href = '/view?dir=' + encodeURIComponent(dir);
}

// Directory browser
let bmCurrent = '';
async function browseTo(p) {
  try {
    const res = await fetch('/browse?path=' + encodeURIComponent(p));
    const data = await res.json();
    if (data.error) { document.getElementById('bmBody').textContent = data.error; return; }
    bmCurrent = data.current;
    document.getElementById('bmPath').textContent = data.current;
    const body = document.getElementById('bmBody');
    body.innerHTML = '';
    if (data.parent && data.parent !== data.current) {
      const el = document.createElement('div');
      el.className = 'dir-modal-item parent';
      el.textContent = '.. (parent)';
      el.onclick = () => browseTo(data.parent);
      body.appendChild(el);
    }
    for (const name of data.dirs) {
      const el = document.createElement('div');
      el.className = 'dir-modal-item';
      el.innerHTML = '<span style="opacity:0.5">&#128193;</span> ' + name;
      el.onclick = () => browseTo(data.current + '/' + name);
      body.appendChild(el);
    }
    if (data.dirs.length === 0) {
      const el = document.createElement('div');
      el.style.cssText = 'padding:16px;color:#999;text-align:center;font-size:12px;';
      el.textContent = 'No subdirectories';
      body.appendChild(el);
    }
  } catch (e) {
    document.getElementById('bmBody').textContent = 'Failed to browse: ' + e.message;
  }
}
function openBrowser() {
  document.getElementById('browseModal').classList.add('visible');
  browseTo(document.getElementById('dirInput').value.trim() || '.');
}
function closeBrowser() { document.getElementById('browseModal').classList.remove('visible'); }
function selectDir() {
  document.getElementById('dirInput').value = bmCurrent;
  closeBrowser();
  goToDir();
}

document.getElementById('dirInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') goToDir(); });

// Search / filter components and subcomponents with relevance sorting
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const container = document.querySelector('.container');

function scoreText(text, query) {
  if (!text.includes(query)) return -1;
  var words = text.split(/[\\s\\/]+/);
  var best = 3;
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w === query) { best = 0; break; }
    else if (w.startsWith(query)) { best = Math.min(best, 1); }
    else if (w.includes(query)) { best = Math.min(best, 2); }
  }
  return best + (text.length / 10000);
}

searchInput.addEventListener('input', function() {
  var query = this.value.toLowerCase().trim();
  var cards = Array.from(document.querySelectorAll('.component-card'));
  if (!query) {
    cards.forEach(function(card) {
      card.style.display = '';
      // Reset sub-items visibility and close details
      card.querySelectorAll('.sub-item').forEach(function(si) { si.style.display = ''; });
      var det = card.querySelector('details');
      if (det) det.removeAttribute('open');
    });
    searchCount.style.display = 'none';
    cards.sort(function(a, b) { return a.dataset.search.localeCompare(b.dataset.search); });
    cards.forEach(function(card) { container.appendChild(card); });
    return;
  }

  var scored = cards.map(function(card) {
    var cardScore = scoreText(card.dataset.search, query);
    // Filter sub-items individually
    var subItems = card.querySelectorAll('.sub-item');
    var hasMatchingSub = false;
    var bestSubScore = Infinity;
    subItems.forEach(function(si) {
      var subScore = scoreText(si.dataset.search || '', query);
      if (subScore >= 0) {
        si.style.display = '';
        hasMatchingSub = true;
        bestSubScore = Math.min(bestSubScore, subScore);
      } else {
        si.style.display = 'none';
      }
    });
    // Auto-open details if a sub-item matches
    var det = card.querySelector('details');
    if (det) {
      if (hasMatchingSub) { det.setAttribute('open', ''); }
      else { det.removeAttribute('open'); }
    }
    // Card is visible if the card itself or any sub-item matches
    var cardTitleScore = scoreText((card.querySelector('h2') || {}).textContent.toLowerCase() || '', query);
    if (cardScore < 0 && !hasMatchingSub) return { card: card, score: -1 };
    // Use best score among: card title, card full text, best sub-item
    var finalScore = Math.min(
      cardTitleScore >= 0 ? cardTitleScore : Infinity,
      cardScore >= 0 ? cardScore : Infinity,
      hasMatchingSub ? bestSubScore : Infinity
    );
    return { card: card, score: finalScore };
  });

  scored.sort(function(a, b) { return a.score - b.score; });
  var visible = 0;
  scored.forEach(function(item) {
    if (item.score < 0) {
      item.card.style.display = 'none';
    } else {
      item.card.style.display = '';
      visible++;
    }
    container.appendChild(item.card);
  });
  searchCount.style.display = 'block';
  searchCount.textContent = visible + ' of ' + cards.length + ' component' + (cards.length !== 1 ? 's' : '');
});

// Load code for all visible components
${components.map(c => {
  const safeId = c.name.replace(/\//g, '--');
  const loads = [`loadCode('${c.name}', '${safeId}');`];
  for (const s of c.subComponents) {
    loads.push(`loadCode('${c.name}/${s.path}', '${safeId}--${s.path.replace(/\//g, '--')}');`);
  }
  return loads.join('\n');
}).join('\n')}
</script>
</body>
</html>`);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Automated extraction trigger endpoints ---

// POST /trigger-extract — called by test scripts to queue an extraction.
// The plugin UI polls /pending-extract and picks this up.
app.post('/trigger-extract', (req, res) => {
  const { components, outputDir, decompose = true, assetPathPrefix = '/figma-assets' } = req.body;
  if (!components || !Array.isArray(components) || components.length === 0) {
    return res.status(400).json({ error: 'components array is required' });
  }

  // Optionally set output dir
  if (outputDir && !OUTPUT_DIR_LOCKED) {
    OUTPUT_DIR = path.resolve(outputDir);
    console.log(`\n📁 Output directory set to: ${OUTPUT_DIR} (via trigger-extract)`);
  }

  pendingExtraction = { components, decompose, assetPathPrefix, queuedAt: Date.now() };
  extractionStatus = {
    state: 'pending',
    message: 'Extraction queued, waiting for plugin to pick up...',
    components: components.map(c => c.name || c.id),
    startedAt: null,
    completedAt: null
  };

  console.log(`\n🤖 Extraction triggered via API for ${components.length} component(s)`);
  res.json({ success: true, message: `Queued ${components.length} component(s) for extraction` });
});

// GET /pending-extract — polled by the plugin UI to check for pending work
app.get('/pending-extract', (req, res) => {
  if (pendingExtraction) {
    const extraction = pendingExtraction;
    pendingExtraction = null; // consume it
    extractionStatus.state = 'extracting';
    extractionStatus.message = 'Plugin picked up extraction request';
    extractionStatus.startedAt = Date.now();
    console.log('  → Plugin picked up pending extraction');
    res.json({ pending: true, ...extraction });
  } else {
    res.json({ pending: false });
  }
});

// POST /extraction-status — called by the plugin UI to report progress/completion
app.post('/extraction-status', (req, res) => {
  const { state, message, error } = req.body;
  if (state) extractionStatus.state = state;
  if (message) extractionStatus.message = message;
  if (error) extractionStatus.error = error;
  if (state === 'complete' || state === 'error') {
    extractionStatus.completedAt = Date.now();
  }
  res.json({ success: true });
});

// GET /extraction-status — polled by test scripts to wait for completion
app.get('/extraction-status', (req, res) => {
  res.json(extractionStatus);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT, outputDir: OUTPUT_DIR, outputDirLocked: OUTPUT_DIR_LOCKED });
});

// Bind to localhost only — this server exposes filesystem access and should never
// be reachable from the network. See README for details.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nBQ Figma Extractor server running on http://localhost:${PORT}`);
  console.log(`Output directory: ${OUTPUT_DIR}${OUTPUT_DIR_LOCKED ? ' (locked via --output-dir)' : ''}`);
  if (ASSETS_MIRROR_DIR) {
    console.log(`Assets mirror: ${ASSETS_MIRROR_DIR}`);
  }
  console.log(`\nUsage:`);
  console.log(`1. Keep this server running`);
  console.log(`2. Open the BQ Figma Extractor plugin in Figma`);
  console.log(`3. Set your output directory in the plugin`);
  console.log(`4. Select frames, click "Load from Selection", then "Extract Components"\n`);
});
