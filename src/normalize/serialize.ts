import { sortKeysDeep } from './normalize.js';

/** Stable JSON for files on disk: sorted keys, 2-space indent, trailing newline. */
export function serializeWorkflow(workflow: unknown): string {
  return `${JSON.stringify(sortKeysDeep(workflow), null, 2)}\n`;
}
