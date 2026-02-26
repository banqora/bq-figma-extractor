// Logging helper - sends to both console and UI
export function log(level: 'info' | 'warning' | 'error', message: string, context?: Record<string, any>) {
  const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
  const fullMessage = `[${level.toUpperCase()}] ${message}${contextStr}`;

  console.log(fullMessage);

  figma.ui.postMessage({
    type: level === 'info' ? 'status' : level,
    message: fullMessage
  });
}

export function rgbToHex(color: RGB): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// Safely get a value, returning null if it's a symbol (mixed)
export function safeValue(val: any): any {
  if (typeof val === 'symbol') return null;
  return val;
}

// Escape special characters for JSX text content
export function escapeJSX(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;')
    // Preserve newlines as <br /> (literal \n in HTML/JSX collapses to whitespace)
    .replace(/\n/g, '<br />')
    // Preserve consecutive spaces — HTML collapses them, but Figma text
    // may use multiple spaces intentionally (e.g. gaps for overlaid highlights).
    // Replace every second+ consecutive space with &nbsp;.
    .replace(/ {2,}/g, (match) => ' ' + '\u00A0'.repeat(match.length - 1));
}

// Convert string to kebab-case for directory names
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
}

export function toPascalCase(str: string): string {
  // Remove leading non-letters, split on non-alphanumeric, capitalize each word
  return str
    .replace(/^[^a-zA-Z]+/, '')  // Remove leading non-letters (functions can't start with numbers)
    .split(/[^a-zA-Z0-9]+/)      // Split on non-alphanumeric
    .filter(Boolean)              // Remove empty strings
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}
