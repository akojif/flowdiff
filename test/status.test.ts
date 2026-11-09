import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pull } from '../src/commands/pull.js';
import { statusCommand, type StatusFlags } from '../src/commands/status.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import type { SyncStatus } from '../src/workspace/status.js';
import { at, fakeClient, loadAllFixtures } from './helpers.js';

const config: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };
const LINEAR = join('workflows', 'fixture-linear.fixtureLinear001.json');

let cwd: string;
let client: ReturnType<typeof fakeClient>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flowdiff-status-'));
  client = fakeClient(loadAllFixtures());
  await writeConfig(cwd, config);
  await pull({ cwd, config, client });
});

async function statusOf(id: string, flags: StatusFlags = {}): Promise<SyncStatus | undefined> {
  const { statuses } = await statusCommand({ cwd, config, client, flags, color: false });
  return statuses.find((s) => s.id === id)?.status;
}

async function editLocal(file: string, edit: (w: Record<string, unknown>) => void): Promise<void> {
  const workflow = JSON.parse(await readFile(join(cwd, file), 'utf8')) as Record<string, unknown>;
  edit(workflow);
  await writeFile(join(cwd, file), `${JSON.stringify(workflow, null, 2)}\n`);
}

function editInstance(id: string, edit: (w: (typeof client.workflows)[number]) => void): void {
  const workflow = client.workflows.find((w) => w.id === id);
  if (workflow === undefined) throw new Error(`no workflow ${id}`);
  edit(workflow);
}

describe('computeStatuses via the status command', () => {
  it('reports unchanged right after a pull', async () => {
    expect(await statusOf('fixtureLinear001')).toBe('unchanged');
  });

  it('ignores volatile instance fields', async () => {
    editInstance('fixtureLinear001', (w) => {
      w.updatedAt = '2027-01-01T00:00:00.000Z';
      w.versionId = 'new';
    });
    expect(await statusOf('fixtureLinear001')).toBe('unchanged');
  });

  it('reports modified locally', async () => {
    await editLocal(LINEAR, (w) => (w.active = true));
    expect(await statusOf('fixtureLinear001')).toBe('modified-locally');
  });

  it('reports modified on instance', async () => {
    editInstance('fixtureLinear001', (w) => (w.name = 'Renamed on instance'));
    expect(await statusOf('fixtureLinear001')).toBe('modified-on-instance');
  });

  it('reports a conflict when both sides changed', async () => {
    await editLocal(LINEAR, (w) => (w.active = true));
    editInstance('fixtureLinear001', (w) => (w.name = 'Renamed on instance'));
    expect(await statusOf('fixtureLinear001')).toBe('conflict');
  });

  it('reports unchanged when both sides made the same change', async () => {
    await editLocal(LINEAR, (w) => (w.active = true));
    editInstance('fixtureLinear001', (w) => (w.active = true));
    expect(await statusOf('fixtureLinear001')).toBe('unchanged');
  });

  it('reports deleted on instance for a pulled workflow that is gone', async () => {
    client.workflows = client.workflows.filter((w) => w.id !== 'fixtureLinear001');
    expect(await statusOf('fixtureLinear001')).toBe('deleted-on-instance');
  });

  it('reports new locally for a file with no pull record and no instance workflow', async () => {
    const content = (await readFile(join(cwd, LINEAR), 'utf8'))
      .replace('"fixtureLinear001"', '"newLocal00000001"')
      .replace('"Fixture: Linear"', '"Draft"');
    await writeFile(join(cwd, 'workflows', 'draft.newLocal00000001.json'), content);
    expect(await statusOf('newLocal00000001')).toBe('new-locally');
  });

  it('reports no pull record when both sides exist, differ, and there is no record', async () => {
    await writeFile(join(cwd, '.flowdiff', 'state.json'), '{"version":1,"workflows":{}}');
    await editLocal(LINEAR, (w) => (w.active = true));
    expect(await statusOf('fixtureLinear001')).toBe('no-pull-record');
  });

  it('reports untracked instance workflows', async () => {
    await rm(join(cwd, LINEAR));
    expect(await statusOf('fixtureLinear001')).toBe('untracked');
  });

  it('uses the tag scope', async () => {
    const tagged: Config = { ...config, tag: 'flowdiff-test' };
    const { statuses } = await statusCommand({
      cwd,
      config: tagged,
      client,
      flags: {},
      color: false,
    });
    // if-branch is tracked locally, so it stays in scope despite having no tag.
    expect(statuses.map((s) => s.id).sort()).toEqual([
      'fixtureCredRef01',
      'fixtureIfBranch1',
      'fixtureLinear001',
    ]);
  });
});

describe('status output', () => {
  it('lists workflows needing attention in order, with hints', async () => {
    await editLocal(LINEAR, (w) => (w.active = true));
    await editLocal(
      join('workflows', 'fixture-if-branch.fixtureIfBranch1.json'),
      (w) => (w.active = false),
    );
    editInstance('fixtureIfBranch1', (w) => (w.name = 'Changed on instance'));
    client.workflows.push({
      ...structuredClone(at(client.workflows, 0)),
      id: 'untracked0000001',
      name: 'Elsewhere',
    });

    const { output } = await statusCommand({ cwd, config, client, flags: {}, color: false });

    expect(output).toMatchInlineSnapshot(`
      "Status

        conflict              Fixture: IF Branch (fixtureIfBranch1)  changed locally and on the instance
        modified locally      Fixture: Linear (fixtureLinear001)     run flowdiff push

      2 need attention, 1 unchanged.
      1 workflow on the instance isn't tracked locally (run flowdiff pull to add them)"
    `);
  });

  it('says when everything is in sync', async () => {
    const { output } = await statusCommand({ cwd, config, client, flags: {}, color: false });
    expect(output).toContain('Everything is in sync (3 unchanged).');
  });

  it('outputs JSON', async () => {
    const { output } = await statusCommand({
      cwd,
      config,
      client,
      flags: { json: true },
      color: false,
    });
    const parsed = JSON.parse(output) as {
      workflows: { id: string; status: string; file: string | null }[];
    };
    expect(parsed.workflows.find((w) => w.id === 'fixtureLinear001')).toEqual({
      id: 'fixtureLinear001',
      name: 'Fixture: Linear',
      status: 'unchanged',
      file: LINEAR,
      secrets: 0,
    });
  });
});
