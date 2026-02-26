import { SignificantChild } from './types';
import { toPascalCase, toKebabCase, escapeJSX } from './utils';
import { extractStyles, isPlainImageFill, getGradientBorderInfo, getTextColorSegments } from './styles';
import { findSignificantChildren } from './subcomponents';
import { getAssetPathPrefix } from './config';

// Parent offset info passed down to children for coordinate conversion.
// absoluteTransform is the parent's Figma absoluteTransform matrix ([[a,b,tx],[c,d,ty]])
// used to convert children's absoluteRenderBounds from page space to parent-local space.
type ParentOffset = {x: number, y: number, rotation?: number, absoluteTransform?: number[][] | null, parentIsRotated?: boolean};

// Adjust CSS left/top for rotated elements to account for the difference between
// Figma's rotation origin (top-left) and CSS's rotation origin (center).
// In Figma, rotation is applied around the element's top-left corner, so the
// reported x,y is the top-left position. In CSS, transform:rotate() rotates around
// the element's center. This function converts the Figma position to CSS position
// so the element visually appears in the same location.
export function adjustPositionForRotation(
  pos: { x: number; y: number },
  nodeWidth: number,
  nodeHeight: number,
  rotationDeg: number // Figma rotation in degrees (CCW)
): { x: number; y: number } {
  if (rotationDeg === 0) return pos;

  const theta = rotationDeg * Math.PI / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const hw = nodeWidth / 2;
  const hh = nodeHeight / 2;

  // Figma center = topLeft + R(θ) * (hw, hh)
  // CSS center = (left + hw, top + hh)
  // Therefore: left = figmaX + hw*(cosT - 1) - hh*sinT
  //            top  = figmaY + hw*sinT + hh*(cosT - 1)
  return {
    x: pos.x + hw * (cosT - 1) - hh * sinT,
    y: pos.y + hw * sinT + hh * (cosT - 1)
  };
}

// For rotated GROUP nodes, convert child positions from parent-frame space
// to GROUP-local space using inverse rotation.
// GROUP children in Figma have positions in the parent frame's coordinate space.
// For non-rotated GROUPs, simple subtraction of GROUP position works.
// For rotated GROUPs, we must apply the inverse of the GROUP's rotation transform.
export function computeGroupChildPosition(
  childX: number,
  childY: number,
  groupX: number,
  groupY: number,
  groupRotationDeg: number // Figma rotation in degrees (CCW)
): { x: number; y: number } {
  const dx = childX - groupX;
  const dy = childY - groupY;

  if (groupRotationDeg === 0) {
    return { x: dx, y: dy };
  }

  // Apply inverse rotation R(-θ) to convert parent-space offset to GROUP-local coordinates
  // Figma rotation convention: CCW in degrees (positive x rotates toward positive y)
  const theta = groupRotationDeg * Math.PI / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // R(-θ) = [[cos(θ), sin(θ)], [-sin(θ), cos(θ)]]
  return {
    x: cosT * dx + sinT * dy,
    y: -sinT * dx + cosT * dy
  };
}

// Compute CSS left/top for a child by inverse-transforming its absoluteRenderBounds
// center from page space to the parent's local coordinate space, then subtracting
// half the CSS-rendered size. This avoids the ambiguity of node.x/y for rotated nodes
// and directly uses Figma's absolute coordinate ground truth.
// Returns null if the necessary data is missing.
function inverseTransformPosition(
  childAbsRenderBounds: { x: number; y: number; width: number; height: number } | null,
  parentAbsTransform: number[][] | null | undefined,
  cssWidth: number,
  cssHeight: number
): { x: number; y: number } | null {
  if (!childAbsRenderBounds || !parentAbsTransform) return null;

  const a = parentAbsTransform[0][0];
  const b = parentAbsTransform[0][1];
  const tx = parentAbsTransform[0][2];
  const c = parentAbsTransform[1][0];
  const d = parentAbsTransform[1][1];
  const ty = parentAbsTransform[1][2];
  const det = a * d - b * c;

  if (Math.abs(det) < 0.0001) return null;

  // Inverse-transform the ARB center to parent-local space
  const arbCenterX = childAbsRenderBounds.x + (childAbsRenderBounds.width || 0) / 2;
  const arbCenterY = childAbsRenderBounds.y + (childAbsRenderBounds.height || 0) / 2;
  const localCenterX = (d * (arbCenterX - tx) - b * (arbCenterY - ty)) / det;
  const localCenterY = (-c * (arbCenterX - tx) + a * (arbCenterY - ty)) / det;

  // Subtract half the CSS-rendered size to get top-left for CSS left/top
  return {
    x: localCenterX - cssWidth / 2,
    y: localCenterY - cssHeight / 2
  };
}

