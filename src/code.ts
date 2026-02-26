// Figma Plugin - BQ Figma Extractor
// Extracts components with full structure, code generation, and assets
// Supports hierarchical extraction for large components
//
// Build:      npm run build          (esbuild bundles src/ → code.js)
// Watch:      npm run build:watch    (rebuild on change)
// Typecheck:  npm run typecheck      (tsc --noEmit)

import { ComponentConfig } from './types';
import { toKebabCase } from './utils';
import { extractComponent } from './extraction';
import { setAssetPathPrefix } from './config';

// Show UI
figma.showUI(__html__, { width: 400, height: 600 });

// Handle messages from UI
figma.ui.onmessage = async (msg) => {
  // Load config from current selection
  if (msg.type === 'load-selection') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: 'selection-loaded',
        components: [],
        message: 'No components selected. Select frames/components in Figma first.'
      });
      return;
    }

    const components: ComponentConfig[] = [];
    for (const node of selection) {
      if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
        components.push({
          id: node.id,
          name: toKebabCase(node.name),
          title: node.name
        });
      } else if (node.type === 'SECTION') {
        // SECTION nodes act as a folder of screens/states
        // Extract each direct child frame as a child entry
        const sectionChildren: ComponentConfig[] = [];
        if ('children' in node && node.children) {
          for (const child of node.children) {
            if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'INSTANCE') {
              sectionChildren.push({
                id: child.id,
                name: toKebabCase(child.name),
                title: child.name
              });
            }
          }
        }
        components.push({
          id: node.id,
          name: toKebabCase(node.name),
          title: node.name,
          children: sectionChildren.length > 0 ? sectionChildren : undefined
        });
      }
    }

    figma.ui.postMessage({
      type: 'selection-loaded',
      components,
      message: `Found ${components.length} extractable components from selection`
    });
    return;
  }

  if (msg.type === 'extract') {
    const components: ComponentConfig[] = msg.components;
    const decompose: boolean = msg.decompose !== false; // default true

    try {
      let successCount = 0;

      // Flatten: components with children get expanded into individual extractions
      // Each child is extracted as a subcomponent under the parent's folder
      const flattenedComponents: Array<{ config: ComponentConfig; parentName?: string }> = [];
      for (const comp of components) {
        if (comp.children && comp.children.length > 0) {
          for (const child of comp.children) {
            flattenedComponents.push({ config: child, parentName: comp.name });
          }
        } else {
          flattenedComponents.push({ config: comp });
        }
      }

      figma.ui.postMessage({ type: 'status', message: `Extracting ${flattenedComponents.length} components...` });
      figma.ui.postMessage({ type: 'extraction-start', total: flattenedComponents.length });

      for (let i = 0; i < flattenedComponents.length; i++) {
        const { config: comp, parentName } = flattenedComponents[i];
        const displayName = parentName ? `${parentName}/${comp.title}` : comp.title;
        figma.ui.postMessage({
          type: 'progress',
          current: i + 1,
          total: flattenedComponents.length,
          message: `Extracting: ${displayName}`
        });

        // baseName is the full folder path: parentName/comp.name when nested under a section
        const baseName = parentName ? `${parentName}/${comp.name}` : undefined;
        const result = await extractComponent(comp, !decompose, baseName);
        if (result) {
          if (parentName) {
            // Stream as subcomponent under the parent folder
            // Include subComponentPaths so the viewer knows about nested subcomponents
            const metadata = { ...result.metadata };
            if (result.subComponentPaths && result.subComponentPaths.length > 0) {
              metadata.subComponentPaths = result.subComponentPaths;
            }
            figma.ui.postMessage({
              type: 'subcomponent-extracted',
              componentName: parentName,
              subComponent: {
                path: comp.name,
                title: comp.title,
                code: result.code,
                rawFigma: result.rawFigma,
                screenshot: result.screenshot,
                assets: result.assets,
                metadata,
                skipReExport: true
              }
            });
          } else {
            // Send as top-level component
            figma.ui.postMessage({
              type: 'component-extracted',
              component: result
            });
          }
          successCount++;
        }
      }

      // Signal completion (no payload)
      figma.ui.postMessage({
        type: 'extraction-complete',
        message: `✓ Extracted ${successCount}/${flattenedComponents.length} components`
      });

    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: `Extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  }

  if (msg.type === 'set-config') {
    if (msg.assetPathPrefix) {
      setAssetPathPrefix(msg.assetPathPrefix);
    }
  }

  if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};
