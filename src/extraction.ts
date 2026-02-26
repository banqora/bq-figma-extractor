import { ComponentConfig, ExtractedComponent, SignificantChild } from './types';
import { log, rgbToHex, safeValue, toKebabCase } from './utils';
import { findSignificantChildren } from './subcomponents';
import { isPlainImageFill, getTextSegments } from './styles';
import { generateReactCode, generateMainComponentCodeFromChildren, generateSubComponentCodeFlat } from './codegen';

// Extract subcomponents and stream each one to server immediately
export async function extractAndStreamSubComponents(
  node: SceneNode,
  basePath: string,
  componentName: string
): Promise<string[]> {
  const extractedPaths: string[] = [];

  async function processNode(n: SceneNode, currentPath: string) {
    // Find significant children at this level
    const significantChildren = findSignificantChildren(n, '', 1);

    for (const child of significantChildren) {
      const childKebab = toKebabCase(child.uniqueName);
      const childPath = currentPath ? `${currentPath}/${childKebab}` : childKebab;

      // Check for nested significant children
      const nestedSignificant = findSignificantChildren(child.node, '', 1);

      // Generate code
      let code: string;
      if (nestedSignificant.length > 0) {
        // Has children - generate imports; use uniqueName so function name matches the import alias
        code = generateSubComponentCodeFlat(child.node, nestedSignificant, child.uniqueName);
      } else {
        code = generateReactCode(child.node, true, child.uniqueName);
      }

      // Extract assets (excluding nested children)
      const excludeNodes = nestedSignificant.map(ns => ns.node);
      const assets = await extractRootAssets(child.node, excludeNodes);
      const rawFigma = extractRawFigma(child.node);
      const metadata = extractMetadata(child.node);

      // Export screenshot for this subcomponent
      let screenshot: Uint8Array | null = null;
      if ('exportAsync' in child.node && typeof child.node.exportAsync === 'function') {
        try {
          screenshot = await child.node.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 2 }
          });
        } catch (err) {
          // Skip screenshot on error
        }
      }

      // Stream this subcomponent to server immediately
      figma.ui.postMessage({
        type: 'subcomponent-extracted',
        componentName: componentName,
        subComponent: {
          id: child.node.id,
          name: childKebab,
          title: child.uniqueName,
          path: childPath,
          code: code,
          rawFigma: rawFigma,
          metadata: metadata,
          assets: assets,
          screenshot: screenshot
        }
      });

      extractedPaths.push(childPath);

      // Recursively process nested children
      if (nestedSignificant.length > 0) {
        await processNode(child.node, childPath);
      }
    }
  }

  await processNode(node, basePath);
  return extractedPaths;
}

