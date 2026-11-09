import pc from 'picocolors';
import { createClient, type N8nClient } from '../api/client.js';
import { readConfig, type Config } from '../config/config-file.js';
import { resolveConnection } from '../config/connection.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { describeTagScope, resolveTagScope } from '../config/tag-scope.js';
import { renderStatusJson, renderStatusText } from '../render/index.js';
import { computeStatuses, type WorkflowStatus } from '../workspace/status.js';
import { loadInstanceScope } from './instance-scope.js';

export interface StatusFlags {
  tag?: string | false;
  all?: boolean;
  json?: boolean;
}

export interface StatusCommandOptions {
  cwd: string;
  config: Config;
  client: N8nClient;
  flags: StatusFlags;
  color: boolean;
}

export async function statusCommand(
  options: StatusCommandOptions,
): Promise<{ output: string; statuses: WorkflowStatus[] }> {
  const { cwd, config, client, flags } = options;
  const scope = resolveTagScope(config, flags.tag);
  const loaded = await loadInstanceScope(cwd, config, client, scope.tag);
  const statuses = computeStatuses(loaded);
  const output =
    flags.json === true
      ? renderStatusJson(statuses)
      : renderStatusText(statuses, {
          color: options.color,
          showAll: flags.all === true,
          scopeDescription: describeTagScope(scope),
        });
  return { output, statuses };
}

/** CLI entry point for `flowdiff status`. Always exits with 0 unless an error occurs. */
export async function runStatus(cwd: string, flags: StatusFlags): Promise<void> {
  loadDotEnv(cwd);
  const config = await readConfig(cwd);
  const client = createClient({ connection: resolveConnection(config, readEnv()) });
  const { output } = await statusCommand({
    cwd,
    config,
    client,
    flags,
    color: pc.isColorSupported,
  });
  console.log(output);
}
