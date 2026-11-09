import type { N8nClient } from '../api/client.js';
import type { ApiWorkflow } from '../api/schemas.js';
import type { Config } from '../config/config-file.js';
import { normalizeWorkflow, type NormalizedWorkflow } from '../normalize/normalize.js';
import { readLocalWorkflows, type WorkflowFile } from '../workspace/local-files.js';
import { readState, type State } from '../workspace/state.js';

export interface InstanceScope {
  local: Map<string, WorkflowFile>;
  /** Normalized instance workflows in scope. */
  instance: Map<string, NormalizedWorkflow>;
  /** The same workflows as the API returned them, e.g. for tag checks. */
  raw: Map<string, ApiWorkflow>;
  state: State;
}

/**
 * Loads local files, the pull state and the instance workflows in scope:
 * workflows with the tag (if any) plus every workflow already tracked locally,
 * so removing the tag on the instance never makes a tracked workflow disappear.
 * Archived workflows are left out.
 */
export async function loadInstanceScope(
  cwd: string,
  config: Config,
  client: N8nClient,
  tag: string | undefined,
): Promise<InstanceScope> {
  const local = await readLocalWorkflows(cwd, config.workflowsDir);
  const state = await readState(cwd);
  const inScope = (await client.listWorkflows())
    .filter((workflow) => workflow.isArchived !== true)
    .filter(
      (workflow) =>
        tag === undefined || local.has(workflow.id) || workflow.tags?.some((t) => t.name === tag),
    );
  return {
    local,
    instance: new Map(inScope.map((workflow) => [workflow.id, normalizeWorkflow(workflow)])),
    raw: new Map(inScope.map((workflow) => [workflow.id, workflow])),
    state,
  };
}
