import { structuredPatch } from 'diff';
import type { TextHunk, ValueChange } from './types.js';

const CONTEXT_LINES = 3;

export function isMultiLine(value: unknown): value is string {
  return typeof value === 'string' && value.includes('\n');
}

/**
 * Line-level diff of two strings. Line endings are compared separately, so a
 * CRLF/LF switch is flagged once instead of marking every line as changed.
 */
export function diffText(before: string, after: string): ValueChange & { type: 'text' } {
  const patch = structuredPatch('', '', before, after, undefined, undefined, {
    context: CONTEXT_LINES,
    stripTrailingCr: true,
  });
  const hunks: TextHunk[] = patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    // "\ No newline at end of file" markers are noise for parameter values.
    lines: hunk.lines.filter((line) => !line.startsWith('\\')),
  }));
  return {
    type: 'text',
    hunks,
    lineEndingsChanged: before.includes('\r\n') !== after.includes('\r\n'),
  };
}
