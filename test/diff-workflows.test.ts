import { describe, expect, it } from 'vitest';
import { diffWorkflows, formatPath, type Change, type ChangeKind } from '../src/diff/index.js';
import { normalizeWorkflow, type NormalizedWorkflow } from '../src/normalize/normalize.js';
import { at, loadFixture, nodeNamed, normalizedFixture } from './helpers.js';

const kinds = (changes: Change[]): ChangeKind[] => changes.map((c) => c.kind);

/** Returns the only change, failing if there is not exactly one. */
function only(changes: Change[]): Change {
  expect(changes).toHaveLength(1);
  return at(changes, 0);
}

const ALL_FIXTURES = [
  'linear.json',
  'if-branch.json',
  'credential-ref.json',
  'code-node.json',
  'node-groups.json',
];

describe('no changes', () => {
  it.each(ALL_FIXTURES)('%s against itself', (name) => {
    expect(diffWorkflows(normalizedFixture(name), normalizedFixture(name))).toEqual([]);
  });

  it.each(ALL_FIXTURES)('%s pulled twice with new volatile fields', (name) => {
    const first = loadFixture(name);
    const second = { ...loadFixture(name), updatedAt: '2027-01-01T00:00:00.000Z', versionId: 'v2' };
    expect(diffWorkflows(normalizeWorkflow(first), normalizeWorkflow(second))).toEqual([]);
  });
});

describe('workflow-level changes', () => {
  it('reports a workflow rename', () => {
    const before = normalizedFixture('linear.json');
    const after = { ...before, name: 'Renamed' };
    expect(only(diffWorkflows(before, after))).toEqual({
      kind: 'workflow-renamed',
      from: 'Fixture: Linear',
      to: 'Renamed',
    });
  });

  it('reports active on/off as a status change', () => {
    const before = normalizedFixture('linear.json');
    expect(only(diffWorkflows(before, { ...before, active: true }))).toEqual({
      kind: 'active-changed',
      from: false,
      to: true,
    });
  });

  it('reports tags added and removed', () => {
    const before = normalizedFixture('linear.json');
    const after = { ...before, tags: ['new-tag'] };
    expect(diffWorkflows(before, after)).toEqual([
      { kind: 'tag-added', tag: 'new-tag' },
      { kind: 'tag-removed', tag: 'flowdiff-test' },
    ]);
  });

  it('reports settings changes by path', () => {
    const before = normalizedFixture('if-branch.json');
    const after = { ...before, settings: { ...before.settings, timezone: 'Europe/London' } };
    const change = only(diffWorkflows(before, after));
    expect(change).toMatchObject({
      kind: 'setting-changed',
      change: { type: 'modified', from: 'UTC', to: 'Europe/London' },
    });
    expect(change.kind === 'setting-changed' && formatPath(change.path)).toBe('timezone');
  });

  it('reports unknown top-level fields generically', () => {
    const before = { ...normalizedFixture('linear.json'), description: 'old' };
    const after = { ...before, description: 'new' };
    expect(only(diffWorkflows(before, after))).toMatchObject({
      kind: 'field-changed',
      path: [{ key: 'description' }],
      change: { type: 'modified', from: 'old', to: 'new' },
    });
  });
});