export async function extractComponent(config: ComponentConfig, flat = false, baseName?: string): Promise<ExtractedComponent | null> {
  log('info', `Starting extraction`, { id: config.id, name: config.name, title: config.title });

  try {
    // Find the node by ID
    const node = figma.getNodeById(config.id);

    if (!node) {
      // Debug: Try to find what pages and top-level frames exist
      const pages = figma.root.children;
      const pageInfo = pages.map(p => {
        const children = p.children || [];
        return {
          id: p.id,
          name: p.name,
          childCount: children.length,
          topFrames: children.slice(0, 5).map(c => ({ id: c.id, name: c.name, type: c.type }))
        };
      });

      log('error', `Component not found by ID`, {
        searchedId: config.id,
        name: config.name,
        title: config.title,
        currentPage: figma.currentPage.name,
        currentPageId: figma.currentPage.id,
        allPages: pageInfo,
        hint: 'Node ID not found. Check: 1) Is it on a different page? 2) Was the component deleted? 3) Is the ID format correct (should be like "123:456")?'
      });

      // Try to find by name as fallback
      const foundByName = figma.currentPage.findOne(n => n.name.toLowerCase() === config.title.toLowerCase());
      if (foundByName) {
        log('info', `Found component by name instead!`, {
          searchedId: config.id,
          foundId: foundByName.id,
          foundName: foundByName.name,
          foundType: foundByName.type,
          suggestion: `Update config to use ID: "${foundByName.id}"`
        });
      }

      return null;
    }

    log('info', `Found node`, { id: node.id, name: node.name, type: node.type });

    if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') {
      log('warning', `Node is not extractable type`, {
        id: node.id,
        name: node.name,
        actualType: node.type,
        expectedTypes: ['FRAME', 'COMPONENT', 'INSTANCE']
      });
      return null;
    }

    let significantChildren: SignificantChild[] = [];
    let extractedPaths: string[] = [];
    let code: string;

    if (flat) {
      // Flat extraction: no hierarchical sub-splitting, generate one component
      code = generateReactCode(node, false);
    } else {
      // Detect significant subcomponents for hierarchical extraction
      log('info', `Finding significant children`, { parentId: node.id, parentName: node.name });
      significantChildren = findSignificantChildren(node, '', 1);
      log('info', `Found ${significantChildren.length} significant children`, {
        children: significantChildren.map(c => ({ id: c.node.id, name: c.node.name, path: c.path }))
      });

      // Stream subcomponents to server as they're extracted (avoids memory buildup)
      extractedPaths = await extractAndStreamSubComponents(node, '', baseName || config.name);
      log('info', `Streamed ${extractedPaths.length} subcomponents to server`);

      // Generate main component code (with imports based on significant children)
      code = generateMainComponentCodeFromChildren(node, significantChildren);
    }

    // Export screenshot - check if exportAsync exists
    let screenshot: Uint8Array | null = null;
    if ('exportAsync' in node && typeof node.exportAsync === 'function') {
      screenshot = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 }
      });
    } else {
      console.log(`Node ${config.title} doesn't support exportAsync`);
    }

    // Extract assets for root level (exclude assets already in subcomponents)
    const rootAssets = await extractRootAssets(node, significantChildren.map(c => c.node));

    // Get metadata
    const metadata = extractMetadata(node);

    // Extract raw Figma structure
    const rawFigma = extractRawFigma(node);

    return {
      id: config.id,
      name: config.name,
      title: config.title,
      code,
      rawFigma,
      screenshot,
      assets: rootAssets,
      metadata,
      subComponentPaths: extractedPaths.length > 0 ? extractedPaths : undefined
    };

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : '';
    console.error(`Failed to extract ${config.title}:`, errMsg, errStack);

    // Send error to server for logging
    figma.ui.postMessage({
      type: 'log-error',
      component: config.title,
      error: errMsg,
      stack: errStack
    });

    figma.ui.postMessage({
      type: 'error',
      message: `Failed to extract ${config.title}: ${errMsg}`
    });
    return null;
  }
}

