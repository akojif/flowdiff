import type { NormalizedWorkflow } from '../normalize/normalize.js';
import type { NodeRef, PathSegment } from './types.js';
import { isPlainObject } from './values.js';

export interface BrokenReference {
  kind: 'broken-reference';
  /** The node whose parameter contains the reference. */
  node: NodeRef;
  path: PathSegment[];
  /** The node name being referenced, which does not exist in the workflow. */
  reference: string;
}

/**
 * Ways expressions and Code nodes refer to other nodes by name:
 *   $('Name')  $("Name")  $(`Name`)  $node["Name"]  $node['Name']  $node.Name  $items("Name")
 * Each pattern captures the quote character (if any) and the name.
 */
const REFERENCE_PATTERNS = [
  /\$\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g,
  /\$items\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
  /\$node\[\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\]/g,
  /\$node\.()([A-Za-z_$][\w$]*)/g,
];

/** Sticky notes hold free text, which may mention node names without referencing them. */
const FREE_TEXT_NODE_TYPES = new Set(['n8n-nodes-base.stickyNote']);

/** Node names referenced in a string. Template literals with `${...}` are skipped: they are dynamic. */
export function referencedNodeNames(text: string): string[] {
  const names: string[] = [];
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const [, quote, raw] = match;
      if (raw === undefined || (quote === '`' && raw.includes('${'))) continue;
      names.push(raw.replace(/\\(.)/g, '$1'));
    }
  }
  return names;
}

/**
 * Finds parameters that reference a node name that does not exist in the
 * workflow, e.g. after a rename where expressions were not updated. Pure.
 */
export function findBrokenReferences(workflow: NormalizedWorkflow): BrokenReference[] {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const broken: BrokenReference[] = [];

  for (const node of workflow.nodes) {
    if (FREE_TEXT_NODE_TYPES.has(node.type)) continue;
    const ref: NodeRef = { id: node.id, name: node.name, type: node.type };
    for (const { path, text } of stringsIn(node.parameters, [])) {
      const missing = [...new Set(referencedNodeNames(text))].filter((name) => !names.has(name));
      for (const reference of missing) {
        broken.push({ kind: 'broken-reference', node: ref, path, reference });
      }
    }
  }
  return broken;
}

function* stringsIn(
  value: unknown,
  path: PathSegment[],
): Generator<{ path: PathSegment[]; text: string }> {
  if (typeof value === 'string') {
    yield { path, text: value };
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringsIn(item, [...path, { index }]);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) yield* stringsIn(value[key], [...path, { key }]);
  }
}
