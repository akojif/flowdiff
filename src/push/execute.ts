import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { N8nClient } from '../api/client.js';
import type { ApiWorkflow } from '../api/schemas.js';
import type { Config } from '../config/config-file.js';
import { normalizeWorkflow } from '../normalize/normalize.js';
import { serializeWorkflow } from '../normalize/serialize.js';
import { writeBackup } from '../workspace/backups.js';
import { workflowFileName } from '../workspace/paths.js';
import { hashContent, readState, writeState } from '../workspace/state.js';
import type { PushGuard } from '../config/push-guard.js';
import type { PlannedPush } from './plan.js';

export interface PushResult {
  id: string;
  name: string;
  outcome: 'pushed' | 'refused' | 'failed';
  message: string;
  /** Backup of the instance version, when one was written. */
  backup: string | undefined;
}

export interface ExecuteOptions {
  cwd: string;
  config: Config;
  client: N8nClient;
  /** Overwrite even if the instance changed since the last pull. */
  force: boolean;
  guard: Exclude<PushGuard, { kind: 'unset' }>;
  now: () => Date;
}

/**
 * Pushes planned workflows one by one. For each: fetch the instance version
 * again, re-check the push guard and the pull record, back it up, update, apply
 * activation only if planned, then refresh the local file and pull record from
 * what the instance stored.
 */
export async function executePush(
  plans: PlannedPush[],
  options: ExecuteOptions,
): Promise<PushResult[]> {
  const results: PushResult[] = [];
  for (const plan of plans) {
    results.push(await pushOne(plan, options));
  }
  return results;
}

/**
 * The workflow as the list endpoint returns it, or undefined if it isn't listed
 * (filtered by the guard tag when there is one).
 *
 * Every hash flowdiff compares must come from the same endpoint: the single GET
 * (GET /workflows/{id}) returns extra fields such as `description` and
 * `sourceWorkflowId` that the list (used by pull and status) leaves out, so
 * hashes from the two never match. Filtering by the guard tag keeps this fast on
 * large instances; a pushable workflow always has that tag. With the guard off
 * (requireTag: false), the full list is read.
 */
export async function listedVersion(
  client: N8nClient,
  id: string,
  guardTag: string | undefined,
): Promise<ApiWorkflow | undefined> {
  const listed = await client.listWorkflows(guardTag === undefined ? {} : { tag: guardTag });
  return listed.find((workflow) => workflow.id === id && workflow.isArchived !== true);
}

/** The content hash pull records and status compares against. */
export function comparableHash(workflow: ApiWorkflow): string {
  return hashContent(serializeWorkflow(normalizeWorkflow(workflow)));
}

async function pushOne(plan: PlannedPush, options: ExecuteOptions): Promise<PushResult> {
  const { cwd, config, client, force, now, guard } = options;
  const guardTag = guard.kind === 'tag' ? guard.tag : undefined;
  const result = (
    outcome: PushResult['outcome'],
    message: string,
    backup?: string,
  ): PushResult => ({
    id: plan.id,
    name: plan.name,
    outcome,
    message,
    backup,
  });

  // 1. Re-check against a fresh copy: the instance may have changed since planning.
  //    It must be list-shaped, like the copy pull hashed (see listedVersion).
  let listed;
  try {
    listed = await listedVersion(client, plan.id, guardTag);
  } catch (error) {
    return result('failed', `could not read the instance version: ${(error as Error).message}`);
  }
  if (listed === undefined) {
    const why =
      guardTag === undefined
        ? 'it is no longer on the instance'
        : `push guard: the instance version no longer has the tag "${guardTag}" (or was deleted)`;
    return result('refused', why);
  }
  const state = await readState(cwd);
  if (!force && comparableHash(listed) !== state.workflows[plan.id]?.hash) {
    return result(
      'refused',
      'changed on the instance since the last pull; run flowdiff pull, or use --force',
    );
  }

  // 2. Back up before writing anything: the full single-workflow response, with pin data.
  let backup;
  try {
    backup = await writeBackup(
      cwd,
      plan.id,
      await client.getWorkflow(plan.id, { includePinData: true }),
      now(),
    );
  } catch (error) {
    return result('failed', `could not back up the instance version: ${(error as Error).message}`);
  }

  // 3. Update, then activation only if it was explicitly requested.
  try {
    await client.updateWorkflow(plan.id, plan.body);
  } catch (error) {
    return result('failed', `update failed: ${(error as Error).message}`, backup);
  }
  if (plan.activeChange !== undefined) {
    try {
      await (plan.activeChange === 'activate'
        ? client.activateWorkflow(plan.id)
        : client.deactivateWorkflow(plan.id));
    } catch (error) {
      return result(
        'failed',
        `updated, but ${plan.activeChange} failed: ${(error as Error).message}`,
        backup,
      );
    }
  }

  // 4. Refresh the local file and pull record from what the instance now stores.
  let stored;
  try {
    stored = await listedVersion(client, plan.id, guardTag);
    if (stored === undefined) throw new Error('it no longer appears in the workflow list');
  } catch (error) {
    return result(
      'pushed',
      `pushed, but the local file could not be refreshed (${(error as Error).message}); run flowdiff pull`,
      backup,
    );
  }
  const content = serializeWorkflow(normalizeWorkflow(stored));
  const file = join(config.workflowsDir, workflowFileName(stored));
  const previous = await readFile(join(cwd, plan.file), 'utf8');
  await writeFile(join(cwd, file), content, 'utf8');
  if (file !== plan.file) await rm(join(cwd, plan.file));
  state.workflows[plan.id] = {
    hash: hashContent(content),
    versionId: stored.versionId ?? null,
    updatedAt: stored.updatedAt,
  };
  await writeState(cwd, state);

  const differs = previous !== content ? ' (local file refreshed from the instance)' : '';
  return result(
    'pushed',
    `pushed${plan.activeChange === undefined ? '' : ` and ${plan.activeChange}d`}${differs}`,
    backup,
  );
}
