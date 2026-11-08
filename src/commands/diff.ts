import { basename } from 'node:path';
import pc from 'picocolors';
import { createClient, type N8nClient } from '../api/client.js';
import { readConfig, type Config } from '../config/config-file.js';
import { resolveConnection } from '../config/connection.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { resolveTagScope } from '../config/tag-scope.js';
import { compareWorkflowSets, hasDifferences, type WorkflowComparison } from '../diff/index.js';
import { FlowdiffError } from '../errors.js';
import { normalizeWorkflow, type NormalizedWorkflow } from '../normalize/normalize.js';
import { renderJson, renderText } from '../render/index.js';
import { parseRange, readWorkflowsAtRef, refExists } from '../workspace/git.js';
import { readLocalWorkflows, type WorkflowFile } from '../workspace/local-files.js';
import { slugify } from '../workspace/paths.js';
import { readState } from '../workspace/state.js';

export interface DiffFlags {
  /** `--tag <name>` (string) or `--no-tag` (false). Ignored for git ranges. */
  tag?: string | false;
  /** List untracked instance workflows individually. */
  all?: boolean;
  json?: boolean;
  includeLayout?: boolean;
  full?: boolean;
  exitCode?: boolean;
}

export interface DiffCommandOptions {
  cwd: string;
  config: Config;
  /** A git range (`main..feature`) or a workflow selector. */
  target?: string | undefined;
  /** Workflow selector, only valid after a git range. */
  workflow?: string | undefined;
  flags: DiffFlags;
  /** Creates the API client; only called when comparing against the instance. */
  getClient: () => N8nClient;
  color: boolean;
}

export interface DiffCommandResult {
  output: string;
  differs: boolean;
}

interface Sides {
  mode: 'instance' | 'git';
  before: Map<string, NormalizedWorkflow>;
  after: Map<string, NormalizedWorkflow>;
  beforeLabel: string;
  afterLabel: string;
  /** File paths per workflow id, from either side, for selector matching. */
  files: Map<string, string[]>;
  /** Workflow ids with a pull record in .flowdiff/state.json (instance mode only). */
  pulledIds: Set<string>;
}

/**
 * Compares local files with the instance (before = instance, after = local, so
 * the diff previews what push would change), or two git refs.
 */
export async function diffCommand(options: DiffCommandOptions): Promise<DiffCommandResult> {
  const { cwd, config, target, workflow, flags } = options;
  const range = target === undefined ? undefined : parseRange(target);

  let sides: Sides;
  let selector: string | undefined;
  if (range !== undefined) {
    for (const ref of [range.from, range.to]) {
      if (!(await refExists(cwd, ref))) throw new FlowdiffError(`Unknown git ref "${ref}".`);
    }
    sides = await gitSides(cwd, config, range.from, range.to);
    selector = workflow;
  } else {
    if (workflow !== undefined) {
      throw new FlowdiffError(
        `Unexpected argument "${workflow}". Use \`flowdiff diff [workflow]\` or \`flowdiff diff <refA>..<refB> [workflow]\`.`,
      );
    }
    const scope = resolveTagScope(config, flags.tag);
    sides = await instanceSides(cwd, config, options.getClient(), scope.tag);
    selector = target;
  }

  if (selector !== undefined) {
    const ids = selectWorkflows(selector, sides);
    sides.before = filterMap(sides.before, ids);
    sides.after = filterMap(sides.after, ids);
  }

  const comparisons = compareWorkflowSets(sides.before, sides.after, {
    includeLayout: flags.includeLayout === true,
  }).map((comparison) => relabel(comparison, sides));
  const labels = { beforeLabel: sides.beforeLabel, afterLabel: sides.afterLabel };
  const output =
    flags.json === true
      ? renderJson(comparisons, labels)
      : renderText(comparisons, {
          ...labels,
          color: options.color,
          full: flags.full === true,
          showAll: flags.all === true,
        });
  return { output, differs: hasDifferences(comparisons) };
}

async function gitSides(cwd: string, config: Config, from: string, to: string): Promise<Sides> {
  const before = await readWorkflowsAtRef(cwd, from, config.workflowsDir);
  const after = await readWorkflowsAtRef(cwd, to, config.workflowsDir);
  return {
    mode: 'git',
    before: workflowsOf(before),
    after: workflowsOf(after),
    beforeLabel: from,
    afterLabel: to,
    files: filesOf(before, after),
    pulledIds: new Set(),
  };
}

