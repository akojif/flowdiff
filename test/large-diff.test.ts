import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiWorkflow } from '../src/api/schemas.js';
import { diffCommand, PUSH_TITLE, SUMMARY_THRESHOLD } from '../src/commands/diff.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import {
  compareWorkflowSets,
  countChanges,
  labelInstanceStatuses,
  type WorkflowComparison,
} from '../src/diff/index.js';
import type { NormalizedWorkflow } from '../src/normalize/normalize.js';
import { serializeWorkflow } from '../src/normalize/serialize.js';
import {
  orderForDisplay,
  renderJson,
  renderText,
  type TextRenderOptions,
} from '../src/render/index.js';
import { workflowFileName } from '../src/workspace/paths.js';
import { hashContent, writeState } from '../src/workspace/state.js';
import { generateLargeFixture, type LargeFixture } from './fixtures/large.js';
import { fakeClient } from './helpers.js';

const options: TextRenderOptions = {
  beforeLabel: 'instance',
  afterLabel: 'local',
  color: false,
  full: false,
  width: 110,
  title: PUSH_TITLE,
};

function comparisonsOf(fixture: LargeFixture): WorkflowComparison[] {
  return labelInstanceStatuses(
    compareWorkflowSets(fixture.instance, fixture.local, { activeSide: 'before' }),
    fixture.pulledIds,
  );
}

const byId = (comparisons: WorkflowComparison[], index: number) => {
  const found = comparisons.find((c) => c.id === `largeFixture${String(index).padStart(2, '0')}`);
  if (found === undefined) throw new Error(`no comparison for index ${String(index)}`);
  return found;
};

describe('generated 50-workflow fixture', () => {
  const comparisons = comparisonsOf(generateLargeFixture());

  it('is deterministic', () => {
    expect(comparisonsOf(generateLargeFixture())).toEqual(comparisons);
  });

  it('has the intended mix of statuses', () => {
    const statuses = Object.fromEntries(
      ['unchanged', 'changed', 'only-after', 'deleted-on-instance', 'untracked'].map((status) => [
        status,
        comparisons.filter((c) => c.status === status).length,
      ]),
    );
    expect(statuses).toEqual({
      unchanged: 12,
      changed: 32,
      'only-after': 2,
      'deleted-on-instance': 1,
      untracked: 3,
    });
  });

  it('marks cosmetic-only workflows as having no behavior changes', () => {
    for (let index = 12; index <= 21; index++) {
      expect(countChanges(byId(comparisons, index).changes).behavior).toBe(0);
    }
  });

  it('warns about a rename that left references to the old name', () => {
    for (const index of [43, 44]) {
      expect(byId(comparisons, index).warnings).toMatchObject([
        { node: { name: 'Transform' }, reference: 'Fetch Records' },
      ]);
    }
  });

  it('does not warn when references were updated with the rename', () => {
    const comparison = byId(comparisons, 45);
    expect(comparison.warnings).toEqual([]);
    expect(comparison.changes.map((c) => c.kind)).toEqual(['node-renamed', 'parameter-changed']);
  });
});

