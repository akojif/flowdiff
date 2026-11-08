import { describe, expect, it } from 'vitest';
import { classifyChange, countChanges, hasBehaviorImpact, type Change } from '../src/diff/index.js';
import { at } from './helpers.js';

const node = { id: 'n1', name: 'Node', type: 'n8n-nodes-base.set' };
const group = { id: 'g1', name: 'Group' };
const connection = {
  source: { id: 'a', name: 'A' },
  type: 'main',
  output: 0,
  outputLabel: undefined,
  target: { id: 'b', name: 'B' },
  input: 0,
};
const modified = { type: 'modified' as const, from: 1, to: 2 };

const cosmetic: Change[] = [
  { kind: 'workflow-renamed', from: 'a', to: 'b' },
  { kind: 'node-renamed', node, from: 'a', to: 'b' },
  { kind: 'node-moved', node, from: [0, 0], to: [1, 1] },
  { kind: 'tag-added', tag: 't' },
  { kind: 'tag-removed', tag: 't' },
  { kind: 'group-added', group },
  { kind: 'group-removed', group },
  { kind: 'group-renamed', group, from: 'a', to: 'b' },
  { kind: 'group-description-changed', group, change: modified },
  { kind: 'group-node-joined', group, node: { id: 'n1', name: 'Node' } },
  { kind: 'group-node-left', group, node: { id: 'n1', name: 'Node' } },
  { kind: 'node-property-changed', node, path: [{ key: 'notes' }], change: modified },
  { kind: 'node-property-changed', node, path: [{ key: 'notesInFlow' }], change: modified },
  {
    kind: 'parameter-changed',
    node,
    path: [{ key: 'method' }],
    change: { type: 'added', value: 'GET' },
    possibleDefault: true,
  },
];

const behavior: Change[] = [
  { kind: 'active-changed', from: false, to: true },
  { kind: 'node-added', node },
  { kind: 'node-removed', node },
  { kind: 'node-type-changed', node, field: 'typeVersion', from: 1, to: 2 },
  {
    kind: 'parameter-changed',
    node,
    path: [{ key: 'url' }],
    change: modified,
    possibleDefault: false,
  },
  { kind: 'credential-changed', node, credentialType: 'x', from: 'a', to: 'b' },
  { kind: 'node-property-changed', node, path: [{ key: 'disabled' }], change: modified },
  { kind: 'connection-added', connection },
  { kind: 'connection-removed', connection },
  { kind: 'setting-changed', path: [{ key: 'timezone' }], change: modified },
  { kind: 'field-changed', path: [{ key: 'description' }], change: modified },
];

describe('classifyChange', () => {
  it.each(cosmetic.map((c) => [c.kind, c] as const))('%s is cosmetic', (_kind, change) => {
    expect(classifyChange(change)).toBe('cosmetic');
  });

  it.each(behavior.map((c) => [c.kind, c] as const))('%s is behavior', (_kind, change) => {
    expect(classifyChange(change)).toBe('behavior');
  });
});

describe('countChanges', () => {
  it('counts behavior, cosmetic and possible defaults', () => {
    expect(countChanges([...cosmetic, ...behavior])).toEqual({
      behavior: behavior.length,
      cosmetic: cosmetic.length,
      possibleDefaults: 1,
    });
  });
});

describe('hasBehaviorImpact', () => {
  const rename = at(cosmetic, 1);
  const warning = { kind: 'broken-reference', node, path: [], reference: 'Gone' };

  it('is false for cosmetic-only changes', () => {
    expect(hasBehaviorImpact({ changes: [rename], warnings: [] })).toBe(false);
  });

  it('is true for a cosmetic rename that left broken references', () => {
    expect(hasBehaviorImpact({ changes: [rename], warnings: [warning] })).toBe(true);
  });

  it('is true for behavior changes', () => {
    expect(hasBehaviorImpact({ changes: [at(behavior, 0)], warnings: [] })).toBe(true);
  });
});