// Extract assets only from root node, excluding those in subcomponent subtrees
export async function extractRootAssets(
  node: SceneNode,
  excludeNodes: SceneNode[]
): Promise<Array<{ name: string; data: Uint8Array; format: string }>> {
  const assets: Array<{ name: string; data: Uint8Array; format: string }> = [];
  const excludeIds = new Set(excludeNodes.map(n => n.id));

  async function processNode(n: SceneNode, isExcluded: boolean) {
    // Check if this node or any ancestor is in the exclude list
    if (excludeIds.has(n.id)) {
      isExcluded = true;
    }

    // Only extract assets if not in an excluded subtree
    if (!isExcluded) {
      // Extract image fills
      if ('fills' in n && Array.isArray(n.fills)) {
        const fills = n.fills as Paint[];

        // For RECTANGLE nodes with image fills:
        // Plain fills (FILL mode, identity transform, full opacity) use getImageByHash
        // for the full-res source image. Complex fills (CROP, transforms, effects) use
        // exportAsync to capture the baked visual result.
        if (n.type === 'RECTANGLE') {
          const hasImageFill = fills.some(f => f.type === 'IMAGE' && f.visible !== false);
          if (hasImageFill) {
            const plainCheck = isPlainImageFill(n);
            if (plainCheck.plain) {
              // Plain fill — get original image by hash
              if (!assets.some(a => a.name === plainCheck.imageHash)) {
                try {
                  const image = figma.getImageByHash(plainCheck.imageHash);
                  if (image) {
                    const bytes = await image.getBytesAsync();
                    assets.push({
                      name: plainCheck.imageHash,
                      data: bytes,
                      format: 'png'
                    });
                  }
                } catch (error) {
                  // Skip failed images
                }
              }
            } else {
              // Complex fill — export the baked visual via exportAsync
              const safeId = n.id.replace(/[^a-zA-Z0-9]/g, '_');
              if (!assets.some(a => a.name === `img_${safeId}`)) {
                try {
                  if ('exportAsync' in n && typeof n.exportAsync === 'function') {
                    const pngBytes = await n.exportAsync({ format: 'PNG' });
                    assets.push({
                      name: `img_${safeId}`,
                      data: pngBytes,
                      format: 'png'
                    });
                  }
                } catch (error) {
                  // Skip failed exports
                }
              }
            }
          }
        }

        // For non-RECTANGLE nodes, extract image fills by hash
        // (FRAME background images, etc.)
        if (n.type !== 'RECTANGLE') {
          for (const fill of fills) {
            if (fill.type === 'IMAGE' && fill.imageHash) {
              if (assets.some(a => a.name === fill.imageHash)) continue;

              try {
                const image = figma.getImageByHash(fill.imageHash);
                if (image) {
                  const bytes = await image.getBytesAsync();
                  assets.push({
                    name: fill.imageHash,
                    data: bytes,
                    format: 'png'
                  });
                }
              } catch (error) {
                // Skip failed images
              }
            }
          }
        }
      }

      // Export vector nodes as SVG
      if (n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION' || n.type === 'LINE' || n.type === 'STAR' || n.type === 'POLYGON' || n.type === 'ELLIPSE') {
        const safeId = n.id.replace(/[^a-zA-Z0-9]/g, '_');
        if (!assets.some(a => a.name === 'icon_' + safeId)) {
          try {
            if ('exportAsync' in n && typeof n.exportAsync === 'function') {
              const svgBytes = await n.exportAsync({ format: 'SVG' });
              assets.push({
                name: 'icon_' + safeId,
                data: svgBytes,
                format: 'svg'
              });
            }
          } catch (error) {
            // Skip failed SVG exports
          }
        }
      }
    }

    // Recursively process children
    if ('children' in n) {
      for (const child of n.children) {
        await processNode(child, isExcluded);
      }
    }
  }

  await processNode(node, false);
  return assets;
}

export function extractMetadata(node: SceneNode): any {
  const metadata: any = {
    id: node.id,
    name: node.name,
    type: node.type
  };

  if ('width' in node) metadata.width = node.width;
  if ('height' in node) metadata.height = node.height;
  if ('x' in node) metadata.x = node.x;
  if ('y' in node) metadata.y = node.y;

  return metadata;
}

