import { compare } from '../diff/compare.js';
import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { serializeWorkflow } from '../normalize/serialize.js';
import { scanWorkflowSecrets } from '../secrets/scan.js';
import type { WorkflowFile } from './local-files.js';
import { hashContent, type State } from './state.js';

export type SyncStatus =
  | 'unchanged'
  | 'modified-locally'
  | 'modified-on-instance'
  | 'conflict'
  | 'deleted-on-instance'
  | 'new-locally'
  /** On both sides but never pulled here (e.g. a fresh clone) and not identical. */
  | 'no-pull-record'
  | 'untracked';

export interface WorkflowStatus {
  id: string;
  name: string;
  status: SyncStatus;
  /** Local file, when there is one. */
  file: string | undefined;
  /** Possible hard-coded secrets in the local file. */
  secrets: number;
}

export interface StatusInput {
  local: ReadonlyMap<string, WorkflowFile>;
  instance: ReadonlyMap<string, NormalizedWorkflow>;
  state: State;
}

/**
 * Works out each workflow's sync status by comparing content hashes with the
 * hash recorded at the last pull. Pure.
 *
 * Content hashes (not versionId) are safe here because push never touches
 * pinData or staticData, which normalization leaves out of the hash.
 */
export function computeStatuses({ local, instance, state }: StatusInput): WorkflowStatus[] {
  const statuses: WorkflowStatus[] = [];

  for (const [id, { file, content, workflow }] of local) {
    const remote = instance.get(id);
    const record = state.workflows[id];
    const status = ((): SyncStatus => {
      if (remote === undefined) return record === undefined ? 'new-locally' : 'deleted-on-instance';
      const remoteContent = serializeWorkflow(remote);
      if (remoteContent === content) return 'unchanged';
      if (record === undefined) return 'no-pull-record';
      const editedLocally = hashContent(content) !== record.hash;
      const changedOnInstance = hashContent(remoteContent) !== record.hash;
      if (editedLocally && changedOnInstance) return 'conflict';
      if (editedLocally) return 'modified-locally';
      if (changedOnInstance) return 'modified-on-instance';
      // Neither side differs from the record, yet they differ from each other:
      // only possible if the record is stale, so treat it as unknown.
      return 'no-pull-record';
    })();
    statuses.push({
      id,
      name: workflow.name,
      status,
      file,
      secrets: scanWorkflowSecrets(workflow).length,
    });
  }

  for (const [id, remote] of instance) {
    if (!local.has(id)) {
      statuses.push({ id, name: remote.name, status: 'untracked', file: undefined, secrets: 0 });
    }
  }
  return statuses.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
}
