import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { diffWorkflows, type DiffOptions } from './diff-workflows.js';
import { findBrokenReferences, type BrokenReference } from './references.js';
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
  /** Whether the workflow is active, on the side named by `activeSide` (falling back to the other). */
  active: boolean;
  changes: Change[];
  /**
   * Problems in the after-side version of workflows that changed or exist only
   * on the after side, i.e. what push would send. Empty otherwise.
   */
  warnings: BrokenReference[];
}

export interface CompareOptions extends DiffOptions {
  /**
   * Which side decides `active`: the instance for local vs instance (where the
   * workflow actually runs), the later ref for git ranges. Default: after.
   */
  activeSide?: 'before' | 'after';
}

/**
 * Compares two sets of workflows keyed by id. Pure. Results are sorted by name,
 * then id, so output order is stable.
 */
export function compareWorkflowSets(
  before: ReadonlyMap<string, NormalizedWorkflow>,
  after: ReadonlyMap<string, NormalizedWorkflow>,
  options: CompareOptions = {},
): WorkflowComparison[] {
  const activeOf = (b: NormalizedWorkflow | undefined, a: NormalizedWorkflow | undefined) =>
    (options.activeSide === 'before' ? (b ?? a) : (a ?? b))?.active ?? false;

  const comparisons: WorkflowComparison[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    const changes = b === undefined ? [] : diffWorkflows(b, a, options);
    const status = b === undefined ? 'only-after' : changes.length > 0 ? 'changed' : 'unchanged';
    comparisons.push({
      id,
      name: a.name,
      status,
      active: activeOf(b, a),
      changes,
      warnings: status === 'unchanged' ? [] : findBrokenReferences(a),
    });
  }
  for (const [id, b] of before) {
    if (after.has(id)) continue;
    comparisons.push({
      id,
      name: b.name,
      status: 'only-before',
      active: activeOf(b, undefined),
      changes: [],
      warnings: [],
    });
  }
  return comparisons.sort((x, y) => compare(x.name, y.name) || compare(x.id, y.id));
}

/**
 * Local vs instance only (before = instance, after = local): a workflow only on
 * the instance is "untracked" (push never deletes, so it is not a removal), and
 * a local workflow with a pull record that is gone from the instance is
 * "deleted on instance", not a new workflow.
 */
export function labelInstanceStatuses(
  comparisons: WorkflowComparison[],
  pulledIds: ReadonlySet<string>,
): WorkflowComparison[] {
  return comparisons.map((comparison) => {
    if (comparison.status === 'only-before') return { ...comparison, status: 'untracked' };
    if (comparison.status === 'only-after' && pulledIds.has(comparison.id)) {
      return { ...comparison, status: 'deleted-on-instance' };
    }
    return comparison;
  });
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

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
