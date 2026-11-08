import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { diffConnections } from './connections.js';
import { diffNodeGroups } from './node-groups.js';
import type { Change, NodeRef } from './types.js';
import { diffValues } from './values.js';

export interface DiffOptions {
  /** Report canvas position changes. Off by default: moving nodes is rarely interesting. */
  includeLayout?: boolean;
}

type WorkflowNode = NormalizedWorkflow['nodes'][number];

/** Workflow fields compared by dedicated logic; everything else is compared generically. */
const HANDLED_WORKFLOW_FIELDS = new Set([
  'id',
  'name',
  'active',
  'tags',
  'nodes',
  'connections',
  'nodeGroups',
  'settings',
]);

/** Node fields compared by dedicated logic; everything else is a node property. */
const HANDLED_NODE_FIELDS = new Set([
  'id',
  'name',
  'type',
  'typeVersion',
  'position',
  'parameters',
  'credentials',
]);

/**
 * Compares two normalized workflows. Pure: no I/O, inputs are not modified, and
 * the result order is deterministic:
 * workflow fields, nodes (after-order, then removed nodes), connections, groups,
 * settings, other fields.
 */
export function diffWorkflows(
  before: NormalizedWorkflow,
  after: NormalizedWorkflow,
  options: DiffOptions = {},
): Change[] {
  return [
    ...diffWorkflowFields(before, after),
    ...diffNodes(before, after, options),
    ...diffConnections(before, after),
    ...diffNodeGroups(before, after),
    ...diffValues(before.settings ?? {}, after.settings ?? {}).map(({ path, change }): Change => ({
      kind: 'setting-changed',
      path,
      change,
    })),
    ...diffOtherFields(before, after),
  ];
}

function diffWorkflowFields(before: NormalizedWorkflow, after: NormalizedWorkflow): Change[] {
  const changes: Change[] = [];
  if (before.name !== after.name) {
    changes.push({ kind: 'workflow-renamed', from: before.name, to: after.name });
  }
  if (before.active !== after.active) {
    changes.push({ kind: 'active-changed', from: before.active, to: after.active });
  }
  const beforeTags = new Set(before.tags);
  const afterTags = new Set(after.tags);
  for (const tag of after.tags.filter((t) => !beforeTags.has(t)))
    changes.push({ kind: 'tag-added', tag });
  for (const tag of before.tags.filter((t) => !afterTags.has(t)))
    changes.push({ kind: 'tag-removed', tag });
  return changes;
}

function nodeRef(node: WorkflowNode): NodeRef {
  return { id: node.id, name: node.name, type: node.type };
}

function diffNodes(
  before: NormalizedWorkflow,
  after: NormalizedWorkflow,
  options: DiffOptions,
): Change[] {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterIds = new Set(after.nodes.map((node) => node.id));

  const changes: Change[] = [];
  for (const node of after.nodes) {
    const previous = beforeById.get(node.id);
    if (previous === undefined) {
      changes.push({ kind: 'node-added', node: nodeRef(node) });
    } else {
      changes.push(...diffNode(previous, node, options));
    }
  }
  for (const node of before.nodes) {
    if (!afterIds.has(node.id)) changes.push({ kind: 'node-removed', node: nodeRef(node) });
  }
  return changes;
}

function diffNode(before: WorkflowNode, after: WorkflowNode, options: DiffOptions): Change[] {
  const node = nodeRef(after);
  const changes: Change[] = [];

  if (before.name !== after.name) {
    changes.push({ kind: 'node-renamed', node, from: before.name, to: after.name });
  }
  for (const field of ['type', 'typeVersion'] as const) {
    if (before[field] !== after[field]) {
      changes.push({
        kind: 'node-type-changed',
        node,
        field,
        from: before[field],
        to: after[field],
      });
    }
  }
  for (const { path, change } of diffValues(before.parameters, after.parameters)) {
    changes.push({ kind: 'parameter-changed', node, path, change });
  }
  changes.push(...diffCredentials(before, after, node));

  if (options.includeLayout === true && diffValues(before.position, after.position).length > 0) {
    changes.push({ kind: 'node-moved', node, from: before.position, to: after.position });
  }

  const otherFields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !HANDLED_NODE_FIELDS.has(field))
    .sort();
  for (const field of otherFields) {
    const diffs = diffValues(
      (before as Record<string, unknown>)[field],
      (after as Record<string, unknown>)[field],
      [{ key: field }],
    );
    for (const { path, change } of diffs) {
      changes.push({ kind: 'node-property-changed', node, path, change });
    }
  }
  return changes;
}

/** Compares credential references by name. An id-only change is not a change. */
function diffCredentials(before: WorkflowNode, after: WorkflowNode, node: NodeRef): Change[] {
  const beforeCredentials = before.credentials ?? {};
  const afterCredentials = after.credentials ?? {};
  const types = [
    ...new Set([...Object.keys(beforeCredentials), ...Object.keys(afterCredentials)]),
  ].sort();

  return types.flatMap((credentialType): Change[] => {
    const from = beforeCredentials[credentialType]?.name ?? null;
    const to = afterCredentials[credentialType]?.name ?? null;
    return from === to ? [] : [{ kind: 'credential-changed', node, credentialType, from, to }];
  });
}

function diffOtherFields(before: NormalizedWorkflow, after: NormalizedWorkflow): Change[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !HANDLED_WORKFLOW_FIELDS.has(field))
    .sort();
  return fields.flatMap((field) =>
    diffValues(before[field], after[field], [{ key: field }]).map(({ path, change }): Change => ({
      kind: 'field-changed',
      path,
      change,
    })),
  );
}