describe('display order', () => {
  const ordered = orderForDisplay(comparisonsOf(generateLargeFixture()));

  it('puts deleted workflows first, then broken references, then changed, then only-local', () => {
    const groups = ordered.map((c) =>
      c.status === 'deleted-on-instance'
        ? 'deleted'
        : c.warnings.length > 0
          ? 'warnings'
          : c.status,
    );
    expect(groups.slice(0, 3)).toEqual(['deleted', 'warnings', 'warnings']);
    expect(groups.indexOf('changed')).toBe(3);
    expect(groups.indexOf('only-after')).toBeGreaterThan(groups.lastIndexOf('changed'));
  });

  it('orders workflows with warnings among themselves by active, then changes', () => {
    const withWarnings = ordered.filter((c) => c.warnings.length > 0).map((c) => c.id);
    // 43 is active, 44 is not.
    expect(withWarnings).toEqual(['largeFixture43', 'largeFixture44']);
  });

  it('puts a new workflow with broken references in the warnings group', () => {
    const brokenNew: WorkflowComparison = {
      id: 'n',
      name: 'New',
      status: 'only-after',
      active: false,
      changes: [],
      warnings: [
        {
          kind: 'broken-reference',
          node: { id: 'x', name: 'X', type: 't' },
          path: [],
          reference: 'Gone',
        },
      ],
    };
    const changed: WorkflowComparison = {
      id: 'c',
      name: 'Changed',
      status: 'changed',
      active: false,
      changes: [],
      warnings: [],
    };
    expect(orderForDisplay([changed, brokenNew]).map((c) => c.id)).toEqual(['n', 'c']);
  });

  it('sorts changed workflows by active, then behavior changes, then cosmetic changes', () => {
    const changed = ordered.filter((c) => c.status === 'changed' && c.warnings.length === 0);
    const keys = changed.map((c) => {
      const counts = countChanges(c.changes);
      return [c.active ? 1 : 0, counts.behavior, counts.cosmetic];
    });
    for (let i = 1; i < keys.length; i++) {
      const [a, b] = [keys[i - 1] ?? [], keys[i] ?? []];
      const firstDifference = a.findIndex((value, j) => value !== b[j]);
      if (firstDifference !== -1)
        expect(a[firstDifference]).toBeGreaterThan(b[firstDifference] ?? 0);
    }
  });

  it('breaks ties by name', () => {
    const ties = [
      { id: 'b', name: 'Beta', status: 'changed', active: false, changes: [], warnings: [] },
      { id: 'a', name: 'Alpha', status: 'changed', active: false, changes: [], warnings: [] },
    ] satisfies WorkflowComparison[];
    expect(orderForDisplay(ties).map((c) => c.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('summary view', () => {
  it('renders one line per workflow for the 50-workflow fixture', () => {
    const text = renderText(comparisonsOf(generateLargeFixture()), { ...options, view: 'summary' });
    expect(text).toMatchSnapshot();
  });

  it('cuts long names to fit the width', () => {
    const long: WorkflowComparison[] = [
      {
        id: 'x1',
        name: 'A'.repeat(120),
        status: 'only-after',
        active: false,
        changes: [],
        warnings: [],
      },
    ];
    const line = renderText(long, { ...options, view: 'summary', width: 80 }).split('\n')[2] ?? '';
    expect(line).toContain('…');
    expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('detail view', () => {
  it('shows broken-reference warnings under the workflow and counts them', () => {
    const comparisons = comparisonsOf(generateLargeFixture()).filter(
      (c) => c.id === 'largeFixture43',
    );
    expect(renderText(comparisons, options)).toMatchInlineSnapshot(`
      "Changes push would make to the instance

      ~ Ticket Import 43 (largeFixture43)  active
          ⚠ "Transform" › jsCode references "Fetch Records", which is not a node in this workflow
          cosmetic:
            ~ node    "Fetch Records" renamed to "Load Records"

      1 changed (0 with behavior changes), 0 unchanged, 1 broken reference.
      Broken references: expressions or Code nodes refer to node names that do not exist, often after a rename. These nodes will fail when they run."
    `);
  });
});

describe('JSON output', () => {
  const parsed = JSON.parse(renderJson(comparisonsOf(generateLargeFixture()), options)) as {
    workflows: { id: string; name: string; counts: unknown; changes: { impact: string }[] }[];
  };

  it('keeps name/id order', () => {
    const names = parsed.workflows.map((w) => w.name);
    expect(names).toEqual([...names].sort());
  });

  it('adds impact to every change and counts to every workflow', () => {
    const changes = parsed.workflows.flatMap((w) => w.changes);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.impact === 'behavior' || c.impact === 'cosmetic')).toBe(true);
    expect(parsed.workflows.find((w) => w.id === 'largeFixture15')?.counts).toEqual({
      behavior: 0,
      cosmetic: 1,
      possibleDefaults: 1,
    });
  });
});

describe('summary threshold in the diff command', () => {
  const config: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };

  /** Writes the fixture (optionally a subset of ids) as a project and returns a runner. */
  async function project(include: (id: string) => boolean = () => true) {
    const fixture = generateLargeFixture();
    const cwd = await mkdtemp(join(tmpdir(), 'flowdiff-large-'));
    await writeConfig(cwd, config);
    await mkdir(join(cwd, 'workflows'));
    for (const workflow of fixture.local.values()) {
      if (!include(workflow.id)) continue;
      await writeFile(
        join(cwd, 'workflows', workflowFileName(workflow)),
        serializeWorkflow(workflow),
      );
    }
    const pulled = [...fixture.pulledIds].filter(include);
    await writeState(cwd, {
      version: 1,
      workflows: Object.fromEntries(
        pulled.map((id) => [
          id,
          { hash: hashContent(id), versionId: null, updatedAt: '2026-01-01' },
        ]),
      ),
    });
    const toApi = (w: NormalizedWorkflow): ApiWorkflow => ({
      ...w,
      tags: w.tags.map((name) => ({ id: `tag-${name}`, name })),
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const client = fakeClient(
      [...fixture.instance.values()].filter((w) => include(w.id)).map(toApi),
    );
    return (flags: Parameters<typeof diffCommand>[0]['flags'] = {}, target?: string) =>
      diffCommand({
        cwd,
        config,
        target,
        flags,
        getClient: () => client,
        color: false,
        width: 110,
      });
  }

  const isSummary = (output: string) => output.includes('summary view');
  // Unchanged workflows plus the first `n` behavior-change workflows.
  const unchangedPlus = (n: number) => (id: string) => {
    const index = Number(id.slice(-2));
    return index <= 11 || (index >= 22 && index < 22 + n);
  };

  it(`shows details for ${String(SUMMARY_THRESHOLD)} changed workflows`, async () => {
    const run = await project(unchangedPlus(SUMMARY_THRESHOLD));
    expect(isSummary((await run()).output)).toBe(false);
  });

  it(`switches to the summary for ${String(SUMMARY_THRESHOLD + 1)} changed workflows`, async () => {
    const run = await project(unchangedPlus(SUMMARY_THRESHOLD + 1));
    expect(isSummary((await run()).output)).toBe(true);
  });

  it('--no-stat shows every change even for 50 workflows', async () => {
    const run = await project();
    const { output } = await run({ stat: false });
    expect(isSummary(output)).toBe(false);
    expect(output).toContain('possible defaults:');
  });

  it('--stat forces the summary for a single workflow', async () => {
    const run = await project();
    const { output } = await run({ stat: true }, 'largeFixture22');
    expect(isSummary(output)).toBe(true);
    expect(output).toContain('Changes push would make to the instance: 1 workflow, summary view');
  });

  it('does not count untracked workflows toward the threshold', async () => {
    const run = await project(
      (id) => unchangedPlus(SUMMARY_THRESHOLD)(id) || ['40', '41', '42'].includes(id.slice(-2)),
    );
    expect(isSummary((await run()).output)).toBe(false);
  });
});