// Generate React/Tailwind code from Figma node
export function generateReactCode(node: SceneNode, isSubComponent: boolean = false): string {
  const componentName = toPascalCase(node.name);

  // Build the component
  let code = `export default function ${componentName}() {\n`;
  code += `  return (\n`;
  code += generateJSX(node, 2);
  code += `  );\n`;
  code += `}\n`;

  return code;
}

export function generateJSX(node: SceneNode, indent: number = 0, parentUsesAbsolute: boolean = false, parentOffset: ParentOffset = {x: 0, y: 0}, parentHasAutoLayout: boolean = false, parentLayoutMode: string = 'NONE', ancestorRotation: number = 0, parentDimensions: {w: number, h: number} | null = null): string {
  const spaces = '  '.repeat(indent);

  if (!('children' in node)) {
    // Leaf node (text, rectangle, etc.)
    return generateLeafNode(node, indent, parentUsesAbsolute, parentOffset, parentHasAutoLayout, parentLayoutMode, ancestorRotation, parentDimensions);
  }

  // Check if this container should use absolute positioning for children
  // GROUP nodes or FRAME nodes without layoutMode use absolute positioning
  const isGroup = node.type === 'GROUP';
  const hasAutoLayout = 'layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE';
  const childrenUseAbsolute = isGroup || !hasAutoLayout;

  // Container node - pass parentHasAutoLayout to control sizing
  const styles = extractStyles(node, parentHasAutoLayout, parentLayoutMode);

  // If children use absolute positioning, make this container relative
  if (childrenUseAbsolute && !parentUsesAbsolute) {
    styles.push('relative');
  }

  // If this node should be absolutely positioned within its parent
  if (parentUsesAbsolute && 'x' in node && 'y' in node) {
    styles.push('absolute');
    const nodeRotation = ('rotation' in node && typeof node.rotation === 'number') ? node.rotation : 0;
    const nodeW = 'width' in node ? (node.width as number) : 0;
    const nodeH = 'height' in node ? (node.height as number) : 0;

    // For rotated children of rotated parents, use inverse-transform of absoluteRenderBounds
    // to get accurate CSS left/top. When both parent and child have rotation,
    // adjustPositionForRotation doesn't correctly account for the compound transform.
    // Non-rotated children use simple x/y subtraction (correct in parent-local space).
    const childARB = 'absoluteRenderBounds' in node ? (node as any).absoluteRenderBounds : null;
    const invPos = (nodeRotation !== 0 && parentOffset.parentIsRotated)
      ? inverseTransformPosition(childARB, parentOffset.absoluteTransform, nodeW, nodeH)
      : null;

    if (invPos) {
      const r1 = (v: number) => Math.round(v * 10) / 10;
      styles.push(`left-[${r1(invPos.x)}px]`);
      styles.push(`top-[${r1(invPos.y)}px]`);
    } else {
      let pos = parentOffset.rotation
        ? computeGroupChildPosition(node.x as number, node.y as number, parentOffset.x, parentOffset.y, parentOffset.rotation)
        : { x: (node.x as number) - parentOffset.x, y: (node.y as number) - parentOffset.y };
      // Adjust for Figma vs CSS rotation origin difference
      if (nodeRotation !== 0) {
        pos = adjustPositionForRotation(pos, nodeW, nodeH, nodeRotation);
      }
      const adjustedX = Math.round(pos.x) || 0;
      const adjustedY = Math.round(pos.y) || 0;
      styles.push(`left-[${adjustedX}px]`);
      styles.push(`top-[${adjustedY}px]`);
    }
  }

  const className = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';

  // Check for gradient stroke — wrap with a background div to simulate gradient border
  const gradientBorder = getGradientBorderInfo(node);

  let jsx = '';
  if (gradientBorder) {
    // Outer wrapper: gradient background, padded by stroke weight, same border radius
    const outerRadius = gradientBorder.borderRadius;
    const outerStyles = [
      `relative`,
      `bg-[${gradientBorder.gradientCss}]`,
      `p-[${gradientBorder.strokeWeight}px]`,
      `rounded-[${outerRadius}px]`,
    ];
    // Transfer positioning styles from inner to outer so layout stays correct
    const positioningPrefixes = ['absolute', 'left-[', 'top-[', 'right-[', 'bottom-['];
    for (let i = styles.length - 1; i >= 0; i--) {
      if (positioningPrefixes.some(p => styles[i].startsWith(p))) {
        outerStyles.push(styles[i]);
        styles.splice(i, 1);
      }
    }
    const outerClassName = ` className="${outerStyles.join(' ')}"`;
    const innerClassName = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';
    jsx += `${spaces}<div${outerClassName}>\n`;
    jsx += `${spaces}  <div${innerClassName} data-node-id="${node.id}">\n`;
  } else {
    jsx += `${spaces}<div${className} data-node-id="${node.id}">\n`;
  }

  // Process children
  // For GROUP nodes, children positions are relative to the GROUP's parent,
  // so we need to pass the GROUP's position as an offset (with rotation for rotated GROUPs)
  if ('children' in node && node.children) {
    // Pass this node's absoluteTransform so vector children can convert
    // absoluteRenderBounds from page space to parent-local coordinates.
    const nodeAbsTransform = 'absoluteTransform' in node ? (node as any).absoluteTransform : null;
    const nodeIsRotated = 'rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0;
    let childOffset: ParentOffset = {x: 0, y: 0, absoluteTransform: nodeAbsTransform, parentIsRotated: nodeIsRotated};
    if (isGroup && 'x' in node && 'y' in node) {
      const groupRotation = ('rotation' in node && typeof node.rotation === 'number') ? node.rotation : 0;
      childOffset = {x: node.x as number, y: node.y as number, rotation: groupRotation !== 0 ? groupRotation : undefined, absoluteTransform: nodeAbsTransform, parentIsRotated: nodeIsRotated};
    }
    // When a gradient stroke is moved to an outer wrapper, Figma's inside stroke
    // insets children by the stroke weight. Compensate by shifting children back.
    if (gradientBorder) {
      childOffset = {x: childOffset.x + gradientBorder.strokeWeight, y: childOffset.y + gradientBorder.strokeWeight, rotation: childOffset.rotation, absoluteTransform: childOffset.absoluteTransform, parentIsRotated: childOffset.parentIsRotated};
    }
    // Track accumulated CSS rotation from ancestors for VECTOR counter-rotation
    const nodeCssRotation = ('rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0) ? -node.rotation : 0;
    const childAncestorRotation = ancestorRotation + nodeCssRotation;
    const currentLayoutMode = 'layoutMode' in node && node.layoutMode ? (node.layoutMode as string) : 'NONE';
    const innerIndent = gradientBorder ? indent + 2 : indent + 1;
    // Pass this node's dimensions if it introduces CSS rotation, so children can
    // set transform-origin for correct counter-rotation around the parent's center
    const nodeW = 'width' in node ? (node.width as number) : 0;
    const nodeH = 'height' in node ? (node.height as number) : 0;
    const childParentDims = nodeCssRotation !== 0 ? {w: nodeW, h: nodeH} : parentDimensions;
    for (const child of node.children) {
      jsx += generateJSX(child, innerIndent, childrenUseAbsolute, childOffset, hasAutoLayout, currentLayoutMode, childAncestorRotation, childParentDims);
    }
  }

  if (gradientBorder) {
    jsx += `${spaces}  </div>\n`;
    jsx += `${spaces}</div>\n`;
  } else {
    jsx += `${spaces}</div>\n`;
  }

  return jsx;
}

export function generateLeafNode(node: SceneNode, indent: number, parentUsesAbsolute: boolean = false, parentOffset: ParentOffset = {x: 0, y: 0}, parentHasAutoLayout: boolean = false, parentLayoutMode: string = 'NONE', ancestorRotation: number = 0, parentDimensions: {w: number, h: number} | null = null): string {
  const spaces = '  '.repeat(indent);

  // Helper to add absolute positioning if needed
  function addAbsolutePositioning(styles: string[]): string[] {
    if (parentUsesAbsolute && 'x' in node && 'y' in node) {
      styles.push('absolute');
      const nodeRotation = ('rotation' in node && typeof node.rotation === 'number') ? node.rotation : 0;
      const nodeW = 'width' in node ? (node.width as number) : 0;
      const nodeH = 'height' in node ? (node.height as number) : 0;

      // For rotated children of rotated parents, use inverse-transform of absoluteRenderBounds
      const childARB = 'absoluteRenderBounds' in node ? (node as any).absoluteRenderBounds : null;
      const invPos = (nodeRotation !== 0 && parentOffset.parentIsRotated)
        ? inverseTransformPosition(childARB, parentOffset.absoluteTransform, nodeW, nodeH)
        : null;

      if (invPos) {
        const r1 = (v: number) => Math.round(v * 10) / 10;
        styles.push(`left-[${r1(invPos.x)}px]`);
        styles.push(`top-[${r1(invPos.y)}px]`);
      } else {
        let pos = parentOffset.rotation
          ? computeGroupChildPosition(node.x as number, node.y as number, parentOffset.x, parentOffset.y, parentOffset.rotation)
          : { x: (node.x as number) - parentOffset.x, y: (node.y as number) - parentOffset.y };
        if (nodeRotation !== 0) {
          pos = adjustPositionForRotation(pos, nodeW, nodeH, nodeRotation);
        }
        const adjustedX = Math.round(pos.x) || 0;
        const adjustedY = Math.round(pos.y) || 0;
        styles.push(`left-[${adjustedX}px]`);
        styles.push(`top-[${adjustedY}px]`);
      }
    }
    return styles;
  }

  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    let styles = extractStyles(node, parentHasAutoLayout, parentLayoutMode);
    styles = addAbsolutePositioning(styles);
    // Add whitespace-nowrap for single-line text in flex containers to prevent wrapping
    // Detect single-line by comparing height to lineHeight (single line = height <= ~1.5x lineHeight)
    if (parentHasAutoLayout) {
      // lineHeight can be figma.mixed, { unit: 'AUTO' }, or { unit: 'PIXELS'/'PERCENT', value: number }
      const fontSize = typeof textNode.fontSize === 'number' ? textNode.fontSize : 16;
      let lineHeightPx = fontSize * 1.2; // default fallback
      const lh = textNode.lineHeight;
      if (typeof lh === 'object' && lh !== null && 'unit' in lh && 'value' in lh) {
        const lhObj = lh as { unit: string; value: number };
        if (lhObj.unit === 'PIXELS') {
          lineHeightPx = lhObj.value;
        } else if (lhObj.unit === 'PERCENT') {
          lineHeightPx = fontSize * (lhObj.value / 100);
        }
      }
      const isSingleLine = textNode.height <= lineHeightPx * 1.5;
      if (isSingleLine) {
        styles.push('whitespace-nowrap');
      }
    }
    const className = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';

    // Check for mixed text colors/styles/weights/sizes
    const segments = getTextColorSegments(textNode);
    if (segments.length > 1) {
      // Multiple segments - wrap each in a span with appropriate styles
      let content = '';
      for (const seg of segments) {
        const inlineStyles: string[] = [];
        if (seg.color) inlineStyles.push(`color: '${seg.color}'`);
        if (seg.fontSize) inlineStyles.push(`fontSize: '${seg.fontSize}px'`);
        const segStyle = inlineStyles.length > 0 ? ` style={{ ${inlineStyles.join(', ')} }}` : '';
        const classNames: string[] = [];
        if (seg.isItalic) classNames.push('italic');
        if (seg.fontWeight && seg.fontWeight >= 700) classNames.push('font-bold');
        else if (seg.fontWeight && seg.fontWeight >= 600) classNames.push('font-semibold');
        else if (seg.fontWeight && seg.fontWeight >= 500) classNames.push('font-medium');
        const segClass = classNames.length > 0 ? ` className="${classNames.join(' ')}"` : '';
        content += `<span${segStyle}${segClass}>${escapeJSX(seg.text)}</span>`;
      }
      return `${spaces}<p${className} data-node-id="${node.id}">${content}</p>\n`;
    }

    return `${spaces}<p${className} data-node-id="${node.id}">${escapeJSX(textNode.characters)}</p>\n`;
  }

  if (node.type === 'RECTANGLE' && 'fills' in node && Array.isArray(node.fills)) {
    const fills = node.fills as Paint[];
    const hasImageFill = fills.some(f => f.type === 'IMAGE' && f.visible !== false);

    if (hasImageFill) {
      const plainCheck = isPlainImageFill(node);

      if (plainCheck.plain) {
        // Plain image fill — use getImageByHash source with CSS object-cover
        let styles = extractStyles(node, parentHasAutoLayout, parentLayoutMode);
        styles = addAbsolutePositioning(styles);
        styles.push('object-cover');
        // When absolutely positioned with negative offset, the image overflows the parent.
        // Browsers constrain absolute img width to the containing block, so swap w-[] for
        // min-w-[] to force the full size and let overflow-hidden clip it.
        if (parentUsesAbsolute && 'x' in node && 'y' in node) {
          const pos = parentOffset.rotation
            ? computeGroupChildPosition(node.x as number, node.y as number, parentOffset.x, parentOffset.y, parentOffset.rotation)
            : { x: (node.x as number) - parentOffset.x, y: (node.y as number) - parentOffset.y };
          if (pos.x < 0 || pos.y < 0) {
            styles = styles.map(s => s.startsWith('w-[') ? s.replace('w-[', 'min-w-[') : s);
          }
        }
        const className = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';
        return `${spaces}<img${className} src="${getAssetPathPrefix()}/${plainCheck.imageHash}.png" alt="" data-node-id="${node.id}" />\n`;
      }

      // Complex fill — exported via exportAsync which bakes in crop, zoom, effects.
      // exportAsync clips to the parent's visible bounds, so the PNG dimensions
      // may not match the Figma node dimensions. For absolutely positioned images,
      // compute the clipped position (where the visible portion starts) and skip
      // w/h — the PNG is already at the correct clipped size.
      const safeId = node.id.replace(/[^a-zA-Z0-9]/g, '_');
      if (parentUsesAbsolute && 'x' in node && 'y' in node) {
        const pos = parentOffset.rotation
          ? computeGroupChildPosition(node.x as number, node.y as number, parentOffset.x, parentOffset.y, parentOffset.rotation)
          : { x: (node.x as number) - parentOffset.x, y: (node.y as number) - parentOffset.y };
        const clippedX = Math.round(Math.max(0, pos.x));
        const clippedY = Math.round(Math.max(0, pos.y));
        return `${spaces}<img className="absolute left-[${clippedX}px] top-[${clippedY}px]" src="${getAssetPathPrefix()}/img_${safeId}.png" alt="" data-node-id="${node.id}" />\n`;
      }

      let styles = extractStyles(node, parentHasAutoLayout, parentLayoutMode);
      const className = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';
      return `${spaces}<img${className} src="${getAssetPathPrefix()}/img_${safeId}.png" alt="" data-node-id="${node.id}" />\n`;
    }
  }

  // For VECTOR nodes (icons), export as SVG image
  // Note: Figma's exportAsync includes visual transformations (rotation) in the exported SVG paths
  // So we should NOT apply CSS rotation - the SVG is already in its final visual state
  // However, we need to adjust position because Figma reports unrotated bounding box position
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'LINE' || node.type === 'STAR' || node.type === 'POLYGON' || node.type === 'ELLIPSE') {
    let styles: string[] = [];

    const figmaRotation = 'rotation' in node ? (node.rotation as number) : 0;
    const nodeWidth = 'width' in node ? (node.width as number) : 0;
    const nodeHeight = 'height' in node ? (node.height as number) : 0;
    const safeId = node.id.replace(/[^a-zA-Z0-9]/g, '_');

    // Handle line-like vectors in auto-layout containers.
    // Problem: SVG exports of line vectors have inflated bounding boxes (stroke width +
    // rotation angle artifacts), e.g. a horizontal line exports as 224×13px SVG instead
    // of 224×~0px. When rendered as <img> in a flex container, the intrinsic SVG dimensions
    // inflate the layout spacing (each line takes 13px + gap instead of just gap).
    // Fix: Use negative margins to collapse the inflated cross-axis dimension so the flex
    // item matches Figma's layout contribution (~0px in the stacking direction).
    if (parentHasAutoLayout && (nodeWidth < 1 || nodeHeight < 1)) {
      const isVerticalLayout = parentLayoutMode === 'VERTICAL';
      const strokeWeight = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : 0;
      const lineLength = Math.max(nodeWidth, nodeHeight);
      const inflatedSize = lineLength * Math.abs(Math.sin(ancestorRotation * Math.PI / 180)) + strokeWeight;
      const halfInflated = Math.round(inflatedSize / 2);
      const imgStyles: string[] = ['shrink-0'];
      if (halfInflated > 0) {
        imgStyles.push(isVerticalLayout ? `-my-[${halfInflated}px]` : `-mx-[${halfInflated}px]`);
      }
      if (ancestorRotation !== 0) {
        imgStyles.push(`rotate-[${-ancestorRotation}deg]`);
      }
      const imgClassName = ` className="${imgStyles.join(' ')}"`;
      return `${spaces}<img${imgClassName} src="${getAssetPathPrefix()}/icon_${safeId}.svg" alt="${node.name}" data-node-id="${node.id}" />\n`;
    }

    // Position rotated vectors using absoluteRenderBounds + parent's absoluteTransform.
    // The SVG export bakes in the vector's rotation, so x/y/width/height (pre-rotation)
    // don't directly correspond to where the visual content appears.
    // absoluteRenderBounds gives the visible content bounds in page space, and we use
    // the parent's absoluteTransform to convert to parent-local coordinates (= CSS left/top).
    let ownRotationAdjusted = false;

    if ('x' in node && 'y' in node && parentUsesAbsolute) {
      let adjustedX: number;
      let adjustedY: number;

      // For rotated vectors, use absoluteRenderBounds + inverse parent transform.
      // absoluteRenderBounds gives the visible content bounds in page space (matching SVG export).
      // parentOffset.absoluteTransform is the parent's absolute transform matrix passed from the parent.
      const nodeRenderBounds = 'absoluteRenderBounds' in node ? (node as any).absoluteRenderBounds : null;
      const parentAbsTransform = parentOffset.absoluteTransform;

      const useInverseTransform = figmaRotation !== 0 && nodeRenderBounds && parentAbsTransform && !parentOffset.rotation;
      if (useInverseTransform) {
        // Inverse-map from page space to parent's local coordinate space.
        // For vectors, the SVG export matches absoluteRenderBounds dimensions,
        // so use ARB width/height as the CSS-rendered size.
        const arbW = nodeRenderBounds.width || 0;
        const arbH = nodeRenderBounds.height || 0;
        const invPos = inverseTransformPosition(nodeRenderBounds, parentAbsTransform, arbW, arbH);

        if (invPos) {
          adjustedX = invPos.x;
          adjustedY = invPos.y;
          ownRotationAdjusted = true;
        } else {
          // Degenerate transform, fallback to local coordinates
          const pos = parentOffset.rotation
            ? computeGroupChildPosition(node.x as number, node.y as number, parentOffset.x, parentOffset.y, parentOffset.rotation)
            : { x: (node.x as number) - parentOffset.x, y: (node.y as number) - parentOffset.y };
          adjustedX = pos.x;
          adjustedY = pos.y;
        }
      } else {
        // Non-rotated or missing bounds: use local coordinates
        const pos = parentOffset.rotation
          ? computeGroupChildPosition(node.x as number, node.y as number, parentOffset.x, parentOffset.y, parentOffset.rotation)
          : { x: (node.x as number) - parentOffset.x, y: (node.y as number) - parentOffset.y };
        adjustedX = pos.x;
        adjustedY = pos.y;
      }

      styles.push(`absolute`);
      if (ownRotationAdjusted) {
        // Use sub-pixel precision for inverse-transform positions to minimize
        // cumulative rounding error from ARB↔SVG dimension mismatch
        const r1 = (v: number) => Math.round(v * 10) / 10;
        styles.push(`left-[${r1(adjustedX)}px]`);
        styles.push(`top-[${r1(adjustedY)}px]`);
      } else {
        styles.push(`left-[${Math.round(adjustedX)}px]`);
        styles.push(`top-[${Math.round(adjustedY)}px]`);
      }
    } else {
      styles = addAbsolutePositioning(styles);
    }

    // For auto-layout children, set explicit dimensions so the SVG renders at the
    // Figma-intended size rather than its intrinsic SVG dimensions (which may differ
    // due to viewBox/stroke inflation).
    // NOTE: Do NOT set dimensions for absolutely positioned vectors — the SVG export
    // from Figma already has the correct visual dimensions baked in, and the Figma node
    // dimensions may not match (e.g., ellipses with thick strokes get clipped by mask).
    if (parentHasAutoLayout) {
      const w = Math.round(nodeWidth);
      const h = Math.round(nodeHeight);
      if (w > 0) styles.push(`w-[${w}px]`);
      if (h > 0) styles.push(`h-[${h}px]`);
    }

    // Counter-rotate to undo ancestor CSS rotations that are already baked into the SVG
    if (ancestorRotation !== 0) {
      styles.push(`rotate-[${-ancestorRotation}deg]`);

      // Adjust left/top to compensate for the CSS counter-rotation shifting the
      // visual position (CSS rotates around center, not top-left).
      // Skip if the node's own rotation already triggered a position adjustment above,
      // since that adjustment already accounts for the baked-in rotation offset.
      if (!ownRotationAdjusted) {
        const leftIdx = styles.findIndex(s => s.startsWith('left-['));
        const topIdx = styles.findIndex(s => s.startsWith('top-['));
        if (leftIdx !== -1 && topIdx !== -1) {
          const currentLeft = parseFloat(styles[leftIdx].replace('left-[', '').replace('px]', ''));
          const currentTop = parseFloat(styles[topIdx].replace('top-[', '').replace('px]', ''));
          const adjusted = adjustPositionForRotation(
            { x: currentLeft, y: currentTop },
            nodeWidth, nodeHeight,
            ancestorRotation
          );
          styles[leftIdx] = `left-[${Math.round(adjusted.x)}px]`;
          styles[topIdx] = `top-[${Math.round(adjusted.y)}px]`;
        }
      }
    }

    const className = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';
    // Use SVG asset path - vectors are exported as SVGs by the asset extraction
    return `${spaces}<img${className} src="${getAssetPathPrefix()}/icon_${safeId}.svg" alt="${node.name}" data-node-id="${node.id}" />\n`;
  }

  // Generic div for other nodes
  let styles = extractStyles(node, parentHasAutoLayout, parentLayoutMode);
  styles = addAbsolutePositioning(styles);
  const className = styles.length > 0 ? ` className="${styles.join(' ')}"` : '';
  return `${spaces}<div${className} data-node-id="${node.id}"></div>\n`;
}

