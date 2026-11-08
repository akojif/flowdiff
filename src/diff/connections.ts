import type { NormalizedWorkflow } from '../normalize/normalize.js';
import type { Change, ConnectionEnd, ConnectionRef } from './types.js';

/** Output names for node types whose outputs have a fixed meaning. */
const OUTPUT_LABELS: Record<string, string[]> = {
  'n8n-nodes-base.if': ['true', 'false'],
  'n8n-nodes-base.filter': ['kept', 'discarded'],
};

/**
 * n8n keys connections by node NAME. Rewriting each connection in terms of node
 * ids means a renamed node keeps its connections instead of showing them as
 * removed and re-added.
 */
function connectionsById(workflow: NormalizedWorkflow): Map<string, ConnectionRef> {
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const end = (name: string): ConnectionEnd => ({ id: nodesByName.get(name)?.id, name });
  // Connections to a node name that does not exist are keyed by name so they still compare.
  const endKey = (e: ConnectionEnd) => (e.id === undefined ? `name:${e.name}` : `id:${e.id}`);

  const result = new Map<string, ConnectionRef>();
  for (const [sourceName, byType] of Object.entries(workflow.connections)) {
    const source = end(sourceName);
    const labels = OUTPUT_LABELS[nodesByName.get(sourceName)?.type ?? ''];
    for (const [type, outputs] of Object.entries(byType)) {
      outputs.forEach((targets, output) => {
        for (const target of targets ?? []) {
          const ref: ConnectionRef = {
            source,
            type,
            output,
            outputLabel: labels?.[output],
            target: end(target.node),
            input: target.index,
          };
          const key = [
            endKey(source),
            type,
            output,
            endKey(ref.target),
            target.type,
            target.index,
          ].join('\0');
          result.set(key, ref);
        }
      });
    }
  }
  return result;
}

export function diffConnections(before: NormalizedWorkflow, after: NormalizedWorkflow): Change[] {
  const beforeConnections = connectionsById(before);
  const afterConnections = connectionsById(after);

  const removed = [...beforeConnections]
    .filter(([key]) => !afterConnections.has(key))
    .map(([, connection]) => connection);
  const added = [...afterConnections]
    .filter(([key]) => !beforeConnections.has(key))
    .map(([, connection]) => connection);

  return [
    ...removed
      .sort(compareConnections)
      .map((connection) => ({ kind: 'connection-removed' as const, connection })),
    ...added
      .sort(compareConnections)
      .map((connection) => ({ kind: 'connection-added' as const, connection })),
  ];
}

function compareConnections(a: ConnectionRef, b: ConnectionRef): number {
  return (
    compareStrings(a.source.name, b.source.name) ||
    compareStrings(a.type, b.type) ||
    a.output - b.output ||
    compareStrings(a.target.name, b.target.name) ||
    a.input - b.input
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
