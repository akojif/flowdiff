import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { N8nClient } from '../api/client.js';
import type { Config } from '../config/config-file.js';
import { normalizeWorkflow } from '../normalize/normalize.js';
import { serializeWorkflow } from '../normalize/serialize.js';
import { writeBackup } from '../workspace/backups.js';
import { workflowFileName } from '../workspace/paths.js';
import { hashContent, readState, writeState } from '../workspace/state.js';
import { DEV_GUARD_TAG, type PlannedPush } from './plan.js';

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
  now: () => Date;
}

/**
 * Pushes planned workflows one by one. For each: fetch the instance version
 * again, re-check the dev guard and the pull record, back it up, update, apply
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

async function pushOne(plan: PlannedPush, options: ExecuteOptions): Promise<PushResult> {
  const { cwd, config, client, force, now } = options;
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
  let fresh;
  try {
    fresh = await client.getWorkflow(plan.id, { includePinData: true });
  } catch (error) {
    return result('failed', `could not read the instance version: ${(error as Error).message}`);
  }
  if (!(fresh.tags ?? []).some((tag) => tag.name === DEV_GUARD_TAG)) {
    return result(
      'refused',
      `dev guard: the instance version no longer has the "${DEV_GUARD_TAG}" tag`,
    );
  }
  const state = await readState(cwd);
  const freshHash = hashContent(serializeWorkflow(normalizeWorkflow(fresh)));
  if (!force && freshHash !== state.workflows[plan.id]?.hash) {
    return result(
      'refused',
      'changed on the instance since the last pull; run flowdiff pull, or use --force',
    );
  }

  // 2. Back up before writing anything.
  const backup = await writeBackup(cwd, plan.id, fresh, now());

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
    stored = await client.getWorkflow(plan.id);
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
