import type { Change } from './types.js';

export type Impact = 'behavior' | 'cosmetic';

/** Node fields that only affect how the workflow looks in the editor. */
const COSMETIC_NODE_PROPERTIES = new Set(['notes', 'notesInFlow']);

/**
 * Whether a change can affect what the workflow does when it runs. Anything not
 * known to be cosmetic counts as behavior, so new kinds of change are never
 * played down by accident.
 *
 * Node renames are cosmetic: when n8n rewrites expressions that used the old
 * name, those show up as separate (behavior) parameter changes.
 */
export function classifyChange(change: Change): Impact {
  switch (change.kind) {
    case 'workflow-renamed':
    case 'node-renamed':
    case 'node-moved':
    case 'tag-added':
    case 'tag-removed':
    case 'group-added':
    case 'group-removed':
    case 'group-renamed':
    case 'group-description-changed':
    case 'group-node-joined':
    case 'group-node-left':
      return 'cosmetic';
    case 'parameter-changed':
      return change.possibleDefault ? 'cosmetic' : 'behavior';
    case 'node-property-changed': {
      const first = change.path[0];
      return first !== undefined && 'key' in first && COSMETIC_NODE_PROPERTIES.has(first.key)
        ? 'cosmetic'
        : 'behavior';
    }
    case 'active-changed':
    case 'node-added':
    case 'node-removed':
    case 'node-type-changed':
    case 'credential-changed':
    case 'connection-added':
    case 'connection-removed':
    case 'setting-changed':
    case 'field-changed':
      return 'behavior';
  }
}

export function isPossibleDefaultChange(change: Change): boolean {
  return change.kind === 'parameter-changed' && change.possibleDefault;
}

export interface ChangeCounts {
  behavior: number;
  /** Includes possible defaults. */
  cosmetic: number;
  possibleDefaults: number;
}

export function countChanges(changes: Change[]): ChangeCounts {
  const behavior = changes.filter((change) => classifyChange(change) === 'behavior').length;
  return {
    behavior,
    cosmetic: changes.length - behavior,
    possibleDefaults: changes.filter(isPossibleDefaultChange).length,
  };
}

/**
 * Whether a workflow's diff matters for behavior: it has behavior changes, or
 * broken-reference warnings (a rename itself is cosmetic, but references left
 * pointing at the old name make nodes fail). Intended for `--exit-code=behavior`.
 */
export function hasBehaviorImpact(comparison: { changes: Change[]; warnings: unknown[] }): boolean {
  return comparison.warnings.length > 0 || countChanges(comparison.changes).behavior > 0;
}

export type FailOn = 'none' | 'changes' | 'behavior';

/**
 * Whether a set of comparisons should fail a check (CLI --exit-code, Action fail-on).
 * - changes: any difference (untracked instance workflows don't count)
 * - behavior: behavior changes or broken references (hasBehaviorImpact), or a
 *   workflow added, removed or deleted; cosmetic-only differences pass
 */
export function shouldFail(
  comparisons: { status: string; changes: Change[]; warnings: unknown[] }[],
  mode: FailOn,
): boolean {
  switch (mode) {
    case 'none':
      return false;
    case 'changes':
      return comparisons.some((c) => c.status !== 'unchanged' && c.status !== 'untracked');
    case 'behavior':
      return comparisons.some(
        (c) =>
          c.status === 'only-after' ||
          c.status === 'only-before' ||
          c.status === 'deleted-on-instance' ||
          (c.status === 'changed' && hasBehaviorImpact(c)),
      );
  }
}
