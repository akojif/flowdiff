import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatPullResult, pull, tagToOffer, type PullResult } from '../src/commands/pull.js';
import type { Config } from '../src/config/config-file.js';
import { fakeClient, loadAllFixtures } from './helpers.js';

const config: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };

let cwd: string;
let client: ReturnType<typeof fakeClient>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flowdiff-pull-'));
  client = fakeClient(loadAllFixtures());
});

function outcomes(result: PullResult): Record<string, string> {
  return Object.fromEntries(result.entries.map((e) => [e.id, e.outcome]));
}

async function listFiles(): Promise<string[]> {
  return (await readdir(join(cwd, 'workflows'))).sort();
}

function workflowPath(file: string): string {
  return join(cwd, 'workflows', file);
}

function instanceWorkflow(id: string) {
  const workflow = client.workflows.find((w) => w.id === id);
  if (workflow === undefined) throw new Error(`no fixture ${id}`);
  return workflow;
}

describe('pull', () => {
  it('writes one normalized file per workflow', async () => {
    const result = await pull({ cwd, config, client });

    expect(outcomes(result)).toEqual({
      fixtureLinear001: 'created',
      fixtureIfBranch1: 'created',
      fixtureCredRef01: 'created',
    });
    expect(await listFiles()).toEqual([
      'fixture-credential-reference.fixtureCredRef01.json',
      'fixture-if-branch.fixtureIfBranch1.json',
      'fixture-linear.fixtureLinear001.json',
    ]);
    const content = await readFile(workflowPath('fixture-linear.fixtureLinear001.json'), 'utf8');
    expect(content).not.toContain('updatedAt');
    expect(content.endsWith('}\n')).toBe(true);
  });

  it('reports unchanged on a second pull without touching files', async () => {
    await pull({ cwd, config, client });
    const before = await readFile(workflowPath('fixture-linear.fixtureLinear001.json'), 'utf8');

    const result = await pull({ cwd, config, client });

    expect(new Set(Object.values(outcomes(result)))).toEqual(new Set(['unchanged']));
    expect(await readFile(workflowPath('fixture-linear.fixtureLinear001.json'), 'utf8')).toBe(
      before,
    );
  });

  it('ignores changes to volatile fields on the instance', async () => {
    await pull({ cwd, config, client });
    instanceWorkflow('fixtureLinear001').updatedAt = '2027-01-01T00:00:00.000Z';
    instanceWorkflow('fixtureLinear001').versionId = 'new-version';

    const result = await pull({ cwd, config, client });

    expect(outcomes(result).fixtureLinear001).toBe('unchanged');
  });

  it('updates a file when the workflow changed on the instance', async () => {
    await pull({ cwd, config, client });
    instanceWorkflow('fixtureLinear001').active = true;

    const result = await pull({ cwd, config, client });

    expect(outcomes(result).fixtureLinear001).toBe('updated');
    const content = await readFile(workflowPath('fixture-linear.fixtureLinear001.json'), 'utf8');
    expect(content).toContain('"active": true');
  });

  it('moves the file when the workflow is renamed on the instance', async () => {
    await pull({ cwd, config, client });
    instanceWorkflow('fixtureLinear001').name = 'Renamed Flow';

    const result = await pull({ cwd, config, client });

    expect(outcomes(result).fixtureLinear001).toBe('renamed');
    const files = await listFiles();
    expect(files).toContain('renamed-flow.fixtureLinear001.json');
    expect(files).not.toContain('fixture-linear.fixtureLinear001.json');
  });

  describe('local edits', () => {
    const file = 'fixture-linear.fixtureLinear001.json';

    beforeEach(async () => {
      await pull({ cwd, config, client });
      await writeFile(workflowPath(file), '{ "edited": true }\n');
    });

    it('keeps local edits when the instance did not change', async () => {
      const result = await pull({ cwd, config, client });

      expect(outcomes(result).fixtureLinear001).toBe('kept-local');
      expect(await readFile(workflowPath(file), 'utf8')).toBe('{ "edited": true }\n');
    });

    it('skips the file as a conflict when the instance also changed', async () => {
      instanceWorkflow('fixtureLinear001').active = true;

      const result = await pull({ cwd, config, client });

      expect(outcomes(result).fixtureLinear001).toBe('conflict');
      expect(await readFile(workflowPath(file), 'utf8')).toBe('{ "edited": true }\n');
    });

    it('overwrites local edits with --force', async () => {
      instanceWorkflow('fixtureLinear001').active = true;

      const result = await pull({ cwd, config, client, force: true });

      expect(outcomes(result).fixtureLinear001).toBe('updated');
      expect(await readFile(workflowPath(file), 'utf8')).toContain('"active": true');
    });
  });

  it('treats a differing file with no pull record as a conflict', async () => {
    await pull({ cwd, config, client });
    await writeFile(join(cwd, '.flowdiff', 'state.json'), '{"version":1,"workflows":{}}');
    await writeFile(workflowPath('fixture-linear.fixtureLinear001.json'), '{}\n');

    const result = await pull({ cwd, config, client });

    expect(outcomes(result).fixtureLinear001).toBe('conflict');
  });

  it('reports workflows deleted on the instance and leaves their files', async () => {
    await pull({ cwd, config, client });
    client.workflows = client.workflows.filter((w) => w.id !== 'fixtureIfBranch1');

    const result = await pull({ cwd, config, client });

    expect(result.missingOnInstance).toEqual(['fixture-if-branch.fixtureIfBranch1.json']);
    expect(await listFiles()).toContain('fixture-if-branch.fixtureIfBranch1.json');
  });

  it('only pulls tagged workflows with --tag and does not report the rest as missing', async () => {
    await pull({ cwd, config, client });

    const result = await pull({ cwd, config, client, tag: 'flowdiff-test' });

    expect(Object.keys(outcomes(result)).sort()).toEqual(['fixtureCredRef01', 'fixtureLinear001']);
    expect(result.missingOnInstance).toEqual([]);
  });

  it('skips archived workflows', async () => {
    instanceWorkflow('fixtureIfBranch1').isArchived = true;

    const result = await pull({ cwd, config, client });

    expect(outcomes(result)).not.toHaveProperty('fixtureIfBranch1');
  });

  it('records the instance version for each pulled workflow', async () => {
    await pull({ cwd, config, client });

    const state = JSON.parse(await readFile(join(cwd, '.flowdiff', 'state.json'), 'utf8')) as {
      workflows: Record<string, { versionId: string }>;
    };
    expect(state.workflows.fixtureLinear001?.versionId).toBe(
      '00000000-0000-4000-8000-00000000a001',
    );
  });
});