// Generate main component code with imports based on significant children
// Also renders non-subcomponent children (e.g., background images, decorative elements) inline
export function generateMainComponentCodeFromChildren(node: SceneNode, significantChildren: SignificantChild[]): string {
  const componentName = toPascalCase(node.name);

  if (significantChildren.length === 0) {
    // No subcomponents, generate regular code
    return generateReactCode(node, false);
  }

  // Extract actual styles from the Figma node instead of hardcoding
  const styles = extractStyles(node, false);
  // Ensure flex layout is present for stacking children
  const hasAutoLayout = 'layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE';
  const isHorizontal = 'layoutMode' in node && node.layoutMode === 'HORIZONTAL';
  if (styles.indexOf('flex') === -1) {
    if (hasAutoLayout) {
      if (isHorizontal) {
        styles.unshift('flex');
      } else {
        styles.unshift('flex', 'flex-col');
      }
    } else {
      styles.unshift('flex', 'flex-col');
    }
  }

  // If children use absolute positioning, make this container relative
  const isGroup = node.type === 'GROUP';
  const childrenUseAbsolute = isGroup || !hasAutoLayout;
  if (childrenUseAbsolute) {
    styles.push('relative');
  }

  const className = styles.join(' ');

  // Build map of significant child IDs to unique names for deduplication
  const significantIdToUniqueName = new Map<string, string>();
  for (const child of significantChildren) {
    significantIdToUniqueName.set(child.node.id, child.uniqueName);
  }

  // Generate imports for subcomponents
  let code = '// This component has been split into subcomponents for easier implementation\n';
  code += '// See the subfolders for individual component implementations\n\n';

  for (const child of significantChildren) {
    const subComponentName = toPascalCase(child.uniqueName);
    code += `import ${subComponentName} from './${toKebabCase(child.uniqueName)}/component';\n`;
  }

  code += '\n';
  code += `export default function ${componentName}() {\n`;
  code += `  return (\n`;
  code += `    <div className="${className}" data-node-id="${node.id}">\n`;

  // Compute child offset for GROUP nodes (children positions are relative to GROUP's parent)
  const nodeAbsTransform2 = 'absoluteTransform' in node ? (node as any).absoluteTransform : null;
  const nodeIsRotated2 = 'rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0;
  let childOffset: ParentOffset = {x: 0, y: 0, absoluteTransform: nodeAbsTransform2, parentIsRotated: nodeIsRotated2};
  if (isGroup && 'x' in node && 'y' in node) {
    const groupRotation = ('rotation' in node && typeof node.rotation === 'number') ? node.rotation : 0;
    childOffset = {x: node.x as number, y: node.y as number, rotation: groupRotation !== 0 ? groupRotation : undefined, absoluteTransform: nodeAbsTransform2, parentIsRotated: nodeIsRotated2};
  }

  // Track CSS rotation from root node for VECTOR counter-rotation
  const rootCssRotation = ('rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0) ? -node.rotation : 0;

  // Render ALL children in order, mixing inline JSX and subcomponent references
  if ('children' in node && node.children) {
    const currentLayoutMode = 'layoutMode' in node && node.layoutMode ? (node.layoutMode as string) : 'NONE';
    for (const child of node.children) {
      const uniqueName = significantIdToUniqueName.get(child.id);
      if (uniqueName) {
        // Render as imported subcomponent using deduplicated name
        const subComponentName = toPascalCase(uniqueName);
        if (childrenUseAbsolute && 'x' in child && 'y' in child) {
          // Subcomponent needs absolute positioning within parent
          // Use inverse-transform for rotated children of rotated parents
          const childARB = 'absoluteRenderBounds' in child ? (child as any).absoluteRenderBounds : null;
          const childW = 'width' in child ? (child.width as number) : 0;
          const childH = 'height' in child ? (child.height as number) : 0;
          const childRotation = ('rotation' in child && typeof child.rotation === 'number') ? child.rotation : 0;
          const invPos = (childRotation !== 0 && nodeIsRotated2)
            ? inverseTransformPosition(childARB, nodeAbsTransform2, childW, childH)
            : null;

          if (invPos) {
            const r1 = (v: number) => Math.round(v * 10) / 10;
            code += `      <div className="absolute left-[${r1(invPos.x)}px] top-[${r1(invPos.y)}px]">\n`;
          } else {
            const pos = childOffset.rotation
              ? computeGroupChildPosition(child.x as number, child.y as number, childOffset.x, childOffset.y, childOffset.rotation)
              : { x: (child.x as number) - childOffset.x, y: (child.y as number) - childOffset.y };
            const adjustedX = Math.round(pos.x) || 0;
            const adjustedY = Math.round(pos.y) || 0;
            code += `      <div className="absolute left-[${adjustedX}px] top-[${adjustedY}px]">\n`;
          }
          code += `        <${subComponentName} />\n`;
          code += `      </div>\n`;
        } else {
          code += `      <${subComponentName} />\n`;
        }
      } else {
        // Render inline (background images, decorative rectangles, etc.)
        code += generateJSX(child, 3, childrenUseAbsolute, childOffset, hasAutoLayout, currentLayoutMode, rootCssRotation);
      }
    }
  }

  code += `    </div>\n`;
  code += `  );\n`;
  code += `}\n`;

  return code;
}

// Generate code for subcomponent with imports (flat version - just names)
// Also renders non-subcomponent children inline (background images, decorative elements, etc.)
export function generateSubComponentCodeFlat(node: SceneNode, nestedChildren: SignificantChild[]): string {
  const componentName = toPascalCase(node.name);

  // Extract actual styles from the Figma node instead of hardcoding
  const styles = extractStyles(node, false);
  // Ensure flex layout is present for stacking children
  const hasAutoLayout = 'layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE';
  const isHorizontal = 'layoutMode' in node && node.layoutMode === 'HORIZONTAL';
  if (styles.indexOf('flex') === -1) {
    if (hasAutoLayout) {
      if (isHorizontal) {
        styles.unshift('flex');
      } else {
        styles.unshift('flex', 'flex-col');
      }
    } else {
      styles.unshift('flex', 'flex-col');
    }
  }

  // If children use absolute positioning, make this container relative
  const isGroup = node.type === 'GROUP';
  const childrenUseAbsolute = isGroup || !hasAutoLayout;
  if (childrenUseAbsolute) {
    styles.push('relative');
  }

  const className = styles.join(' ');

  // Build map of nested child IDs to unique names for deduplication
  const nestedIdToUniqueName = new Map<string, string>();
  for (const child of nestedChildren) {
    nestedIdToUniqueName.set(child.node.id, child.uniqueName);
  }

  let code = '// This subcomponent imports nested components\n\n';

  for (const child of nestedChildren) {
    const subComponentName = toPascalCase(child.uniqueName);
    const relativePath = `./${toKebabCase(child.uniqueName)}`;
    code += `import ${subComponentName} from '${relativePath}/component';\n`;
  }

  code += '\n';
  code += `export default function ${componentName}() {\n`;
  code += `  return (\n`;
  code += `    <div className="${className}" data-node-id="${node.id}">\n`;

  // Compute child offset for GROUP nodes (children positions are relative to GROUP's parent)
  const nodeAbsTransform3 = 'absoluteTransform' in node ? (node as any).absoluteTransform : null;
  const nodeIsRotated3 = 'rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0;
  let childOffset: ParentOffset = {x: 0, y: 0, absoluteTransform: nodeAbsTransform3, parentIsRotated: nodeIsRotated3};
  if (isGroup && 'x' in node && 'y' in node) {
    const groupRotation = ('rotation' in node && typeof node.rotation === 'number') ? node.rotation : 0;
    childOffset = {x: node.x as number, y: node.y as number, rotation: groupRotation !== 0 ? groupRotation : undefined, absoluteTransform: nodeAbsTransform3, parentIsRotated: nodeIsRotated3};
  }

  // Track CSS rotation from root node for VECTOR counter-rotation
  const rootCssRotation = ('rotation' in node && typeof node.rotation === 'number' && node.rotation !== 0) ? -node.rotation : 0;

  // Render ALL children in order, mixing inline JSX and subcomponent references
  if ('children' in node && node.children) {
    const currentLayoutMode = 'layoutMode' in node && node.layoutMode ? (node.layoutMode as string) : 'NONE';
    for (const child of node.children) {
      const uniqueName = nestedIdToUniqueName.get(child.id);
      if (uniqueName) {
        // Render as imported subcomponent using deduplicated name
        const subComponentName = toPascalCase(uniqueName);
        if (childrenUseAbsolute && 'x' in child && 'y' in child) {
          // Subcomponent needs absolute positioning within parent
          // Use inverse-transform for rotated children of rotated parents
          const childARB = 'absoluteRenderBounds' in child ? (child as any).absoluteRenderBounds : null;
          const childW = 'width' in child ? (child.width as number) : 0;
          const childH = 'height' in child ? (child.height as number) : 0;
          const childRotation = ('rotation' in child && typeof child.rotation === 'number') ? child.rotation : 0;
          const invPos = (childRotation !== 0 && nodeIsRotated3)
            ? inverseTransformPosition(childARB, nodeAbsTransform3, childW, childH)
            : null;

          if (invPos) {
            const r1 = (v: number) => Math.round(v * 10) / 10;
            code += `      <div className="absolute left-[${r1(invPos.x)}px] top-[${r1(invPos.y)}px]">\n`;
          } else {
            const pos = childOffset.rotation
              ? computeGroupChildPosition(child.x as number, child.y as number, childOffset.x, childOffset.y, childOffset.rotation)
              : { x: (child.x as number) - childOffset.x, y: (child.y as number) - childOffset.y };
            const adjustedX = Math.round(pos.x) || 0;
            const adjustedY = Math.round(pos.y) || 0;
            code += `      <div className="absolute left-[${adjustedX}px] top-[${adjustedY}px]">\n`;
          }
          code += `        <${subComponentName} />\n`;
          code += `      </div>\n`;
        } else {
          code += `      <${subComponentName} />\n`;
        }
      } else {
        // Render inline (background images, decorative rectangles, etc.)
        code += generateJSX(child, 3, childrenUseAbsolute, childOffset, hasAutoLayout, currentLayoutMode, rootCssRotation);
      }
    }
  }

  code += `    </div>\n`;
  code += `  );\n`;
  code += `}\n`;

  return code;
}
