import { rgbToHex, safeValue } from './utils';
import { getAssetPathPrefix } from './config';

// Check if a RECTANGLE's visible image fill is "plain" — can be fetched via getImageByHash
// and rendered with CSS object-cover, instead of needing exportAsync.
// Plain means: FILL scaleMode, identity imageTransform, full opacity, no node effects.
export function isPlainImageFill(node: SceneNode): { plain: true; imageHash: string } | { plain: false } {
  if (!('fills' in node) || !Array.isArray(node.fills)) return { plain: false };
  const fills = (node.fills as Paint[]).filter(f => f.type === 'IMAGE' && f.visible !== false) as ImagePaint[];
  if (fills.length !== 1) return { plain: false };
  const fill = fills[0];
  if (fill.scaleMode !== 'FILL') return { plain: false };
  if (fill.opacity !== undefined && fill.opacity < 1) return { plain: false };
  if (!fill.imageHash) return { plain: false };
  // Check for identity transform [[1,0,0],[0,1,0]]
  if (fill.imageTransform) {
    const t = fill.imageTransform;
    const isIdentity = Math.abs(t[0][0] - 1) < 0.01 && Math.abs(t[0][1]) < 0.01 && Math.abs(t[0][2]) < 0.01
      && Math.abs(t[1][0]) < 0.01 && Math.abs(t[1][1] - 1) < 0.01 && Math.abs(t[1][2]) < 0.01;
    if (!isIdentity) return { plain: false };
  }
  // Check for node-level effects
  if ('effects' in node && Array.isArray(node.effects)) {
    const hasVisibleEffects = (node.effects as any[]).some(e => e.visible !== false);
    if (hasVisibleEffects) return { plain: false };
  }
  // Check if the image is significantly clipped by its parent. When the visible render
  // bounds are much smaller than the node's actual dimensions, the image is being
  // cropped by overflow-hidden. In that case, use exportAsync for pixel-perfect rendering
  // instead of relying on CSS object-cover which may scale differently.
  if ('absoluteRenderBounds' in node && node.absoluteRenderBounds && 'width' in node && 'height' in node) {
    const rb = node.absoluteRenderBounds as { width: number; height: number };
    const nodeW = node.width as number;
    const nodeH = node.height as number;
    // If visible area is less than 80% of node size in either dimension, it's significantly clipped
    if (rb.width < nodeW * 0.8 || rb.height < nodeH * 0.8) {
      return { plain: false };
    }
  }
  return { plain: true, imageHash: fill.imageHash };
}

