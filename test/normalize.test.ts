import { describe, expect, it } from 'vitest';
import type { ApiWorkflow } from '../src/api/schemas.js';
import {
  STRIPPED_FIELDS,
  normalizeWorkflow,
  serializeWorkflow,
  sortKeysDeep,
  unknownTopLevelFields,
} from '../src/normalize/index.js';
import { loadFixture } from './helpers.js';

const FIXTURES = ['linear.json', 'if-branch.json', 'credential-ref.json'];

/** True if every object's keys, at any depth, are in sorted order. */
function keysAreSorted(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(keysAreSorted);
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    const sorted = [...keys].sort();
    return keys.every((key, i) => key === sorted[i]) && Object.values(value).every(keysAreSorted);
  }
  return true;
}

describe.each(FIXTURES)('normalizeWorkflow(%s)', (name) => {
  const raw = loadFixture(name);
  const normalized = normalizeWorkflow(raw);

  it('removes every volatile field', () => {
    for (const field of STRIPPED_FIELDS) {
      expect(normalized).not.toHaveProperty(field);
    }
  });

  it('keeps id, name, active, nodes, connections and settings unchanged', () => {
    expect(normalized.id).toBe(raw.id);
    expect(normalized.name).toBe(raw.name);
    expect(normalized.active).toBe(raw.active);
    expect(normalized.nodes).toEqual(raw.nodes);
    expect(normalized.connections).toEqual(raw.connections);
    expect(normalized.settings).toEqual(raw.settings);
  });

  it('sorts keys at every depth', () => {
    expect(keysAreSorted(normalized)).toBe(true);
  });

  it('keeps node order', () => {
    expect(normalized.nodes.map((n) => n.id)).toEqual(raw.nodes.map((n) => n.id));
  });

  it('is idempotent', () => {
    const again = normalizeWorkflow(normalized as unknown as ApiWorkflow);
    expect(again).toEqual(normalized);
    expect(serializeWorkflow(again)).toBe(serializeWorkflow(normalized));
  });

  it('does not modify its input', () => {
    const before = structuredClone(raw);
    normalizeWorkflow(raw);
    expect(raw).toEqual(before);
  });

  it('ignores the key order of the API response', () => {
    const reordered = Object.fromEntries(Object.entries(raw).reverse()) as ApiWorkflow;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(raw));
    expect(serializeWorkflow(normalizeWorkflow(reordered))).toBe(serializeWorkflow(normalized));
  });
});

describe('normalizeWorkflow specifics', () => {
  it('reduces tags to sorted, unique names', () => {
    const workflow = {
      ...loadFixture('linear.json'),
      tags: [
        { id: 't2', name: 'zeta' },
        { id: 't1', name: 'alpha' },
        { id: 't3', name: 'alpha' },
      ],
    };
    expect(normalizeWorkflow(workflow).tags).toEqual(['alpha', 'zeta']);
  });

  it('uses an empty tag list when tags are missing', () => {
    const { tags, ...workflow } = loadFixture('linear.json');
    expect(tags).toBeDefined();
    expect(normalizeWorkflow(workflow).tags).toEqual([]);
  });

  it('keeps the IF node true and false outputs in order', () => {
    const normalized = normalizeWorkflow(loadFixture('if-branch.json'));
    const outputs = normalized.connections['Is Active?']?.main;
    expect(outputs?.map((targets) => targets?.map((t) => t.node))).toEqual([
      ['Mark Active'],
      ['Mark Inactive'],
    ]);
  });

  it('keeps credential references (id and name, no secrets)', () => {
    const normalized = normalizeWorkflow(loadFixture('credential-ref.json'));
    const httpNode = normalized.nodes.find((n) => n.name === 'Forward to API');
    expect(httpNode?.credentials).toEqual({
      httpHeaderAuth: { id: 'credFakeId000001', name: 'Example API Key' },
    });
  });

  it('keeps unknown top-level fields', () => {
    const workflow = { ...loadFixture('linear.json'), description: 'a newer n8n field' };
    expect(normalizeWorkflow(workflow)).toHaveProperty('description', 'a newer n8n field');
  });

  it('keeps array order inside parameters', () => {
    const workflow = loadFixture('linear.json');
    const node = workflow.nodes[0];
    if (node === undefined) throw new Error('fixture has no nodes');
    node.parameters = { list: ['c', 'a', 'b'] };
    expect(normalizeWorkflow(workflow).nodes[0]?.parameters).toEqual({ list: ['c', 'a', 'b'] });
  });
});

describe('serializeWorkflow', () => {
  it('uses 2-space indentation and ends with a newline', () => {
    expect(serializeWorkflow({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      2,\n      1\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});

describe('sortKeysDeep', () => {
  it('leaves primitives alone', () => {
    expect(sortKeysDeep('x')).toBe('x');
    expect(sortKeysDeep(null)).toBe(null);
    expect(sortKeysDeep(3)).toBe(3);
  });
});

describe('unknownTopLevelFields', () => {
  it('ignores kept and stripped fields', () => {
    expect(unknownTopLevelFields(loadFixture('linear.json'))).toEqual([]);
  });

  it('returns other fields sorted', () => {
    const workflow = { ...loadFixture('linear.json'), zeta: 1, alpha: 2 };
    expect(unknownTopLevelFields(workflow)).toEqual(['alpha', 'zeta']);
  });
});
