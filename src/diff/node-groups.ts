import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { diffValues, isPlainObject } from './values.js';
import type { Change, ConnectionEnd, GroupRef } from './types.js';

interface NodeGroup {
  id: string;
  name: string;
  description: string | undefined;
  nodeIds: string[];
}

/**
 * Reads `nodeGroups` leniently: it is a newer n8n field that flowdiff does not
 * validate, so anything unexpected is skipped rather than failing the diff.
 */
function readGroups(workflow: NormalizedWorkflow): NodeGroup[] {
  const raw = workflow.nodeGroups;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((group: unknown) => {
    if (!isPlainObject(group) || typeof group.id !== 'string') return [];
    const members = group.nodeIds;
    const nodeIds = Array.isArray(members)
      ? members.filter((id): id is string => typeof id === 'string')
      : isPlainObject(members)
        ? Object.keys(members)
        : [];
    return [
      {
        id: group.id,
        name: typeof group.name === 'string' ? group.name : group.id,
        description: typeof group.description === 'string' ? group.description : undefined,
        nodeIds,
      },
    ];
  });
}

export function diffNodeGroups(before: NormalizedWorkflow, after: NormalizedWorkflow): Change[] {
  const beforeGroups = new Map(readGroups(before).map((group) => [group.id, group]));
  const afterGroups = readGroups(after);
  const afterIds = new Set(afterGroups.map((group) => group.id));
  const nodeNames = new Map([...before.nodes, ...after.nodes].map((node) => [node.id, node.name]));
  const nodeEnd = (id: string): ConnectionEnd => ({ id, name: nodeNames.get(id) ?? id });

  const changes: Change[] = [];
  for (const group of afterGroups) {
    const ref: GroupRef = { id: group.id, name: group.name };
    const previous = beforeGroups.get(group.id);
    if (previous === undefined) {
      changes.push({ kind: 'group-added', group: ref });
      continue;
    }
    if (previous.name !== group.name) {
      changes.push({ kind: 'group-renamed', group: ref, from: previous.name, to: group.name });
    }
    for (const { change } of diffValues(previous.description, group.description)) {
      changes.push({ kind: 'group-description-changed', group: ref, change });
    }
    const previousMembers = new Set(previous.nodeIds);
    const members = new Set(group.nodeIds);
    for (const id of group.nodeIds.filter((id) => !previousMembers.has(id))) {
      changes.push({ kind: 'group-node-joined', group: ref, node: nodeEnd(id) });
    }
    for (const id of previous.nodeIds.filter((id) => !members.has(id))) {
      changes.push({ kind: 'group-node-left', group: ref, node: nodeEnd(id) });
    }
  }
  for (const group of beforeGroups.values()) {
    if (!afterIds.has(group.id)) {
      changes.push({ kind: 'group-removed', group: { id: group.id, name: group.name } });
    }
  }
  return changes;
}
