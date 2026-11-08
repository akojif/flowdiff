import type { WorkflowComparison } from '../diff/index.js';

/** Machine-readable output. Never truncated. Absent values are written as null. */
export function renderJson(
  comparisons: WorkflowComparison[],
  labels: { beforeLabel: string; afterLabel: string },
): string {
  const output = { before: labels.beforeLabel, after: labels.afterLabel, workflows: comparisons };
  return JSON.stringify(output, (_key, value: unknown) => (value === undefined ? null : value), 2);
}