describe('node changes', () => {
  it('reports an added node together with its new connection', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    after.nodes.push({
      id: 'new-node-id',
      name: 'Log',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [660, 0],
      parameters: {},
    });
    after.connections['Fetch Items'] = { main: [[{ node: 'Log', type: 'main', index: 0 }]] };

    const changes = diffWorkflows(before, after);

    expect(kinds(changes)).toEqual(['node-added', 'connection-added']);
    expect(changes[0]).toMatchObject({
      node: { id: 'new-node-id', name: 'Log', type: 'n8n-nodes-base.noOp' },
    });
  });

  it('reports a removed node and its removed connections', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    after.nodes = after.nodes.filter((n) => n.name !== 'Fetch Items');
    delete after.connections['Set Defaults'];

    expect(kinds(diffWorkflows(before, after))).toEqual(['node-removed', 'connection-removed']);
  });

  it('reports a rename as a rename, with no connection changes', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Set Defaults').name = 'Prepare';
    after.connections = {
      'Manual Trigger': { main: [[{ node: 'Prepare', type: 'main', index: 0 }]] },
      Prepare: { main: [[{ node: 'Fetch Items', type: 'main', index: 0 }]] },
    };

    expect(only(diffWorkflows(before, after))).toMatchObject({
      kind: 'node-renamed',
      node: { id: '11111111-1111-4111-8111-000000000002', name: 'Prepare' },
      from: 'Set Defaults',
      to: 'Prepare',
    });
  });

  it('reports type and typeVersion changes', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Fetch Items').typeVersion = 4.3;
    expect(only(diffWorkflows(before, after))).toMatchObject({
      kind: 'node-type-changed',
      field: 'typeVersion',
      from: 4.2,
      to: 4.3,
    });
  });

  it('reports the exact parameter path that changed', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    const set = nodeNamed(after, 'Set Defaults');
    set.parameters = structuredClone(set.parameters);
    const { assignments } = set.parameters.assignments as { assignments: { value: unknown }[] };
    at(assignments, 0).value = 20;

    const change = only(diffWorkflows(before, after));
    expect(change).toMatchObject({
      kind: 'parameter-changed',
      node: { name: 'Set Defaults' },
      change: { type: 'modified', from: 10, to: 20 },
    });
    expect(change.kind === 'parameter-changed' && formatPath(change.path)).toBe(
      'assignments.assignments[limit].value',
    );
  });

  it('gives Code node changes a line-level diff', () => {
    const before = normalizedFixture('code-node.json');
    const after = structuredClone(before);
    const code = nodeNamed(after, 'Transform Items');
    code.parameters = {
      jsCode: String(code.parameters.jsCode).replace(
        'return items;',
        'return items.filter(Boolean);',
      ),
    };

    const change = only(diffWorkflows(before, after));
    expect(change.kind === 'parameter-changed' && change.change).toMatchObject({
      type: 'text',
      hunks: [
        {
          lines: expect.arrayContaining([
            '-return items;',
            '+return items.filter(Boolean);',
          ]) as unknown,
        },
      ],
    });
  });

  it('gives AI prompt changes a line-level diff', () => {
    const before = normalizedFixture('code-node.json');
    const after = structuredClone(before);
    const agent = nodeNamed(after, 'Summarize');
    agent.parameters = {
      ...agent.parameters,
      options: {
        systemMessage:
          'You are a helpful assistant.\nSummarize the order in two sentences.\nNever include personal data.',
      },
    };

    const change = only(diffWorkflows(before, after));
    expect(change.kind === 'parameter-changed' && formatPath(change.path)).toBe(
      'options.systemMessage',
    );
    expect(change.kind === 'parameter-changed' && change.change.type).toBe('text');
  });

  it('reports other node properties such as disabled and notes', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    Object.assign(nodeNamed(after, 'Fetch Items'), { disabled: true, notes: 'Paused' });

    const changes = diffWorkflows(before, after);
    expect(kinds(changes)).toEqual(['node-property-changed', 'node-property-changed']);
    expect(
      changes.map((c) => (c.kind === 'node-property-changed' ? formatPath(c.path) : '')),
    ).toEqual(['disabled', 'notes']);
  });
});

describe('credentials', () => {
  const nodeName = 'Forward to API';

  it('reports a credential switch by name', () => {
    const before = normalizedFixture('credential-ref.json');
    const after = structuredClone(before);
    nodeNamed(after, nodeName).credentials = {
      httpHeaderAuth: { id: 'credFakeId000009', name: 'Other Key' },
    };

    expect(only(diffWorkflows(before, after))).toMatchObject({
      kind: 'credential-changed',
      node: { name: nodeName },
      credentialType: 'httpHeaderAuth',
      from: 'Example API Key',
      to: 'Other Key',
    });
  });

  it('ignores a credential id change when the name is the same', () => {
    const before = normalizedFixture('credential-ref.json');
    const after = structuredClone(before);
    nodeNamed(after, nodeName).credentials = {
      httpHeaderAuth: { id: 'idOnAnotherInstance', name: 'Example API Key' },
    };

    expect(diffWorkflows(before, after)).toEqual([]);
  });

  it('reports credentials added and removed', () => {
    const before = normalizedFixture('credential-ref.json');
    const after = structuredClone(before);
    delete nodeNamed(after, nodeName).credentials;

    expect(only(diffWorkflows(before, after))).toMatchObject({ from: 'Example API Key', to: null });
    expect(only(diffWorkflows(after, before))).toMatchObject({ from: null, to: 'Example API Key' });
  });
});