// Detect gradient stroke on a node and return the CSS gradient + metadata needed
// to wrap the element in a "gradient border" background div.
export function getGradientBorderInfo(node: SceneNode): { gradientCss: string; strokeWeight: number; borderRadius: number } | null {
  if (!('strokes' in node) || !Array.isArray(node.strokes) || node.strokes.length === 0) return null;
  const strokes = node.strokes as Paint[];
  const gradientStroke = strokes.find(s =>
    (s.type === 'GRADIENT_LINEAR' || s.type === 'GRADIENT_RADIAL') && s.visible !== false
  ) as GradientPaint | undefined;
  if (!gradientStroke || !gradientStroke.gradientStops || gradientStroke.gradientStops.length < 2) return null;

  const strokeWeight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? Math.round(node.strokeWeight) : 1;
  const borderRadius = 'cornerRadius' in node && typeof node.cornerRadius === 'number' ? node.cornerRadius : 0;

  const stops = gradientStroke.gradientStops;

  function getColorWithOpacity(stop: ColorStop): string {
    const r = Math.round(stop.color.r * 255);
    const g = Math.round(stop.color.g * 255);
    const b = Math.round(stop.color.b * 255);
    const a = stop.color.a !== undefined ? stop.color.a : 1;
    if (a < 1) return `rgba(${r},${g},${b},${a})`;
    const hex = (v: number) => ('0' + v.toString(16)).slice(-2);
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  const stopsStr = stops.map(stop => {
    const color = getColorWithOpacity(stop);
    const percent = Math.round(stop.position * 100);
    return `${color}_${percent}%`;
  }).join(',');

  let gradientCss: string;
  if (gradientStroke.type === 'GRADIENT_LINEAR' && gradientStroke.gradientTransform) {
    const transform = gradientStroke.gradientTransform;
    const figmaAngle = Math.atan2(transform[1][0], transform[0][0]) * (180 / Math.PI);
    const cssAngle = Math.round(90 - figmaAngle);
    gradientCss = `linear-gradient(${cssAngle}deg,${stopsStr})`;
  } else {
    gradientCss = `linear-gradient(180deg,${stopsStr})`;
  }

  return { gradientCss, strokeWeight, borderRadius };
}

// Get text color segments for code generation
export function getTextColorSegments(textNode: TextNode): Array<{ text: string; color: string | null; isItalic: boolean; fontWeight: number | null; fontSize: number | null }> {
  const segments: Array<{ text: string; color: string | null; isItalic: boolean; fontWeight: number | null; fontSize: number | null }> = [];
  const text = textNode.characters;
  if (text.length === 0) return segments;

  let currentStart = 0;
  let currentColor: string | null = null;
  let currentIsItalic = false;
  let currentFontWeight: number | null = null;
  let currentFontSize: number | null = null;

  for (let i = 0; i <= text.length; i++) {
    let color: string | null = null;
    let isItalic = false;
    let fontWeight: number | null = null;
    let fontSize: number | null = null;

    if (i < text.length) {
      try {
        // Get color at position
        const fills = textNode.getRangeFills(i, i + 1);
        if (Array.isArray(fills)) {
          const solidFill = (fills as Paint[]).find(f => f.type === 'SOLID');
          if (solidFill && solidFill.type === 'SOLID') {
            color = rgbToHex(solidFill.color);
          }
        }
        // Get italic and font weight at position
        const fontName = textNode.getRangeFontName(i, i + 1);
        if (fontName && typeof fontName === 'object' && 'style' in fontName) {
          const style = (fontName as FontName).style.toLowerCase();
          isItalic = style.includes('italic');
          if (style.includes('bold')) fontWeight = 700;
          else if (style.includes('semibold')) fontWeight = 600;
          else if (style.includes('medium')) fontWeight = 500;
          else if (style.includes('light')) fontWeight = 300;
          else fontWeight = 400;
        }
        // Get font size at position
        const rangeSize = textNode.getRangeFontSize(i, i + 1);
        if (typeof rangeSize === 'number') {
          fontSize = rangeSize;
        }
      } catch (e) {
        // Skip if we can't get the range value
      }
    }

    if (i === text.length || color !== currentColor || isItalic !== currentIsItalic || fontWeight !== currentFontWeight || fontSize !== currentFontSize) {
      if (currentStart < i) {
        segments.push({
          text: text.substring(currentStart, i),
          color: currentColor,
          isItalic: currentIsItalic,
          fontWeight: currentFontWeight,
          fontSize: currentFontSize
        });
      }
      currentStart = i;
      currentColor = color;
      currentIsItalic = isItalic;
      currentFontWeight = fontWeight;
      currentFontSize = fontSize;
    }
  }

  return segments;
}

// Get text segments when properties are mixed
export function getTextSegments(textNode: TextNode, property: string): any[] {
  const segments: any[] = [];
  const text = textNode.characters;
  if (text.length === 0) return segments;

  let currentStart = 0;
  let currentValue: any = null;

  for (let i = 0; i <= text.length; i++) {
    let value: any = null;

    if (i < text.length) {
      try {
        if (property === 'fontSize') {
          value = textNode.getRangeFontSize(i, i + 1);
        } else if (property === 'fontWeight') {
          const fontName = textNode.getRangeFontName(i, i + 1);
          if (fontName && typeof fontName === 'object' && 'style' in fontName) {
            const style = (fontName as FontName).style.toLowerCase();
            value = style.includes('bold') ? 700 : style.includes('light') ? 300 : 400;
          }
        } else if (property === 'fontName') {
          const fontName = textNode.getRangeFontName(i, i + 1);
          if (fontName && typeof fontName === 'object' && 'family' in fontName) {
            value = { family: (fontName as FontName).family, style: (fontName as FontName).style };
          }
        } else if (property === 'fills') {
          const fills = textNode.getRangeFills(i, i + 1);
          if (Array.isArray(fills)) {
            const solidFill = (fills as Paint[]).find(f => f.type === 'SOLID');
            if (solidFill && solidFill.type === 'SOLID') {
              value = rgbToHex(solidFill.color);
            }
          }
        }
      } catch (e) {
        // Skip if we can't get the range value
      }
    }

    const valueStr = JSON.stringify(value);
    const currentValueStr = JSON.stringify(currentValue);

    if (i === text.length || valueStr !== currentValueStr) {
      if (currentValue !== null && currentStart < i) {
        segments.push({
          start: currentStart,
          end: i,
          text: text.substring(currentStart, i),
          value: currentValue
        });
      }
      currentStart = i;
      currentValue = value;
    }
  }

  return segments;
}

export function extractStyles(node: SceneNode, parentHasAutoLayout: boolean = false, parentLayoutMode: string = 'NONE'): string[] {
  const styles: string[] = [];

  // Layout
  if ('layoutMode' in node) {
    if (node.layoutMode === 'HORIZONTAL') styles.push('flex');
    if (node.layoutMode === 'VERTICAL') styles.push('flex', 'flex-col');
  }

  // Sizing - skip explicit widths for flex children (they should size naturally)
  // Only set dimensions if parent uses absolute positioning OR this is the root
  if ('width' in node && typeof node.width === 'number') {
    // For flex children, only set width if the node has fixed sizing constraints
    const hasFixedWidth = 'layoutSizingHorizontal' in node && node.layoutSizingHorizontal === 'FIXED';
    const roundedWidth = Math.round(node.width);
    // Skip sub-pixel widths (≤1px) for non-clipping frames — let flex size to children
    const clipsWidth = 'clipsContent' in node ? node.clipsContent : true;
    if ((!parentHasAutoLayout || hasFixedWidth) && (roundedWidth > 1 || clipsWidth)) {
      styles.push(`w-[${roundedWidth}px]`);
    }
  }
  if ('height' in node && typeof node.height === 'number') {
    const hasFixedHeight = 'layoutSizingVertical' in node && node.layoutSizingVertical === 'FIXED';
    const roundedHeight = Math.round(node.height);
    // Skip sub-pixel heights (≤1px) for non-clipping frames — let flex size to children
    const clipsHeight = 'clipsContent' in node ? node.clipsContent : true;
    // For TEXT nodes, skip explicit height when it's smaller than line-height.
    // In CSS, a height smaller than line-height misaligns the text (overflows upward).
    // Let the text size naturally to its line-height so parent flex centering works.
    let skipTextHeight = false;
    if (node.type === 'TEXT') {
      const textNode = node as TextNode;
      const lh = textNode.lineHeight;
      if (typeof lh === 'object' && lh !== null && 'unit' in lh && 'value' in lh) {
        const lhObj = lh as { unit: string; value: number };
        const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 16;
        const lineHeightPx = lhObj.unit === 'PIXELS' ? lhObj.value : lhObj.unit === 'PERCENT' ? fontSize * (lhObj.value / 100) : fontSize * 1.2;
        if (roundedHeight < lineHeightPx) skipTextHeight = true;
      }
    }
    if (!skipTextHeight && (!parentHasAutoLayout || hasFixedHeight) && (roundedHeight > 1 || clipsHeight)) {
      styles.push(`h-[${roundedHeight}px]`);
    }
  }

  // HUG sizing: prevent stretch in cross-axis of parent flex
  if (parentHasAutoLayout) {
    if ('layoutSizingHorizontal' in node && node.layoutSizingHorizontal === 'HUG' && parentLayoutMode === 'VERTICAL') {
      // For TEXT nodes, Figma's HUG means "use the text box width" which includes
      // wrapping text at that width. CSS w-fit maps to max-content (no wrapping),
      // so we use the explicit Figma width instead to preserve text wrapping.
      if (node.type === 'TEXT') {
        styles.push(`w-[${Math.round(node.width)}px]`);
      } else {
        styles.push('w-fit');
      }
    }
    if ('layoutSizingVertical' in node && node.layoutSizingVertical === 'HUG' && parentLayoutMode === 'HORIZONTAL') {
      styles.push('h-fit');
    }

    // HUG containers with FILL children: In Figma, HUG computes the dimension from
    // non-FILL children, then FILL children stretch to fit. In CSS, unconstrained FILL
    // children inflate the container beyond the intended HUG size. Emit the explicit
    // Figma-computed dimension to constrain the container.
    if ('layoutMode' in node && node.layoutMode !== 'NONE' && 'children' in node) {
      const isVerticalLayout = node.layoutMode === 'VERTICAL';
      const hasHugWidth = 'layoutSizingHorizontal' in node && node.layoutSizingHorizontal === 'HUG';
      const hasHugHeight = 'layoutSizingVertical' in node && node.layoutSizingVertical === 'HUG';
      const children = (node as any).children as SceneNode[];

      // For vertical layout: width is cross axis. If HUG width and any child has FILL width, emit explicit width.
      if (isVerticalLayout && hasHugWidth && 'width' in node) {
        const hasFillChild = children.some((c: SceneNode) =>
          'layoutSizingHorizontal' in c && c.layoutSizingHorizontal === 'FILL');
        if (hasFillChild && !styles.some(s => s.startsWith('w-['))) {
          styles.push(`w-[${Math.round(node.width as number)}px]`);
        }
      }
      // For horizontal layout: height is cross axis. If HUG height and any child has FILL height, emit explicit height.
      if (!isVerticalLayout && hasHugHeight && 'height' in node) {
        const hasFillChild = children.some((c: SceneNode) =>
          'layoutSizingVertical' in c && c.layoutSizingVertical === 'FILL');
        if (hasFillChild && !styles.some(s => s.startsWith('h-['))) {
          styles.push(`h-[${Math.round(node.height as number)}px]`);
        }
      }
    }

    // FIXED sizing in flex: prevent flex from shrinking fixed-size children.
    // Without shrink-0, flex can compress a 64px element to fit siblings.
    if ('layoutSizingHorizontal' in node && node.layoutSizingHorizontal === 'FIXED' && parentLayoutMode === 'HORIZONTAL') {
      styles.push('shrink-0');
    }
    if ('layoutSizingVertical' in node && node.layoutSizingVertical === 'FIXED' && parentLayoutMode === 'VERTICAL') {
      if (styles.indexOf('shrink-0') === -1) styles.push('shrink-0');
    }

    // FILL sizing: stretch to fill the parent along that axis.
    // On the primary axis → flex-1 (grow to fill available space).
    // On the cross axis → self-stretch (needed when parent uses items-center/items-start/items-end).
    if ('layoutSizingHorizontal' in node && node.layoutSizingHorizontal === 'FILL') {
      if (parentLayoutMode === 'HORIZONTAL') {
        styles.push('flex-1');
      } else if (parentLayoutMode === 'VERTICAL') {
        // Cross axis in VERTICAL parent: need explicit w-full when parent alignment isn't stretch
        styles.push('w-full');
      }
    }
    if ('layoutSizingVertical' in node && node.layoutSizingVertical === 'FILL') {
      if (parentLayoutMode === 'VERTICAL') {
        styles.push('flex-1');
      } else if (parentLayoutMode === 'HORIZONTAL') {
        // Cross axis in HORIZONTAL parent: need explicit h-full when parent alignment isn't stretch
        styles.push('h-full');
      }
    }
  }

  // Padding (for auto-layout frames)
  // In Figma, fixed-size containers treat padding as aspirational — if padding + content
  // exceeds the container, centering takes precedence. In CSS, padding strictly reduces the
  // content area. So skip padding on any axis where it would consume more than half the
  // container's dimension (the centering alignment handles positioning instead).
  if ('paddingLeft' in node && 'paddingRight' in node && 'paddingTop' in node && 'paddingBottom' in node) {
    const n = node as FrameNode;
    let pl = n.paddingLeft || 0;
    let pr = n.paddingRight || 0;
    let pt = n.paddingTop || 0;
    let pb = n.paddingBottom || 0;

    // Check if padding over-constrains a fixed-size container.
    // Only skip padding when it would consume nearly all space (>90%),
    // indicating Figma centering truly overrides padding. The 50% threshold
    // was too aggressive — it dropped asymmetric padding (e.g. pt:210 pb:24
    // in a 397px frame) that intentionally offsets content.
    if ('width' in n && 'height' in n && 'layoutMode' in n && n.layoutMode !== 'NONE') {
      const w = n.width as number;
      const h = n.height as number;
      const isHorizontal = n.layoutMode === 'HORIZONTAL';
      const isHorizFixed = isHorizontal
        ? (n as any).primaryAxisSizingMode === 'FIXED'
        : (n as any).counterAxisSizingMode === 'FIXED';
      const isVertFixed = isHorizontal
        ? (n as any).counterAxisSizingMode === 'FIXED'
        : (n as any).primaryAxisSizingMode === 'FIXED';
      if (isHorizFixed && (pl + pr) > w * 0.9) { pl = 0; pr = 0; }
      if (isVertFixed && (pt + pb) > h * 0.9) { pt = 0; pb = 0; }
    }

    if (pl === pr && pt === pb && pl === pt && pl > 0) {
      styles.push(`p-[${pl}px]`);
    } else if (pl === pr && pt === pb) {
      if (pl > 0) styles.push(`px-[${pl}px]`);
      if (pt > 0) styles.push(`py-[${pt}px]`);
    } else {
      if (pt) styles.push(`pt-[${pt}px]`);
      if (pr) styles.push(`pr-[${pr}px]`);
      if (pb) styles.push(`pb-[${pb}px]`);
      if (pl) styles.push(`pl-[${pl}px]`);
    }
  }

  // Gap (skip if using SPACE_BETWEEN - gap is automatic)
  // Also skip for GRID layout since we fall back to absolute positioning for children
  if ('itemSpacing' in node && node.itemSpacing) {
    const isSpaceBetween = 'primaryAxisAlignItems' in node && node.primaryAxisAlignItems === 'SPACE_BETWEEN';
    const isGrid = 'layoutMode' in node && node.layoutMode === 'GRID';
    if (!isSpaceBetween && !isGrid) {
      const gap = node.itemSpacing as number;
      styles.push(`gap-[${Number.isInteger(gap) ? gap : parseFloat(gap.toFixed(2))}px]`);
    }
  }

  // Background color/gradient (skip for TEXT nodes - they use fills for text color, not background)
  if ('fills' in node && Array.isArray(node.fills) && node.type !== 'TEXT') {
    // Filter to only visible fills
    const fills = (node.fills as Paint[]).filter(f => f.visible !== false);

    // Check for image fill first (for FRAME nodes - RECTANGLE handled in generateNodeCode)
    if (node.type !== 'RECTANGLE') {
      const imageFill = fills.find(f => f.type === 'IMAGE' && f.visible !== false) as ImagePaint | undefined;
      if (imageFill && imageFill.imageHash) {
        styles.push(`bg-[url('${getAssetPathPrefix()}/${imageFill.imageHash}.png')]`);
        styles.push('bg-cover');
        styles.push('bg-center');
        styles.push('bg-no-repeat');
        if (imageFill.opacity !== undefined && imageFill.opacity < 1) {
          styles.push(`opacity-[${imageFill.opacity}]`);
        }
      }
    }

    // Check for gradient
    const gradientFill = fills.find(f =>
      (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') && f.visible !== false
    ) as GradientPaint | undefined;

    if (gradientFill && gradientFill.gradientStops && gradientFill.gradientStops.length >= 2) {
      // Generate CSS gradient with proper direction
      const stops = gradientFill.gradientStops;

      // Helper to get color with opacity
      function getColorWithOpacity(stop: ColorStop): string {
        const opacity = stop.color.a !== undefined ? stop.color.a : 1;
        if (opacity < 1) {
          return `rgba(${Math.round(stop.color.r * 255)},${Math.round(stop.color.g * 255)},${Math.round(stop.color.b * 255)},${opacity})`;
        }
        return rgbToHex(stop.color);
      }

      const firstColor = getColorWithOpacity(stops[0]);
      const lastColor = getColorWithOpacity(stops[stops.length - 1]);

      if (gradientFill.type === 'GRADIENT_LINEAR') {
        // Calculate angle from transform matrix for precise CSS gradient
        if (gradientFill.gradientTransform) {
          const transform = gradientFill.gradientTransform;
          // transform is [[a, c, tx], [b, d, ty]]
          // Figma's gradient angle: atan2(b, a) gives rotation from horizontal
          // CSS linear-gradient angle: 0deg = to top, 90deg = to right
          // Figma angle 0 = horizontal (to right), CSS needs 90deg for that
          const figmaAngle = Math.atan2(transform[1][0], transform[0][0]) * (180 / Math.PI);
          // Convert: CSS angle = 90 - figmaAngle (to convert from "from" direction to "to" direction)
          const cssAngle = Math.round(90 - figmaAngle);

          // Build gradient string with all stops (NO SPACES - breaks Tailwind arbitrary values)
          const stopsStr = stops.map(stop => {
            const color = getColorWithOpacity(stop);
            const percent = Math.round(stop.position * 100);
            return `${color}_${percent}%`;
          }).join(',');

          styles.push(`bg-[linear-gradient(${cssAngle}deg,${stopsStr})]`);
        } else {
          // Fallback to simple horizontal gradient
          styles.push(`bg-gradient-to-r`);
          styles.push(`from-[${firstColor}]`);
          styles.push(`to-[${lastColor}]`);
        }
      } else {
        // Radial gradient with proper position and shape from transform (NO SPACES)
        const stopsStr = stops.map(stop => {
          const color = getColorWithOpacity(stop);
          const percent = Math.round(stop.position * 100);
          return `${color}_${percent}%`;
        }).join(',');

        // Extract position and shape from gradientTransform
        // Transform matrix [[a, c, tx], [b, d, ty]] where:
        // - tx, ty = center position (0-1 normalized, 0.5 = center)
        // - a, d = scale factors that determine ellipse aspect ratio
        if (gradientFill.gradientTransform) {
          const transform = gradientFill.gradientTransform;
          // Center position as percentage
          const centerX = Math.round(transform[0][2] * 100);
          const centerY = Math.round(transform[1][2] * 100);

          // Scale factors determine if it's a circle or ellipse
          // and the relative size in each direction
          const scaleX = Math.abs(transform[0][0]);
          const scaleY = Math.abs(transform[1][1]);

          // Determine shape - if scales are similar, use circle
          const isCircle = Math.abs(scaleX - scaleY) < 0.05;

          if (isCircle) {
            styles.push(`bg-[radial-gradient(circle_at_${centerX}%_${centerY}%,${stopsStr})]`);
          } else {
            // Ellipse - the scale ratio determines aspect ratio
            // Use farthest-side to let gradient extend to edges, with aspect ratio
            const aspectRatio = scaleX / scaleY;
            if (Math.abs(aspectRatio - 1) < 0.1) {
              // Nearly circular
              styles.push(`bg-[radial-gradient(circle_at_${centerX}%_${centerY}%,${stopsStr})]`);
            } else {
              // True ellipse - use percentage-based sizing relative to container
              styles.push(`bg-[radial-gradient(ellipse_at_${centerX}%_${centerY}%,${stopsStr})]`);
            }
          }
        } else {
          // No transform - default centered radial
          styles.push(`bg-[radial-gradient(${stopsStr})]`);
        }
      }
    } else {
      // Solid fill — check for fill-level opacity (separate from node opacity)
      const solidFill = fills.find(f => f.type === 'SOLID' && f.visible !== false);
      if (solidFill && solidFill.type === 'SOLID') {
        if (solidFill.opacity !== undefined && solidFill.opacity < 1) {
          const r = Math.round(solidFill.color.r * 255);
          const g = Math.round(solidFill.color.g * 255);
          const b = Math.round(solidFill.color.b * 255);
          styles.push(`bg-[rgba(${r},${g},${b},${solidFill.opacity})]`);
        } else {
          const color = rgbToHex(solidFill.color);
          styles.push(`bg-[${color}]`);
        }
      }
    }
  }

  // Text styles
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;

    if (typeof textNode.fontSize === 'number') {
      styles.push(`text-[${textNode.fontSize}px]`);
    }

    if (typeof textNode.fontWeight === 'number') {
      if (textNode.fontWeight >= 700) styles.push('font-bold');
      else if (textNode.fontWeight >= 600) styles.push('font-semibold');
      else if (textNode.fontWeight >= 500) styles.push('font-medium');
      else if (textNode.fontWeight <= 300) styles.push('font-light');
    }

    // Italic
    if (textNode.fontName && typeof textNode.fontName === 'object' && 'style' in textNode.fontName) {
      const style = (textNode.fontName as FontName).style.toLowerCase();
      if (style.includes('italic')) styles.push('italic');
    }

    // Text alignment - check for string type to handle figma.mixed symbol
    const textAlign = textNode.textAlignHorizontal;
    if (typeof textAlign === 'string') {
      if (textAlign === 'CENTER') styles.push('text-center');
      else if (textAlign === 'RIGHT') styles.push('text-right');
      else if (textAlign === 'JUSTIFIED') styles.push('text-justify');
    }

    // Letter spacing
    if (textNode.letterSpacing && typeof textNode.letterSpacing === 'object' && 'value' in textNode.letterSpacing) {
      const ls = textNode.letterSpacing as { value: number; unit: string };
      if (ls.value !== 0) {
        if (ls.unit === 'PERCENT') {
          styles.push(`tracking-[${(ls.value / 100).toFixed(2)}em]`);
        } else {
          styles.push(`tracking-[${ls.value}px]`);
        }
      }
    }

    // Text decoration
    if (textNode.textDecoration) {
      if (textNode.textDecoration === 'UNDERLINE') styles.push('underline');
      else if (textNode.textDecoration === 'STRIKETHROUGH') styles.push('line-through');
    }

    if (textNode.lineHeight && typeof textNode.lineHeight === 'object' && 'value' in textNode.lineHeight) {
      const lh = textNode.lineHeight as { value: number };
      const lhVal = lh.value;
      styles.push(`leading-[${Number.isInteger(lhVal) ? lhVal : parseFloat(lhVal.toFixed(2))}px]`);
    }

    // Text color
    if ('fills' in textNode && Array.isArray(textNode.fills)) {
      const fills = textNode.fills as Paint[];
      const solidFill = fills.find(f => f.type === 'SOLID');
      if (solidFill && solidFill.type === 'SOLID') {
        // Check if fill has opacity < 1
        if (solidFill.opacity !== undefined && solidFill.opacity < 1) {
          // Use rgba for text color with opacity
          const r = Math.round(solidFill.color.r * 255);
          const g = Math.round(solidFill.color.g * 255);
          const b = Math.round(solidFill.color.b * 255);
          styles.push(`text-[rgba(${r},${g},${b},${solidFill.opacity})]`);
        } else {
          const color = rgbToHex(solidFill.color);
          styles.push(`text-[${color}]`);
        }
      }
    }
  }

  // Border radius - check for mixed radii first
  if ('topLeftRadius' in node && 'topRightRadius' in node && 'bottomRightRadius' in node && 'bottomLeftRadius' in node) {
    const tl = (node as FrameNode).topLeftRadius || 0;
    const tr = (node as FrameNode).topRightRadius || 0;
    const br = (node as FrameNode).bottomRightRadius || 0;
    const bl = (node as FrameNode).bottomLeftRadius || 0;

    if (tl === tr && tr === br && br === bl && tl > 0) {
      styles.push(`rounded-[${tl}px]`);
    } else if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
      // Individual corners
      if (tl > 0) styles.push(`rounded-tl-[${tl}px]`);
      if (tr > 0) styles.push(`rounded-tr-[${tr}px]`);
      if (br > 0) styles.push(`rounded-br-[${br}px]`);
      if (bl > 0) styles.push(`rounded-bl-[${bl}px]`);
    }
  } else if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    styles.push(`rounded-[${node.cornerRadius}px]`);
  }

  // Borders/Strokes
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    const strokes = node.strokes as Paint[];
    const solidStroke = strokes.find(s => s.type === 'SOLID' && s.visible !== false);
    if (solidStroke && solidStroke.type === 'SOLID') {
      const strokeColor = rgbToHex(solidStroke.color);
      const strokeWeight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
      styles.push(`border-[${strokeWeight}px]`);
      styles.push(`border-[${strokeColor}]`);
    }
    // Gradient strokes are handled in generateJSX by wrapping the element in a
    // gradient-background div (the "box behind the box" approach).
  }

  // Opacity
  if ('opacity' in node && typeof node.opacity === 'number' && node.opacity < 1) {
    styles.push(`opacity-[${node.opacity}]`);
  }

  // Overflow/Clip
  if ('clipsContent' in node && node.clipsContent) {
    styles.push('overflow-hidden');
  }

  // Shadows/Effects
  if ('effects' in node && Array.isArray(node.effects)) {
    const effects = node.effects as Effect[];

    // Drop shadow
    const dropShadow = effects.find(e => e.type === 'DROP_SHADOW' && e.visible !== false);
    if (dropShadow && dropShadow.type === 'DROP_SHADOW') {
      const shadow = dropShadow as DropShadowEffect;
      const x = (shadow.offset && shadow.offset.x) || 0;
      const y = (shadow.offset && shadow.offset.y) || 0;
      const blur = shadow.radius || 0;
      const spread = shadow.spread || 0;
      const color = shadow.color ? `rgba(${Math.round(shadow.color.r * 255)},${Math.round(shadow.color.g * 255)},${Math.round(shadow.color.b * 255)},${shadow.color.a || 1})` : 'rgba(0,0,0,0.25)';
      styles.push(`shadow-[${x}px_${y}px_${blur}px_${spread}px_${color}]`);
    }

    // Inner shadow (using inset)
    const innerShadow = effects.find(e => e.type === 'INNER_SHADOW' && e.visible !== false);
    if (innerShadow && innerShadow.type === 'INNER_SHADOW') {
      const shadow = innerShadow as InnerShadowEffect;
      const x = (shadow.offset && shadow.offset.x) || 0;
      const y = (shadow.offset && shadow.offset.y) || 0;
      const blur = shadow.radius || 0;
      const color = shadow.color ? `rgba(${Math.round(shadow.color.r * 255)},${Math.round(shadow.color.g * 255)},${Math.round(shadow.color.b * 255)},${shadow.color.a || 1})` : 'rgba(0,0,0,0.25)';
      styles.push(`shadow-[inset_${x}px_${y}px_${blur}px_${color}]`);
    }

    // Layer blur
    const layerBlur = effects.find(e => e.type === 'LAYER_BLUR' && e.visible !== false);
    if (layerBlur && layerBlur.type === 'LAYER_BLUR') {
      const blur = (layerBlur as BlurEffect).radius || 0;
      styles.push(`blur-[${blur}px]`);
    }

    // Background blur (glassmorphism)
    // Figma's blur radius maps to roughly double the visual intensity in CSS backdrop-filter
    // (Figma radius ≈ 2σ, CSS blur() takes σ directly).
    // Additionally, if the element has a gradient fill that reaches full opacity, the fill
    // masks most of the blur — so we skip it entirely in that case, as the gradient overlay
    // is doing the visual work and the blur just adds unwanted haze in CSS.
    const bgBlur = effects.find(e => e.type === 'BACKGROUND_BLUR' && e.visible !== false);
    if (bgBlur && bgBlur.type === 'BACKGROUND_BLUR') {
      // Check if the node has a gradient fill that reaches full opacity (masks the blur)
      let fillMasksBlur = false;
      if ('fills' in node && Array.isArray(node.fills)) {
        const gradientFill = (node.fills as Paint[]).find(f =>
          (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') && f.visible !== false
        ) as GradientPaint | undefined;
        if (gradientFill && gradientFill.gradientStops) {
          const hasOpaqueStop = gradientFill.gradientStops.some(s => {
            const a = s.color.a !== undefined ? s.color.a : 1;
            return a >= 0.9;
          });
          const hasTransparentStop = gradientFill.gradientStops.some(s => {
            const a = s.color.a !== undefined ? s.color.a : 1;
            return a <= 0.1;
          });
          // Gradient goes from transparent to opaque — the opaque region hides the blur,
          // and the transparent region only reveals it in a narrow band. Use a minimal
          // 1px blur rather than the full converted value, since CSS blur renders much
          // stronger than Figma when most of the effect is masked by the gradient fill.
          if (hasOpaqueStop && hasTransparentStop) {
            fillMasksBlur = true;
          }
        }
      }
      if (fillMasksBlur) {
        styles.push(`backdrop-blur-[1px]`);
      } else {
        const blur = Math.round(((bgBlur as BlurEffect).radius || 0) / 2);
        styles.push(`backdrop-blur-[${blur}px]`);
      }
    }
  }

  // Rotation
  if ('rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0) {
    // Figma rotation is counter-clockwise, CSS rotate is clockwise
    const rotation = -node.rotation;
    styles.push(`rotate-[${rotation}deg]`);
  }

  // Min/Max width/height (from constraints)
  if ('minWidth' in node && typeof node.minWidth === 'number' && node.minWidth > 0) {
    styles.push(`min-w-[${Math.round(node.minWidth)}px]`);
  }
  if ('maxWidth' in node && typeof node.maxWidth === 'number' && node.maxWidth < 10000) {
    styles.push(`max-w-[${Math.round(node.maxWidth)}px]`);
  }
  if ('minHeight' in node && typeof node.minHeight === 'number' && node.minHeight > 0) {
    styles.push(`min-h-[${Math.round(node.minHeight)}px]`);
  }
  if ('maxHeight' in node && typeof node.maxHeight === 'number' && node.maxHeight < 10000) {
    styles.push(`max-h-[${Math.round(node.maxHeight)}px]`);
  }

  // Flex alignment (for auto-layout frames, skip GRID since it uses absolute positioning)
  if ('layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE' && node.layoutMode !== 'GRID') {
    // Main axis alignment
    if ('primaryAxisAlignItems' in node) {
      const align = node.primaryAxisAlignItems;
      if (align === 'CENTER') styles.push('justify-center');
      else if (align === 'MAX') styles.push('justify-end');
      else if (align === 'SPACE_BETWEEN') styles.push('justify-between');
    }
    // Cross axis alignment
    if ('counterAxisAlignItems' in node) {
      const align = node.counterAxisAlignItems;
      if (align === 'CENTER') {
        // When all children have the same cross-axis size as the container,
        // CENTER and MIN are visually identical in Figma. But in the browser,
        // items-center can shift items if content heights drift slightly
        // (e.g. font rendering). Use items-start for robustness in that case.
        let allChildrenMatchHeight = false;
        if ('children' in node && 'layoutMode' in node) {
          const children = (node as any).children as SceneNode[];
          const isHoriz = node.layoutMode === 'HORIZONTAL';
          const containerCross = isHoriz
            ? ('height' in node ? Math.round(node.height as number) : 0)
            : ('width' in node ? Math.round(node.width as number) : 0);
          if (containerCross > 0 && children.length > 0) {
            allChildrenMatchHeight = children.every((c: SceneNode) => {
              const childCross = isHoriz
                ? ('height' in c ? Math.round(c.height as number) : -1)
                : ('width' in c ? Math.round(c.width as number) : -1);
              return childCross === containerCross;
            });
          }
        }
        styles.push(allChildrenMatchHeight ? 'items-start' : 'items-center');
      }
      else if (align === 'MAX') styles.push('items-end');
    }
  }

  return styles;
}
