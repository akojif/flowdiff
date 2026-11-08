import type { PathSegment } from './types.js';

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

/** Formats a path as `a.b[0][label]`, quoting keys that are not plain identifiers. */
export function formatPath(path: PathSegment[]): string {
  return path
    .map((segment, i) => {
      if ('index' in segment) return `[${String(segment.index)}]`;
      if ('id' in segment) return `[${segment.label}]`;
      if (PLAIN_KEY.test(segment.key)) return i === 0 ? segment.key : `.${segment.key}`;
      return `[${JSON.stringify(segment.key)}]`;
    })
    .join('');
}
