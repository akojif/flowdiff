import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pc from 'picocolors';
import { createClient, type N8nClient } from '../api/client.js';
import { readConfig, type Config } from '../config/config-file.js';
import { resolveConnection } from '../config/connection.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { normalizeWorkflow, serializeWorkflow } from '../normalize/index.js';
import { indexWorkflowFiles, workflowFileName } from '../workspace/paths.js';
import { hashContent, readState, writeState } from '../workspace/state.js';

export type PullOutcome =
  /** New file written. */
  | 'created'
  /** File overwritten with the instance version. */
  | 'updated'
  /** Workflow was renamed on the instance; file moved to its new name. */
  | 'renamed'
  | 'unchanged'
  /** Edited locally, unchanged on the instance: local edits left alone. */
  | 'kept-local'
  /** Edited locally AND changed on the instance: skipped unless --force. */
  | 'conflict';

export interface PullEntry {
  id: string;
  name: string;
  file: string;
  outcome: PullOutcome;
}

export interface PullResult {
  entries: PullEntry[];
  /** Local files whose workflow no longer exists on the instance. Never deleted. */
  missingOnInstance: string[];
  /** Extra files for the same workflow id, left over from earlier renames. */
  duplicateFiles: string[];
}

export interface PullOptions {
  cwd: string;
  config: Config;
  client: N8nClient;
  /** Only pull workflows with this tag. */
  tag?: string | undefined;
  /** Overwrite local edits even when the instance also changed. */
  force?: boolean | undefined;
}

/**
 * Downloads workflows into the workflows folder as normalized JSON.
 *
 * Local edits are protected: the state file records a hash of what pull last
 * wrote, so a file that has changed since then is only overwritten with --force.
 */
export async function pull(options: PullOptions): Promise<PullResult> {
  const { cwd, config, client, tag, force = false } = options;
  const dir = resolve(cwd, config.workflowsDir);
  await mkdir(dir, { recursive: true });

  const fetched = await client.listWorkflows(tag === undefined ? {} : { tag });
  const workflows = fetched
    .filter((workflow) => workflow.isArchived !== true)
    // The API filters by tag too; checking again guards against instances that ignore it.
    .filter((workflow) => tag === undefined || workflow.tags?.some((t) => t.name === tag));

  const files = await indexWorkflowFiles(dir);
  const state = await readState(cwd);
  const entries: PullEntry[] = [];
  const duplicateFiles: string[] = [];

  for (const workflow of workflows) {
    const content = serializeWorkflow(normalizeWorkflow(workflow));
    const contentHash = hashContent(content);
    const targetFile = workflowFileName(workflow);
    const [currentFile, ...extraFiles] = files.get(workflow.id) ?? [];
    duplicateFiles.push(...extraFiles);

    const local =
      currentFile === undefined ? undefined : await readFile(join(dir, currentFile), 'utf8');
    const previous = state.workflows[workflow.id];

    let outcome: PullOutcome;
    if (local === undefined) {
      outcome = 'created';
    } else if (local === content) {
      outcome = currentFile === targetFile ? 'unchanged' : 'renamed';
    } else {
      // With no record of the last pull, assume both sides changed: never overwrite blindly.
      const editedLocally = hashContent(local) !== previous?.hash;
      const changedOnInstance = contentHash !== previous?.hash;
      if (!editedLocally || force) {
        outcome = currentFile === targetFile ? 'updated' : 'renamed';
      } else {
        outcome = changedOnInstance ? 'conflict' : 'kept-local';
      }
    }

    const writes = outcome === 'created' || outcome === 'updated' || outcome === 'renamed';
    if (writes) {
      await writeFile(join(dir, targetFile), content, 'utf8');
      if (currentFile !== undefined && currentFile !== targetFile) {
        await rm(join(dir, currentFile));
      }
    }
    if (writes || outcome === 'unchanged') {
      state.workflows[workflow.id] = {
        hash: contentHash,
        versionId: workflow.versionId ?? null,
        updatedAt: workflow.updatedAt,
      };
    }

    const file = writes ? targetFile : (currentFile ?? targetFile);
    entries.push({ id: workflow.id, name: workflow.name, file, outcome });
  }

  // With a tag filter, a missing workflow may simply be untagged, so only check on a full pull.
  const fetchedIds = new Set(fetched.map((workflow) => workflow.id));
  const missingOnInstance =
    tag === undefined
      ? [...files].filter(([id]) => !fetchedIds.has(id)).flatMap(([, names]) => names)
      : [];

  await writeState(cwd, state);
  return { entries, missingOnInstance, duplicateFiles };
}

const OUTCOME_LABELS: Record<PullOutcome, string> = {
  created: pc.green('created   '),
  updated: pc.cyan('updated   '),
  renamed: pc.cyan('renamed   '),
  unchanged: pc.dim('unchanged '),
  'kept-local': pc.yellow('kept local'),
  conflict: pc.red('conflict  '),
};

export function formatPullResult(result: PullResult, workflowsDir: string): string {
  const lines: string[] = [];
  for (const entry of result.entries) {
    if (entry.outcome === 'unchanged') continue;
    lines.push(`  ${OUTCOME_LABELS[entry.outcome]}  ${join(workflowsDir, entry.file)}`);
  }

  const counts = new Map<PullOutcome, number>();
  for (const entry of result.entries) {
    counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
  }
  const summary = [...counts].map(([outcome, count]) => `${String(count)} ${outcome}`).join(', ');
  lines.push('', `Pulled ${String(result.entries.length)} workflow(s): ${summary || 'none'}.`);

  if ((counts.get('kept-local') ?? 0) > 0) {
    lines.push(pc.yellow('Kept local edits for workflows that did not change on the instance.'));
  }
  if ((counts.get('conflict') ?? 0) > 0) {
    lines.push(
      pc.red(
        'Some workflows changed both locally and on the instance and were skipped. ' +
          'Commit or discard your local edits, or run `flowdiff pull --force` to overwrite them.',
      ),
    );
  }
  for (const file of result.missingOnInstance) {
    lines.push(
      pc.yellow(
        `${join(workflowsDir, file)} no longer exists on the instance (file left in place).`,
      ),
    );
  }
  for (const file of result.duplicateFiles) {
    lines.push(
      pc.yellow(`${join(workflowsDir, file)} is a duplicate file for the same workflow id.`),
    );
  }
  return lines.join('\n');
}

/** CLI entry point for `flowdiff pull`. */
export async function runPull(
  cwd: string,
  flags: { tag?: string; force?: boolean },
): Promise<void> {
  loadDotEnv(cwd);
  const config = await readConfig(cwd);
  const connection = resolveConnection(config, readEnv());
  const client = createClient({ connection });

  const filter = flags.tag === undefined ? '' : ` with tag "${flags.tag}"`;
  console.log(
    pc.dim(
      `Pulling workflows${filter} from ${connection.instanceUrl} (from ${connection.urlSource})`,
    ),
  );

  const result = await pull({ cwd, config, client, tag: flags.tag, force: flags.force });
  console.log(formatPullResult(result, config.workflowsDir));

  if (result.entries.some((entry) => entry.outcome === 'conflict')) {
    process.exitCode = 1;
  }
}