describe('formatPullResult', () => {
  it('lists changed files and summarizes counts', async () => {
    const result = await pull({ cwd, config, client });
    const text = formatPullResult(result, 'workflows');

    expect(text).toContain('workflows/fixture-linear.fixtureLinear001.json');
    expect(text).toContain('Pulled 3 workflow(s): 3 created.');
  });
});

describe('unknown top-level fields', () => {
  it('collects them across workflows and still writes them to disk', async () => {
    Object.assign(instanceWorkflow('fixtureLinear001'), { description: 'x', folderId: 'f1' });
    Object.assign(instanceWorkflow('fixtureIfBranch1'), { description: 'y' });

    const result = await pull({ cwd, config, client });

    expect(result.unknownFields).toEqual(['description', 'folderId']);
    const content = await readFile(workflowPath('fixture-linear.fixtureLinear001.json'), 'utf8');
    expect(content).toContain('"description": "x"');
  });

  it('prints a one-line notice naming them', async () => {
    Object.assign(instanceWorkflow('fixtureLinear001'), { description: 'x' });

    const text = formatPullResult(await pull({ cwd, config, client }), 'workflows');
    const notices = text.split('\n').filter((line) => line.includes('Notice:'));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('unrecognized top-level field(s): description.');
  });

  it('prints no notice when every field is known', async () => {
    const result = await pull({ cwd, config, client });

    expect(result.unknownFields).toEqual([]);
    expect(formatPullResult(result, 'workflows')).not.toContain('Notice:');
  });
});

describe('tagToOffer', () => {
  it('offers to save a --tag that is not saved yet', () => {
    expect(tagToOffer(config, 'flowdiff-test')).toBe('flowdiff-test');
  });

  it('offers to replace a different saved tag', () => {
    expect(tagToOffer({ ...config, tag: 'old' }, 'new')).toBe('new');
  });

  it('offers nothing when the tag is already saved, absent, or turned off', () => {
    expect(tagToOffer({ ...config, tag: 'same' }, 'same')).toBeUndefined();
    expect(tagToOffer(config, undefined)).toBeUndefined();
    expect(tagToOffer({ ...config, tag: 'saved' }, false)).toBeUndefined();
  });
});
