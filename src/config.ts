// Configurable asset path prefix used in generated src/url() attributes.
// Default: "/figma-assets" — override via setAssetPathPrefix() before extraction.
let assetPathPrefix = '/figma-assets';

export function getAssetPathPrefix(): string {
  return assetPathPrefix;
}

export function setAssetPathPrefix(prefix: string): void {
  // Normalize: strip trailing slash
  assetPathPrefix = prefix.replace(/\/+$/, '');
}
