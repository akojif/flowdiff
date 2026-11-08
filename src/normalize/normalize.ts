import type { ApiWorkflow } from '../api/schemas.js';

/**
 * Top-level fields that change without anyone editing the workflow, or that hold
 * runtime data that does not belong in git. Everything else is kept, so fields
 * added by newer n8n versions are not silently lost.
 */
export const STRIPPED_FIELDS = [
  'createdAt',
  'updatedAt',
  'versionId',
  'activeVersionId',
  'versionCounter',
  'triggerCount',
  'shared',
  'meta',
  'isArchived',
  // Runtime state, e.g. the last time a polling trigger ran.
  'staticData',
  // Can contain real data captured from executions.
  'pinData',
] as const;

/** The stable shape stored in git. */
export interface NormalizedWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: ApiWorkflow['nodes'];
  connections: ApiWorkflow['connections'];
  settings?: ApiWorkflow['settings'];
  /** Tag names only, sorted. Tag ids and timestamps are instance-specific. */
  tags: string[];
  /** Fields flowdiff does not model are kept as-is. */
  [field: string]: unknown;
}

/**
 * Turns a workflow from the API into the stable shape stored in git.
 * Pure: does not modify its input. Normalizing twice gives the same result.
 */
export function normalizeWorkflow(workflow: ApiWorkflow): NormalizedWorkflow {
  const stripped = new Set<string>(STRIPPED_FIELDS);
  const kept = Object.entries(workflow).filter(([key]) => !stripped.has(key));
  const result = { ...Object.fromEntries(kept), tags: normalizeTags(workflow.tags) };
  // sortKeysDeep builds new objects and arrays, so the input is never shared or modified.
  return sortKeysDeep(result) as NormalizedWorkflow;
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const names = tags.map((tag: unknown) =>
    typeof tag === 'string' ? tag : (tag as { name: string }).name,
  );
  // Plain code-unit sort: identical on every machine, unlike locale-aware sorting.
  return [...new Set(names)].sort();
}

/**
 * Recursively sorts object keys. Array order is preserved because it can be
 * meaningful (node order, ordered parameter lists).
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