describe('layout', () => {
  const moved = () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Fetch Items').position = [500, 40];
    return { before, after };
  };

  it('ignores position changes by default', () => {
    const { before, after } = moved();
    expect(diffWorkflows(before, after)).toEqual([]);
  });

  it('reports them with includeLayout', () => {
    const { before, after } = moved();
    expect(only(diffWorkflows(before, after, { includeLayout: true }))).toMatchObject({
      kind: 'node-moved',
      from: [440, 0],
      to: [500, 40],
    });
  });
});

describe('connections', () => {
  it('reports connection changes with node names and ids', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    after.connections['Manual Trigger'] = {
      main: [[{ node: 'Fetch Items', type: 'main', index: 0 }]],
    };

    expect(diffWorkflows(before, after)).toMatchObject([
      {
        kind: 'connection-removed',
        connection: {
          source: { name: 'Manual Trigger' },
          target: { name: 'Set Defaults' },
          output: 0,
        },
      },
      {
        kind: 'connection-added',
        connection: {
          source: { name: 'Manual Trigger', id: '11111111-1111-4111-8111-000000000001' },
          target: { name: 'Fetch Items', id: '11111111-1111-4111-8111-000000000003' },
        },
      },
    ]);
  });

  it('reports a rename combined with a connection change as exactly one of each', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Fetch Items').name = 'Download';
    after.connections = {
      'Manual Trigger': {
        main: [
          [
            { node: 'Set Defaults', type: 'main', index: 0 },
            { node: 'Download', type: 'main', index: 0 },
          ],
        ],
      },
      'Set Defaults': { main: [[{ node: 'Download', type: 'main', index: 0 }]] },
    };

    const changes = diffWorkflows(before, after);
    expect(kinds(changes)).toEqual(['node-renamed', 'connection-added']);
    expect(changes[1]).toMatchObject({
      connection: { source: { name: 'Manual Trigger' }, target: { name: 'Download' } },
    });
  });

  it('keeps AI connection types apart from main', () => {
    const before = normalizedFixture('code-node.json');
    const after = structuredClone(before);
    delete after.connections['Chat Model'];

    expect(only(diffWorkflows(before, after))).toMatchObject({
      kind: 'connection-removed',
      connection: { type: 'ai_languageModel', source: { name: 'Chat Model' } },
    });
  });

  it('compares dangling connections by name', () => {
    const before = normalizedFixture('linear.json');
    before.connections.Ghost = { main: [[{ node: 'Fetch Items', type: 'main', index: 0 }]] };
    const after = structuredClone(before);

    expect(diffWorkflows(before, after)).toEqual([]);
    delete after.connections.Ghost;
    expect(only(diffWorkflows(before, after))).toMatchObject({
      connection: { source: { id: undefined, name: 'Ghost' } },
    });
  });
});

