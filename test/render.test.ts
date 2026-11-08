import { describe, expect, it } from 'vitest';
import { compareWorkflowSets, type WorkflowComparison } from '../src/diff/index.js';
import type { NormalizedWorkflow } from '../src/normalize/normalize.js';
import {
  formatValue,
  renderJson,
  renderText,
  type TextRenderOptions,
} from '../src/render/index.js';
import { at, nodeNamed, normalizedFixture } from './helpers.js';

/** Start of an ANSI color escape sequence. */
const ESC = '\u001b[';

const options: TextRenderOptions = {
  beforeLabel: 'instance',
  afterLabel: 'local',
  color: false,
  full: false,
};

function compareOne(before: NormalizedWorkflow, after: NormalizedWorkflow): WorkflowComparison[] {
  return compareWorkflowSets(new Map([[before.id, before]]), new Map([[after.id, after]]));
}

describe('renderText', () => {
  it('renders every kind of change readably', () => {
    const before = normalizedFixture('if-branch.json');
    const after = structuredClone(before);
    after.active = false;
    after.tags = ['reviewed'];
    after.settings = { ...after.settings, timezone: 'Europe/London' };
    nodeNamed(after, 'Is Active?').name = 'Status OK?';
    nodeNamed(after, 'Mark Inactive').disabled = true;
    after.nodes.push({
      id: 'new-node',
      name: 'Notify',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [660, 200],
      parameters: {},
    });
    after.connections = {
      'Every Hour': { main: [[{ node: 'Status OK?', type: 'main', index: 0 }]] },
      'Status OK?': {
        main: [
          [{ node: 'Mark Active', type: 'main', index: 0 }],
          [{ node: 'Notify', type: 'main', index: 0 }],
        ],
      },
    };

    expect(renderText(compareOne(before, after), options)).toMatchInlineSnapshot(`
      "instance → local

      ~ Fixture: IF Branch (fixtureIfBranch1)
          ~ status  active → inactive
          + tag     reviewed
          ~ node    "Is Active?" renamed to "Status OK?"
          + prop    "Mark Inactive" › disabled: true
          + node    "Notify" (n8n-nodes-base.noOp)
          - link    "Is Active?" (false) → "Mark Inactive"
          + link    "Status OK?" (false) → "Notify"
          ~ setting timezone: "UTC" → "Europe/London"

      1 changed, 0 unchanged."
    `);
  });

  it('renders multi-line text as hunks', () => {
    const before = normalizedFixture('code-node.json');
    const after = structuredClone(before);
    const code = nodeNamed(after, 'Transform Items');
    code.parameters = {
      jsCode: String(code.parameters.jsCode).replace(
        'return items;',
        'return items.filter(Boolean);',
      ),
    };

    expect(renderText(compareOne(before, after), options)).toMatchInlineSnapshot(`
      "instance → local

      ~ Fixture: Code and AI (fixtureCodeNode1)
          ~ param   "Transform Items" › jsCode
                    @@ -4,4 +4,4 @@
                       item.json.total = item.json.price * item.json.quantity;
                     }
                     
                    -return items;
                    +return items.filter(Boolean);

      1 changed, 0 unchanged."
    `);
  });

  it('renders credential, group and layout changes', () => {
    const before = normalizedFixture('node-groups.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Load Data').credentials = {
      httpHeaderAuth: { id: 'x', name: 'Example Key' },
    };
    at(after.nodeGroups as { name: string }[], 0).name = 'Download';
    nodeNamed(after, 'Start').position = [10, 10];

    const comparisons = compareWorkflowSets(
      new Map([[before.id, before]]),
      new Map([[after.id, after]]),
      {
        includeLayout: true,
      },
    );
    expect(renderText(comparisons, options)).toMatchInlineSnapshot(`
      "instance → local

      ~ Fixture: Node Groups (fixtureGroups001)
          ~ layout  "Start" [0,0] → [10,10]
          + cred    "Load Data" httpHeaderAuth: "Example Key"
          ~ group   "Fetch" renamed to "Download"

      1 changed, 0 unchanged."
    `);
  });

  it('lists workflows that exist on one side only and summarizes', () => {
    const linear = normalizedFixture('linear.json');
    const ifBranch = normalizedFixture('if-branch.json');
    const code = normalizedFixture('code-node.json');
    const comparisons = compareWorkflowSets(
      new Map([
        [linear.id, linear],
        [ifBranch.id, ifBranch],
      ]),
      new Map([
        [linear.id, linear],
        [code.id, code],
      ]),
    );

    expect(renderText(comparisons, options)).toMatchInlineSnapshot(`
      "instance → local

      + Fixture: Code and AI (fixtureCodeNode1)  only in local

      - Fixture: IF Branch (fixtureIfBranch1)  only in instance

      0 changed, 1 unchanged, 1 only in local, 1 only in instance."
    `);
  });

  it('says so when nothing changed', () => {
    const linear = normalizedFixture('linear.json');
    expect(renderText(compareOne(linear, linear), options)).toMatchInlineSnapshot(`
      "instance → local

      No changes (1 unchanged)."
    `);
  });

  it('uses colors only when asked', () => {
    const before = normalizedFixture('linear.json');
    const after = { ...before, active: true };
    expect(renderText(compareOne(before, after), options)).not.toContain(ESC);
    expect(renderText(compareOne(before, after), { ...options, color: true })).toContain(ESC);
  });
});

describe('truncation', () => {
  const long = 'x'.repeat(200);

  it('truncates long single-line values with a clear marker', () => {
    expect(formatValue(long, { full: false })).toBe(
      `"${'x'.repeat(79)}… [truncated, 202 chars; use --full]`,
    );
  });

  it('shows the whole value with full', () => {
    expect(formatValue(long, { full: true })).toBe(`"${long}"`);
  });

  it('leaves short values alone', () => {
    expect(formatValue({ a: 1 }, { full: false })).toBe('{"a":1}');
  });

  it('applies to rendered parameter changes, and --full turns it off', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Fetch Items').parameters = {
      ...nodeNamed(after, 'Fetch Items').parameters,
      url: `https://api.example.com/${long}`,
    };

    expect(renderText(compareOne(before, after), options)).toContain('[truncated,');
    expect(renderText(compareOne(before, after), { ...options, full: true })).not.toContain(
      '[truncated,',
    );
  });

  it('never truncates JSON output', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Fetch Items').parameters = { url: long };

    expect(renderJson(compareOne(before, after), options)).toContain(long);
  });
});

describe('renderJson', () => {
  it('is parseable and includes labels, statuses and changes', () => {
    const before = normalizedFixture('linear.json');
    const after = { ...before, active: true };
    const parsed = JSON.parse(renderJson(compareOne(before, after), options)) as {
      before: string;
      after: string;
      workflows: WorkflowComparison[];
    };

    expect(parsed.before).toBe('instance');
    expect(parsed.after).toBe('local');
    expect(parsed.workflows[0]).toMatchObject({
      id: 'fixtureLinear001',
      status: 'changed',
      changes: [{ kind: 'active-changed', from: false, to: true }],
    });
  });

  it('writes absent values as null', () => {
    const before = normalizedFixture('linear.json');
    before.connections.Ghost = { main: [[{ node: 'Fetch Items', type: 'main', index: 0 }]] };
    const after = normalizedFixture('linear.json');

    const json = renderJson(compareOne(before, after), options);
    expect(json).toContain('"id": null');
    expect(json).toContain('"outputLabel": null');
  });
});
