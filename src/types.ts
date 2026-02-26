export interface ComponentConfig {
  id: string;
  name: string;
  title: string;
  children?: ComponentConfig[];
}

export interface ExtractedComponent {
  id: string;
  name: string;
  title: string;
  code: string;
  rawFigma: any;
  screenshot: Uint8Array | null;
  assets: Array<{ name: string; data: Uint8Array; format: string }>;
  metadata: any;
  subComponentPaths?: string[];
}

export interface SignificantChild {
  node: SceneNode;
  path: string;
  depth: number;
  uniqueName: string;
}

// Pattern to detect generic frame names that shouldn't be extracted as subcomponents
export const GENERIC_NAME_PATTERN = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Star|Polygon)(\s*\d*)?$/i;

// Minimum depth to start looking for subcomponents (direct children of root are depth 1)
export const MIN_SUBCOMPONENT_DEPTH = 1;
// Maximum depth to look for subcomponents
export const MAX_SUBCOMPONENT_DEPTH = 3;
// Minimum number of descendant nodes to warrant separate extraction
export const MIN_COMPLEXITY_THRESHOLD = 30;
