import type { WorkflowUpdateBody } from '../api/client.js';
import { isPlainObject } from '../diff/values.js';
import type { NormalizedWorkflow } from '../normalize/normalize.js';

// Allow-lists from n8n's public API update schema (UpdateWorkflowPublicDto,
// n8n 2.46). The schema is strict at every level, so anything else makes n8n
// reject the whole request. Keep these in sync when n8n adds fields.

const NODE_FIELDS = new Set([
  'id',
  'name',
  'webhookId',
  'disabled',
  'notesInFlow',
  'notes',
  'type',
  'typeVersion',
  'executeOnce',
  'alwaysOutputData',
  'retryOnFail',
  'maxTries',
  'waitBetweenTries',
  'continueOnFail',
  'onError',
  'position',
  'parameters',
  'credentials',
  'customTelemetryTags',
]);

const SETTINGS_FIELDS = new Set([
  'saveExecutionProgress',
  'saveManualExecutions',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'executionTimeout',
  'errorWorkflow',
  'timezone',
  'executionOrder',
  'binaryMode',
  'engineType',
  'callerPolicy',
  'callerIds',
  'timeSavedMode',
  'timeSavedPerExecution',
  'redactionPolicy',
  'redactCallerExecutions',
  'availableInMCP',
  'customTelemetryTags',
  'credentialResolverId',
]);

const NODE_GROUP_FIELDS = new Set(['id', 'name', 'description', 'nodeIds']);

/**
 * Top-level fields that are deliberately not sent: read-only on the instance
 * (id, active, tags) or never touched by push (pinData, staticData, which n8n
 * keeps when they are omitted). These are not reported as dropped.
 */
const NOT_SENT = new Set(['id', 'active', 'tags', 'pinData', 'staticData']);

export interface UpdateBodyResult {
  body: WorkflowUpdateBody;
  /** Human-readable descriptions of fields left out because n8n would reject them. */
  dropped: string[];
}

/** Builds the PUT body field by field from a local workflow file. Pure. */
export function buildUpdateBody(workflow: NormalizedWorkflow): UpdateBodyResult {
  const dropped: string[] = [];

  const nodes = workflow.nodes.map((node) => {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (NODE_FIELDS.has(key)) kept[key] = value;
      else dropped.push(`node "${node.name}" field "${key}"`);
    }
    return kept;
  });

  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflow.settings ?? {})) {
    if (SETTINGS_FIELDS.has(key)) settings[key] = value;
    else dropped.push(`setting "${key}"`);
  }

  const body: WorkflowUpdateBody = {
    name: workflow.name,
    nodes,
    connections: workflow.connections,
    settings,
  };

  if (typeof workflow.description === 'string') body.description = workflow.description;
  if (Array.isArray(workflow.nodeGroups)) {
    body.nodeGroups = workflow.nodeGroups.flatMap((group: unknown) => {
      if (!isPlainObject(group)) return [];
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(group)) {
        if (!NODE_GROUP_FIELDS.has(key)) {
          dropped.push(`node group "${String(group.name)}" field "${key}"`);
          continue;
        }
        // n8n expects an array of node ids; older exports may use an object map.
        kept[key] = key === 'nodeIds' && isPlainObject(value) ? Object.keys(value) : value;
      }
      return [kept];
    });
  }

  const handled = new Set([
    ...NOT_SENT,
    'name',
    'nodes',
    'connections',
    'settings',
    'description',
    'nodeGroups',
  ]);
  for (const key of Object.keys(workflow).sort()) {
    if (!handled.has(key)) dropped.push(`field "${key}"`);
  }
  return { body, dropped };
}