/**
 * Instance side = workflows with the tag (if any) plus every workflow already
 * tracked locally, so removing the tag on the instance shows up as a tag change
 * instead of the local file looking like a new workflow.
 */
async function instanceSides(
  cwd: string,
  config: Config,
  client: N8nClient,
  tag: string | undefined,
): Promise<Sides> {
  const local = await readLocalWorkflows(cwd, config.workflowsDir);
  const state = await readState(cwd);
  const remote = (await client.listWorkflows())
    .filter((workflow) => workflow.isArchived !== true)
    .filter(
      (workflow) =>
        tag === undefined || local.has(workflow.id) || workflow.tags?.some((t) => t.name === tag),
    )
    .map(normalizeWorkflow);
  return {
    mode: 'instance',
    before: new Map(remote.map((workflow) => [workflow.id, workflow])),
    after: workflowsOf(local),
    beforeLabel: 'instance',
    afterLabel: 'local',
    files: filesOf(local),
    pulledIds: new Set(Object.keys(state.workflows)),
  };
}

/**
 * In instance mode, a workflow only on the instance is "untracked" (push never
 * deletes, so it is not a removal), and a local workflow that was pulled before
 * but is gone from the instance is "deleted on instance", not a new workflow.
 */
function relabel(comparison: WorkflowComparison, sides: Sides): WorkflowComparison {
  if (sides.mode !== 'instance') return comparison;
  if (comparison.status === 'only-before') return { ...comparison, status: 'untracked' };
  if (comparison.status === 'only-after' && sides.pulledIds.has(comparison.id)) {
    return { ...comparison, status: 'deleted-on-instance' };
  }
  return comparison;
}

function workflowsOf(files: Map<string, WorkflowFile>): Map<string, NormalizedWorkflow> {
  return new Map([...files].map(([id, { workflow }]) => [id, workflow]));
}

function filesOf(...sources: Map<string, WorkflowFile>[]): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const source of sources) {
    for (const [id, { file }] of source) files.set(id, [...(files.get(id) ?? []), file]);
  }
  return files;
}

function filterMap<T>(map: Map<string, T>, ids: Set<string>): Map<string, T> {
  return new Map([...map].filter(([id]) => ids.has(id)));
}

/**
 * Resolves a selector to workflow ids. Accepts an id, a file path or file name,
 * an exact workflow name (case-insensitive), or the name's slug.
 */
export function selectWorkflows(
  selector: string,
  sides: Pick<Sides, 'before' | 'after' | 'files'>,
): Set<string> {
  const wanted = selector.trim();
  const workflows = new Map([...sides.before, ...sides.after]);
  const matches = new Set<string>();

  for (const [id, workflow] of workflows) {
    const files = sides.files.get(id) ?? [];
    const matchesFile = files.some(
      (file) => file === wanted || basename(file) === basename(wanted),
    );
    const matchesName =
      workflow.name.toLowerCase() === wanted.toLowerCase() || slugify(workflow.name) === wanted;
    if (id === wanted || matchesFile || matchesName) matches.add(id);
  }

  if (matches.size === 0) {
    throw new FlowdiffError(
      `No workflow matches "${selector}". Use an id, a file name or a workflow name.`,
    );
  }
  if (matches.size > 1) {
    const list = [...matches]
      .map((id) => `  - ${workflows.get(id)?.name ?? id} (${id})`)
      .join('\n');
    throw new FlowdiffError(`"${selector}" matches more than one workflow; use its id:\n${list}`);
  }
  return matches;
}

/** CLI entry point for `flowdiff diff`. */
export async function runDiff(
  cwd: string,
  target: string | undefined,
  workflow: string | undefined,
  flags: DiffFlags,
): Promise<void> {
  const config = await readConfig(cwd);
  const result = await diffCommand({
    cwd,
    config,
    target,
    workflow,
    flags,
    color: pc.isColorSupported,
    getClient: () => {
      loadDotEnv(cwd);
      return createClient({ connection: resolveConnection(config, readEnv()) });
    },
  });
  console.log(result.output);
  if (flags.exitCode === true && result.differs) process.exitCode = 1;
}
