import { confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { createClient, type N8nClient } from '../api/client.js';
import { ForbiddenError } from '../api/errors.js';
import type { ApiCredential } from '../api/schemas.js';
import { readConfig, type Config } from '../config/config-file.js';
import { resolveConnection } from '../config/connection.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { describeTagScope, resolveTagScope } from '../config/tag-scope.js';
import { executePush, type PushResult } from '../push/execute.js';
import { planPush, type NotPushed, type PlannedPush } from '../push/plan.js';
import { renderText } from '../render/index.js';
import { computeStatuses } from '../workspace/status.js';
import { PUSH_TITLE, SUMMARY_THRESHOLD, selectWorkflows } from './diff.js';
import { loadInstanceScope } from './instance-scope.js';

export interface PushFlags {
  dryRun?: boolean;
  force?: boolean;
  applyActive?: boolean;
  tag?: string | false;
}

/** Terminal interaction, injectable for tests. */
export interface PushIo {
  /** Whether a person can answer prompts. Push refuses to write without one. */
  interactive: boolean;
  confirm(message: string): Promise<boolean>;
  log(text: string): void;
}

export interface PushCommandOptions {
  cwd: string;
  config: Config;
  client: N8nClient;
  /** Workflow selector (id, file, name or slug). */
  target?: string | undefined;
  flags: PushFlags;
  io: PushIo;
  color: boolean;
  now?: () => Date;
}

/** Exit codes: 0 = everything planned was pushed (or nothing to do), 1 = refused/skipped/declined, 2 = failed. */
export async function pushCommand(
  options: PushCommandOptions,
): Promise<{ exitCode: number; results: PushResult[] }> {
  const { cwd, config, client, flags, io } = options;
  const c = pc.createColors(options.color);
  const force = flags.force === true;
  const scope = resolveTagScope(config, flags.tag);
  const loaded = await loadInstanceScope(cwd, config, client, scope.tag);
  const statuses = computeStatuses(loaded);

  const selected =
    options.target === undefined
      ? undefined
      : selectWorkflows(options.target, {
          before: loaded.instance,
          after: new Map([...loaded.local].map(([id, f]) => [id, f.workflow])),
          files: new Map([...loaded.local].map(([id, f]) => [id, [f.file]])),
        });

  let credentials: ApiCredential[] | undefined;
  try {
    credentials = await client.listCredentials();
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    credentials = undefined;
  }

  const decisions = planPush({
    statuses,
    local: loaded.local,
    instance: loaded.instance,
    credentials,
    selected,
    force,
    applyActive: flags.applyActive === true,
  });
  let planned = decisions.filter((d): d is PlannedPush => d.action === 'push');
  const notPushed = decisions.filter((d): d is NotPushed => d.action !== 'push');

  io.log(c.dim(`Instance: ${config.instanceUrl}${describeTagScope(scope)}`));
  if (credentials === undefined) {
    io.log(c.yellow('Credential check skipped: the API key lacks the "credential:list" scope.'));
  }
  io.log('');
  if (planned.length > 0) {
    io.log(
      renderText(
        planned.map((p) => p.comparison),
        {
          beforeLabel: 'instance',
          afterLabel: 'local',
          title: PUSH_TITLE,
          color: options.color,
          full: false,
          view: planned.length > SUMMARY_THRESHOLD ? 'summary' : 'detail',
        },
      ),
    );
    for (const plan of planned) {
      const notes = [
        ...plan.dropped.map((d) => `not sent (n8n would reject it): ${d}`),
        ...plan.credentialWarnings,
        ...plan.notes,
        ...(plan.activeChange === undefined ? [] : [`will ${plan.activeChange} the workflow`]),
      ];
      if (notes.length === 0) continue;
      io.log(c.yellow(`\n${plan.name} (${plan.id}):`));
      for (const note of notes) io.log(c.yellow(`  ! ${note}`));
    }
  }
  for (const d of notPushed) {
    const label = d.action === 'refuse' ? c.red('refused') : c.dim('skipped');
    io.log(`${label}  ${d.name} (${d.id}): ${d.reason}`);
  }

  const anyRefused = notPushed.some((d) => d.action === 'refuse');
  if (planned.length === 0) {
    io.log('\nNothing to push.');
    return { exitCode: anyRefused ? 1 : 0, results: [] };
  }
  if (flags.dryRun === true) {
    io.log(
      `\nDry run: would push ${plural(planned.length)} to ${config.instanceUrl}. Nothing was changed.`,
    );
    return { exitCode: anyRefused ? 1 : 0, results: [] };
  }
  if (!io.interactive) {
    io.log(
      c.red(
        '\npush needs an interactive terminal to confirm. Use --dry-run to preview. Nothing was pushed.',
      ),
    );
    return { exitCode: 1, results: [] };
  }

  // Broken references make nodes fail at run time: confirm each one separately (default: no).
  let declined = false;
  const confirmed: PlannedPush[] = [];
  for (const plan of planned) {
    if (plan.brokenReferences.length > 0) {
      const ok = await io.confirm(
        `"${plan.name}" has ${String(plan.brokenReferences.length)} broken reference(s). Push it anyway?`,
      );
      if (!ok) {
        declined = true;
        io.log(c.dim(`skipped  ${plan.name} (${plan.id}): broken references`));
        continue;
      }
    }
    confirmed.push(plan);
  }
  planned = confirmed;
  if (planned.length === 0) {
    io.log('\nNothing was pushed.');
    return { exitCode: 1, results: [] };
  }

  if (!(await io.confirm(`Push ${plural(planned.length)} to ${config.instanceUrl}?`))) {
    io.log('\nNothing was pushed.');
    return { exitCode: 1, results: [] };
  }

  const results = await executePush(planned, {
    cwd,
    config,
    client,
    force,
    now: options.now ?? (() => new Date()),
  });
  io.log('');
  for (const r of results) {
    const label =
      r.outcome === 'pushed'
        ? c.green('pushed ')
        : r.outcome === 'refused'
          ? c.red('refused')
          : c.red('failed ');
    const backup = r.backup === undefined ? '' : c.dim(` (backup: ${r.backup})`);
    io.log(`${label}  ${r.name} (${r.id}): ${r.message}${backup}`);
  }

  if (results.some((r) => r.outcome === 'failed')) return { exitCode: 2, results };
  const anyNotPushed = anyRefused || declined || results.some((r) => r.outcome === 'refused');
  return { exitCode: anyNotPushed ? 1 : 0, results };
}

function plural(count: number): string {
  return `${String(count)} workflow${count === 1 ? '' : 's'}`;
}

/** CLI entry point for `flowdiff push`. */
export async function runPush(
  cwd: string,
  target: string | undefined,
  flags: PushFlags,
): Promise<void> {
  loadDotEnv(cwd);
  const config = await readConfig(cwd);
  const connection = resolveConnection(config, readEnv());
  const { exitCode } = await pushCommand({
    cwd,
    config: { ...config, instanceUrl: connection.instanceUrl },
    client: createClient({ connection }),
    target,
    flags,
    color: pc.isColorSupported,
    io: {
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      confirm: async (message) => {
        const answer = await confirm({ message, initialValue: false });
        return answer === true && !isCancel(answer);
      },
      log: (text) => {
        console.log(text);
      },
    },
  });
  process.exitCode = exitCode;
}
