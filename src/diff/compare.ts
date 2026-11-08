import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { diffWorkflows, type DiffOptions } from './diff-workflows.js';
import type { Change } from './types.js';

export type ComparisonStatus =
  | 'changed'
  | 'unchanged'
  | 'only-before'
  | 'only-after'
  /** Local vs instance: on the instance but not pulled. Push never touches these. */
  | 'untracked'
  /** Local vs instance: pulled before, but no longer on the instance. */
  | 'deleted-on-instance';

export interface WorkflowComparison {
  id: string;
  /** The after-side name when the workflow exists there, otherwise the before-side name. */
  name: string;
  status: ComparisonStatus;
  changes: Change[];
}

/**
 * Compares two sets of workflows keyed by id. Pure. Results are sorted by name,
 * then id, so output order is stable.
 */
export function compareWorkflowSets(
  before: ReadonlyMap<string, NormalizedWorkflow>,
  after: ReadonlyMap<string, NormalizedWorkflow>,
  options: DiffOptions = {},
): WorkflowComparison[] {
  const comparisons: WorkflowComparison[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (b === undefined) {
      comparisons.push({ id, name: a.name, status: 'only-after', changes: [] });
      continue;
    }
    const changes = diffWorkflows(b, a, options);
    comparisons.push({
      id,
      name: a.name,
      status: changes.length > 0 ? 'changed' : 'unchanged',
      changes,
    });
  }
  for (const [id, b] of before) {
    if (!after.has(id)) comparisons.push({ id, name: b.name, status: 'only-before', changes: [] });
  }
  return comparisons.sort((x, y) => compare(x.name, y.name) || compare(x.id, y.id));
}

/**
 * True if any workflow differs, including workflows present on only one side.
 * Untracked workflows do not count: push would never touch them.
 */
export function hasDifferences(comparisons: WorkflowComparison[]): boolean {
  return comparisons.some(
    (comparison) => comparison.status !== 'unchanged' && comparison.status !== 'untracked',
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
