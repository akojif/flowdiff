import { createHash } from 'node:crypto';
import type { NodeRef, PathSegment } from '../diff/types.js';
import { isPlainObject } from '../diff/values.js';
import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { findSecretsInString, isSensitiveName, looksLikeLiteralSecret } from './detectors.js';

export interface SecretFinding {
  kind: 'possible-secret';
  node: NodeRef;
  /** Path within the node's parameters, or `[{ key: 'notes' }]` for node notes. */
  path: PathSegment[];
  label: string;
}

type Visit = (path: PathSegment[], text: string, sensitiveLabel: string | undefined) => string;

/**
 * Walks every string in a node's parameters and notes. `sensitiveLabel` is set
 * when the string sits at a sensitive name, either its own key (`apiKey`) or
 * the `name` of an n8n name/value pair (`{ name: "Authorization", value }`).
 * The visitor's return value replaces the string.
 */
function mapNodeStrings(node: NormalizedWorkflow['nodes'][number], visit: Visit) {
  const walk = (value: unknown, path: PathSegment[], sensitive: string | undefined): unknown => {
    if (typeof value === 'string') return visit(path, value, sensitive);
    if (Array.isArray(value))
      return value.map((item, index) => walk(item, [...path, { index }], undefined));
    if (!isPlainObject(value)) return value;
    const pairName =
      typeof value.name === 'string' && isSensitiveName(value.name) ? value.name : undefined;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const label =
          key === 'value' && pairName !== undefined
            ? `value of "${pairName}"`
            : isSensitiveName(key)
              ? `"${key}"`
              : undefined;
        return [key, walk(child, [...path, { key }], label)];
      }),
    );
  };
  const parameters = walk(node.parameters, [], undefined) as Record<string, unknown>;
  const notes =
    typeof node.notes === 'string'
      ? (walk(node.notes, [{ key: 'notes' }], undefined) as string)
      : undefined;
  return { parameters, notes };
}

/** Possible hard-coded secrets in a workflow's node parameters and notes. Pure. */
export function scanWorkflowSecrets(workflow: NormalizedWorkflow): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const node of workflow.nodes) {
    const ref: NodeRef = { id: node.id, name: node.name, type: node.type };
    mapNodeStrings(node, (path, text, sensitive) => {
      const [first] = findSecretsInString(text);
      if (first !== undefined) {
        findings.push({ kind: 'possible-secret', node: ref, path, label: first.label });
      } else if (sensitive !== undefined && looksLikeLiteralSecret(text)) {
        findings.push({
          kind: 'possible-secret',
          node: ref,
          path,
          label: `literal value in ${sensitive}`,
        });
      }
      return text;
    });
  }
  return findings;
}

/**
 * A copy of the workflow with possible secrets replaced by markers such as
 * `‹redacted bearer token #3f9a›`. The short fingerprint makes a changed secret
 * still show up as a change in a diff without revealing either value. Pure.
 */
export function redactWorkflow(workflow: NormalizedWorkflow): NormalizedWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const { parameters, notes } = mapNodeStrings(node, (_path, text, sensitive) => {
        if (
          sensitive !== undefined &&
          looksLikeLiteralSecret(text) &&
          findSecretsInString(text).length === 0
        ) {
          return marker('secret', text);
        }
        return redactString(text);
      });
      return { ...node, parameters, ...(notes === undefined ? {} : { notes }) };
    }),
  };
}

/** Replaces each secret inside a string with a marker, keeping the text around it. */
export function redactString(text: string): string {
  let result = '';
  let position = 0;
  for (const match of findSecretsInString(text)) {
    result +=
      text.slice(position, match.start) + marker(match.label, text.slice(match.start, match.end));
    position = match.end;
  }
  return result + text.slice(position);
}

export const REDACTION_PREFIX = '‹redacted';

function marker(label: string, secret: string): string {
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 4);
  return `${REDACTION_PREFIX} ${label} #${fingerprint}›`;
}
