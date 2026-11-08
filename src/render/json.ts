import { classifyChange, countChanges, type WorkflowComparison } from '../diff/index.js';

/**
 * Machine-readable output. Never truncated, always lists every workflow, and
 * keeps the name/id order (not the display order). Absent values are written as null.
 */
export function renderJson(
  comparisons: WorkflowComparison[],
  labels: { beforeLabel: string; afterLabel: string },
): string {
  const workflows = comparisons.map((comparison) => ({
    ...comparison,
    counts: countChanges(comparison.changes),
    changes: comparison.changes.map((change) => ({ ...change, impact: classifyChange(change) })),
  }));
  const output = { before: labels.beforeLabel, after: labels.afterLabel, workflows };
  return JSON.stringify(output, (_key, value: unknown) => (value === undefined ? null : value), 2);
}