// Extract raw Figma node structure recursively
export function extractRawFigma(node: SceneNode): any {
  const raw: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  // Dimensions and position
  if ('width' in node) raw.width = node.width;
  if ('height' in node) raw.height = node.height;
  if ('x' in node) raw.x = node.x;
  if ('y' in node) raw.y = node.y;

  // Absolute bounds for rotated vector positioning
  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) {
    raw.absoluteBoundingBox = node.absoluteBoundingBox;
  }
  if ('absoluteRenderBounds' in node && node.absoluteRenderBounds) {
    raw.absoluteRenderBounds = node.absoluteRenderBounds;
  }
  if ('absoluteTransform' in node && node.absoluteTransform) {
    raw.absoluteTransform = node.absoluteTransform;
  }

  // Layout properties (use safeValue to handle potential symbols)
  if ('layoutMode' in node && safeValue(node.layoutMode)) raw.layoutMode = node.layoutMode;
  if ('layoutSizingHorizontal' in node && safeValue(node.layoutSizingHorizontal)) raw.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if ('layoutSizingVertical' in node && safeValue(node.layoutSizingVertical)) raw.layoutSizingVertical = node.layoutSizingVertical;
  if ('primaryAxisSizingMode' in node && safeValue(node.primaryAxisSizingMode)) raw.primaryAxisSizingMode = node.primaryAxisSizingMode;
  if ('counterAxisSizingMode' in node && safeValue(node.counterAxisSizingMode)) raw.counterAxisSizingMode = node.counterAxisSizingMode;
  if ('primaryAxisAlignItems' in node && safeValue(node.primaryAxisAlignItems)) raw.primaryAxisAlignItems = node.primaryAxisAlignItems;
  if ('counterAxisAlignItems' in node && safeValue(node.counterAxisAlignItems)) raw.counterAxisAlignItems = node.counterAxisAlignItems;
  if ('itemSpacing' in node && safeValue(node.itemSpacing) !== null) raw.itemSpacing = node.itemSpacing;
  if ('paddingLeft' in node && safeValue(node.paddingLeft) !== null) raw.paddingLeft = node.paddingLeft;
  if ('paddingRight' in node && safeValue(node.paddingRight) !== null) raw.paddingRight = node.paddingRight;
  if ('paddingTop' in node && safeValue(node.paddingTop) !== null) raw.paddingTop = node.paddingTop;
  if ('paddingBottom' in node && safeValue(node.paddingBottom) !== null) raw.paddingBottom = node.paddingBottom;

  // Visual properties
  if ('fills' in node && Array.isArray(node.fills)) {
    raw.fills = (node.fills as Paint[]).map(fill => {
      if (fill.type === 'SOLID') {
        return { type: 'SOLID', color: rgbToHex(fill.color), opacity: fill.opacity };
      }
      if (fill.type === 'IMAGE') {
        const imgFill = fill as ImagePaint;
        return {
          type: 'IMAGE',
          imageHash: fill.imageHash,
          opacity: imgFill.opacity,
          scaleMode: imgFill.scaleMode,
          imageTransform: imgFill.imageTransform,
          visible: imgFill.visible
        };
      }
      if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL' || fill.type === 'GRADIENT_ANGULAR' || fill.type === 'GRADIENT_DIAMOND') {
        const gradientFill = fill as GradientPaint;
        return {
          type: fill.type,
          gradientStops: gradientFill.gradientStops && gradientFill.gradientStops.map(stop => ({
            color: rgbToHex(stop.color),
            position: stop.position,
            opacity: stop.color.a
          })),
          gradientTransform: gradientFill.gradientTransform
        };
      }
      return { type: fill.type };
    });
  }

  if ('strokes' in node && Array.isArray(node.strokes)) {
    raw.strokes = (node.strokes as Paint[]).map(stroke => {
      if (stroke.type === 'SOLID') {
        return { type: 'SOLID', color: rgbToHex(stroke.color), opacity: stroke.opacity };
      }
      if (stroke.type === 'GRADIENT_LINEAR' || stroke.type === 'GRADIENT_RADIAL' || stroke.type === 'GRADIENT_ANGULAR' || stroke.type === 'GRADIENT_DIAMOND') {
        const gradientStroke = stroke as GradientPaint;
        return {
          type: stroke.type,
          gradientStops: gradientStroke.gradientStops && gradientStroke.gradientStops.map(stop => ({
            color: rgbToHex(stop.color),
            position: stop.position,
            opacity: stop.color.a
          })),
          gradientTransform: gradientStroke.gradientTransform
        };
      }
      return { type: stroke.type };
    });
  }

  if ('strokeWeight' in node && safeValue(node.strokeWeight) !== null) raw.strokeWeight = node.strokeWeight;
  if ('cornerRadius' in node && safeValue(node.cornerRadius) !== null) raw.cornerRadius = node.cornerRadius;
  if ('opacity' in node && safeValue(node.opacity) !== null) raw.opacity = node.opacity;
  if ('rotation' in node && safeValue(node.rotation) !== null) raw.rotation = node.rotation;
  if ('clipsContent' in node) raw.clipsContent = node.clipsContent;

  // Individual corner radii
  if ('topLeftRadius' in node) {
    const frame = node as FrameNode;
    if (safeValue(frame.topLeftRadius) !== null || safeValue(frame.topRightRadius) !== null ||
        safeValue(frame.bottomRightRadius) !== null || safeValue(frame.bottomLeftRadius) !== null) {
      raw.cornerRadii = {
        topLeft: frame.topLeftRadius,
        topRight: frame.topRightRadius,
        bottomRight: frame.bottomRightRadius,
        bottomLeft: frame.bottomLeftRadius
      };
    }
  }

  // Min/Max dimensions
  if ('minWidth' in node && safeValue(node.minWidth) !== null) raw.minWidth = node.minWidth;
  if ('maxWidth' in node && safeValue(node.maxWidth) !== null) raw.maxWidth = node.maxWidth;
  if ('minHeight' in node && safeValue(node.minHeight) !== null) raw.minHeight = node.minHeight;
  if ('maxHeight' in node && safeValue(node.maxHeight) !== null) raw.maxHeight = node.maxHeight;

  // Text properties
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    raw.characters = textNode.characters;

    // Handle potentially mixed text properties by getting ranges
    const textLength = textNode.characters.length;
    if (textLength > 0) {
      // Font size - check if mixed
      if (typeof textNode.fontSize === 'number') {
        raw.fontSize = textNode.fontSize;
      } else {
        // Mixed - get segments
        raw.fontSizeSegments = getTextSegments(textNode, 'fontSize');
      }

      // Font weight
      if (typeof textNode.fontWeight === 'number') {
        raw.fontWeight = textNode.fontWeight;
      } else {
        raw.fontWeightSegments = getTextSegments(textNode, 'fontWeight');
      }

      // Font name
      if (textNode.fontName && typeof textNode.fontName === 'object' && 'family' in textNode.fontName) {
        raw.fontFamily = (textNode.fontName as FontName).family;
        raw.fontStyle = (textNode.fontName as FontName).style;
      } else {
        raw.fontSegments = getTextSegments(textNode, 'fontName');
      }

      // Line height
      if (textNode.lineHeight && typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
        raw.lineHeight = (textNode.lineHeight as { value: number }).value;
      }

      // Text fills (color)
      if (Array.isArray(textNode.fills)) {
        const fills = textNode.fills as Paint[];
        const solidFill = fills.find(f => f.type === 'SOLID');
        if (solidFill && solidFill.type === 'SOLID') {
          raw.textColor = rgbToHex(solidFill.color);
        }
      } else {
        raw.textColorSegments = getTextSegments(textNode, 'fills');
      }
    }

    if (textNode.textAutoResize) raw.textAutoResize = textNode.textAutoResize;
    if (typeof textNode.textAlignHorizontal === 'string') raw.textAlignHorizontal = textNode.textAlignHorizontal;
    if (typeof textNode.textAlignVertical === 'string') raw.textAlignVertical = textNode.textAlignVertical;
    if (textNode.textDecoration) raw.textDecoration = textNode.textDecoration;
    if (textNode.letterSpacing && typeof textNode.letterSpacing === 'object') {
      raw.letterSpacing = textNode.letterSpacing;
    }
  }

  // Effects (shadows, blurs)
  if ('effects' in node && Array.isArray(node.effects)) {
    raw.effects = node.effects.map((effect: Effect) => {
      const e: any = { type: effect.type, visible: effect.visible };
      if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
        if ('color' in effect) e.color = rgbToHex(effect.color);
        if ('offset' in effect) e.offset = effect.offset;
        if ('radius' in effect) e.radius = effect.radius;
        if ('spread' in effect) e.spread = effect.spread;
      }
      if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
        if ('radius' in effect) e.radius = effect.radius;
      }
      return e;
    });
  }

  // Constraints
  if ('constraints' in node && safeValue(node.constraints)) raw.constraints = node.constraints;

  // Vector data for icons/shapes
  if (node.type === 'VECTOR' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON' || node.type === 'ELLIPSE') {
    raw.isIcon = true;
    // Mark fill color for the icon
    if ('fills' in node && Array.isArray(node.fills)) {
      const fills = node.fills as Paint[];
      const solidFill = fills.find(f => f.type === 'SOLID');
      if (solidFill && solidFill.type === 'SOLID') {
        raw.fillColor = rgbToHex(solidFill.color);
      }
    }
    // Mark stroke color
    if ('strokes' in node && Array.isArray(node.strokes)) {
      const strokes = node.strokes as Paint[];
      const solidStroke = strokes.find(s => s.type === 'SOLID');
      if (solidStroke && solidStroke.type === 'SOLID') {
        raw.strokeColor = rgbToHex(solidStroke.color);
      }
    }
  }

  // Children
  if ('children' in node && node.children) {
    raw.children = node.children.map(child => extractRawFigma(child));
  }

  return raw;
}