describe('IF branches', () => {
  const ifNode = 'Is Active?';

  it('reports swapped true/false outputs with their labels', () => {
    const before = normalizedFixture('if-branch.json');
    const after = structuredClone(before);
    after.connections[ifNode] = {
      main: [
        [{ node: 'Mark Inactive', type: 'main', index: 0 }],
        [{ node: 'Mark Active', type: 'main', index: 0 }],
      ],
    };

    expect(diffWorkflows(before, after)).toMatchObject([
      {
        kind: 'connection-removed',
        connection: { output: 0, outputLabel: 'true', target: { name: 'Mark Active' } },
      },
      {
        kind: 'connection-removed',
        connection: { output: 1, outputLabel: 'false', target: { name: 'Mark Inactive' } },
      },
      {
        kind: 'connection-added',
        connection: { output: 0, outputLabel: 'true', target: { name: 'Mark Inactive' } },
      },
      {
        kind: 'connection-added',
        connection: { output: 1, outputLabel: 'false', target: { name: 'Mark Active' } },
      },
    ]);
  });

  it('reports a removed false branch only on output 1', () => {
    const before = normalizedFixture('if-branch.json');
    const after = structuredClone(before);
    after.connections[ifNode] = { main: [[{ node: 'Mark Active', type: 'main', index: 0 }], []] };

    expect(only(diffWorkflows(before, after))).toMatchObject({
      kind: 'connection-removed',
      connection: { output: 1, outputLabel: 'false', target: { name: 'Mark Inactive' } },
    });
  });

  it('keeps branches intact when the IF node is renamed', () => {
    const before = normalizedFixture('if-branch.json');
    const after = structuredClone(before);
    nodeNamed(after, ifNode).name = 'Status OK?';
    after.connections = {
      'Every Hour': { main: [[{ node: 'Status OK?', type: 'main', index: 0 }]] },
      'Status OK?': at(
        [after.connections[ifNode]].filter((c) => c !== undefined),
        0,
      ),
    };

    expect(kinds(diffWorkflows(before, after))).toEqual(['node-renamed']);
  });

  it('reports the IF condition change by path', () => {
    const before = normalizedFixture('if-branch.json');
    const after = structuredClone(before);
    const node = nodeNamed(after, ifNode);
    node.parameters = structuredClone(node.parameters);
    const { conditions } = node.parameters.conditions as { conditions: { rightValue: string }[] };
    at(conditions, 0).rightValue = 'enabled';

    const change = only(diffWorkflows(before, after));
    expect(change.kind === 'parameter-changed' && formatPath(change.path)).toBe(
      'conditions.conditions[#bbbbbbbb-0000-4000-8000-000000000001].rightValue',
    );
  });
});

interface Group {
  id: string;
  name: string;
  description: string;
  nodeIds: Record<string, boolean>;
}

describe('node groups', () => {
  const groups = (w: NormalizedWorkflow) => w.nodeGroups as Group[];
  const setup = () => {
    const before = normalizedFixture('node-groups.json');
    return { before, after: structuredClone(before) };
  };

  it('reports groups added and removed', () => {
    const { before, after } = setup();
    after.nodeGroups = [
      groups(after)[0],
      { id: 'group-fake-0003', name: 'Report', description: '', nodeIds: {} },
    ];
    expect(diffWorkflows(before, after)).toMatchObject([
      { kind: 'group-added', group: { name: 'Report' } },
      { kind: 'group-removed', group: { name: 'Prepare' } },
    ]);
  });

  it('reports a renamed group and a description change', () => {
    const { before, after } = setup();
    at(groups(after), 0).name = 'Download';
    at(groups(after), 0).description = 'Loads data.';
    expect(kinds(diffWorkflows(before, after))).toEqual([
      'group-renamed',
      'group-description-changed',
    ]);
  });

  it('reports nodes joining and leaving a group by name', () => {
    const { before, after } = setup();
    at(groups(after), 0).nodeIds = { '55555555-5555-4555-8555-000000000001': true };
    expect(diffWorkflows(before, after)).toMatchObject([
      { kind: 'group-node-joined', group: { name: 'Fetch' }, node: { name: 'Start' } },
      { kind: 'group-node-left', group: { name: 'Fetch' }, node: { name: 'Load Data' } },
    ]);
  });
});

describe('purity', () => {
  it('does not modify its inputs', () => {
    const before = normalizedFixture('if-branch.json');
    const after = structuredClone(before);
    after.active = true;
    const snapshot = structuredClone([before, after]);
    diffWorkflows(before, after);
    expect([before, after]).toEqual(snapshot);
  });
});
