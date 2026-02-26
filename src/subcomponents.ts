import { SignificantChild, GENERIC_NAME_PATTERN, MAX_SUBCOMPONENT_DEPTH, MIN_COMPLEXITY_THRESHOLD } from './types';
import { toKebabCase } from './utils';

// Check if a node name is "significant" (not a generic Frame/Group name)
export function isSignificantName(name: string): boolean {
  return !GENERIC_NAME_PATTERN.test(name.trim());
}

// Count all descendant nodes recursively
export function countDescendants(node: SceneNode): number {
  let count = 1; // Count self
  if ('children' in node && node.children) {
    for (const child of node.children) {
      count += countDescendants(child);
    }
  }
  return count;
}

// Check if a node should be extracted as a subcomponent
export function isSignificantChild(node: SceneNode): boolean {
  // Must have a meaningful name
  if (!isSignificantName(node.name)) {
    return false;
  }

  // Must be a container type
  if (node.type !== 'FRAME' && node.type !== 'INSTANCE' && node.type !== 'COMPONENT') {
    return false;
  }

  // Must have children
  if (!('children' in node) || !node.children || node.children.length === 0) {
    return false;
  }

  // Must exceed complexity threshold (number of descendants)
  const descendantCount = countDescendants(node);
  if (descendantCount < MIN_COMPLEXITY_THRESHOLD) {
    return false;
  }

  return true;
}

// Recursively find significant children for hierarchical extraction
// Find all extractable children - returns both significant (complex) and simple children
// For complex parents, we want ALL children extracted, but only recurse into significant ones
export function findSignificantChildren(
  node: SceneNode,
  parentPath: string,
  depth: number
): SignificantChild[] {
  const results: SignificantChild[] = [];

  if (!('children' in node) || !node.children) {
    return results;
  }

  // First, check if this node has ANY significant children
  const hasComplexChildren = node.children.some(child => isSignificantChild(child));

  for (const child of node.children) {
    // Skip if too deep
    if (depth > MAX_SUBCOMPONENT_DEPTH) {
      continue;
    }

    // Skip non-extractable types
    if (child.type !== 'FRAME' && child.type !== 'COMPONENT' && child.type !== 'INSTANCE') {
      continue;
    }

    // Skip generic named frames
    if (!isSignificantName(child.name)) {
      // But still look inside for significant children
      if ('children' in child) {
        const nestedSignificant = findSignificantChildren(child, parentPath, depth);
        results.push(...nestedSignificant);
      }
      continue;
    }

    const childPath = parentPath ? `${parentPath}/${toKebabCase(child.name)}` : toKebabCase(child.name);

    // If parent has complex children, extract ALL named children (even simple ones)
    // Otherwise, only extract if this child is significant
    if (hasComplexChildren || isSignificantChild(child)) {
      results.push({
        node: child,
        path: childPath,
        depth: depth,
        uniqueName: child.name
      });
    } else if ('children' in child) {
      // Not extracting this one, but look inside for significant children
      const nestedSignificant = findSignificantChildren(child, childPath, depth + 1);
      results.push(...nestedSignificant);
    }
  }

  // Deduplicate sibling names: if multiple children share the same name,
  // append numeric suffixes (e.g. "Excel", "Excel2", "Excel3")
  const nameCounts = new Map<string, number>();
  for (const child of results) {
    const name = child.node.name;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const nameIndices = new Map<string, number>();
  for (const child of results) {
    const name = child.node.name;
    if (nameCounts.get(name)! > 1) {
      const idx = (nameIndices.get(name) || 0) + 1;
      nameIndices.set(name, idx);
      child.uniqueName = name + String(idx);
      // Also update the path to use the deduplicated name
      const kebab = toKebabCase(child.uniqueName);
      child.path = child.path.replace(/[^/]+$/, kebab);
    }
  }

  return results;
}
