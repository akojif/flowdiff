import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffCommand, runDiff, type DiffCommandOptions } from '../src/commands/diff.js';
import { pull } from '../src/commands/pull.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import { fakeClient, loadAllFixtures } from './helpers.js';

const config: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };
const LINEAR_FILE = join('workflows', 'fixture-linear.fixtureLinear001.json');

let cwd: string;
let client: ReturnType<typeof fakeClient>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flowdiff-diff-'));
  client = fakeClient(loadAllFixtures());
  await writeConfig(cwd, config);
  await pull({ cwd, config, client });
});

function run(overrides: Partial<DiffCommandOptions> = {}) {
  return diffCommand({
    cwd,
    config,
    flags: {},
    getClient: () => client,
    color: false,
    ...overrides,
  });
}

/** Edits a pulled workflow file in place. */
async function editFile(
  file: string,
  edit: (workflow: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(cwd, file);
  const workflow = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(workflow);
  await writeFile(path, `${JSON.stringify(workflow, null, 2)}\n`);
}

describe('local vs instance', () => {
  it('reports no changes right after a pull', async () => {
    const result = await run();
    expect(result.differs).toBe(false);
    expect(result.output).toContain('No changes (3 unchanged).');
  });

  it('shows local edits as instance → local', async () => {
    await editFile(LINEAR_FILE, (w) => (w.active = true));

    const result = await run();

    expect(result.differs).toBe(true);
    expect(result.output).toContain('instance → local');
    expect(result.output).toContain('status  inactive → active');
  });

  it('lists workflows that exist only on the instance', async () => {
    await rm(join(cwd, LINEAR_FILE));
    const result = await run();
    expect(result.output).toContain('Fixture: Linear (fixtureLinear001)  only in instance');
  });

  it('outputs JSON with --json', async () => {
    await editFile(LINEAR_FILE, (w) => (w.active = true));
    const parsed = JSON.parse((await run({ flags: { json: true } })).output) as {
      before: string;
      workflows: { id: string; status: string }[];
    };
    expect(parsed.before).toBe('instance');
    expect(parsed.workflows.find((w) => w.id === 'fixtureLinear001')?.status).toBe('changed');
  });

  it.each([
    ['id', 'fixtureLinear001'],
    ['file path', LINEAR_FILE],
    ['file name', 'fixture-linear.fixtureLinear001.json'],
    ['name', 'fixture: linear'],
    ['slug', 'fixture-linear'],
  ])('selects one workflow by %s', async (_kind, selector) => {
    const result = await run({ target: selector, flags: { json: true } });
    const parsed = JSON.parse(result.output) as { workflows: { id: string }[] };
    expect(parsed.workflows.map((w) => w.id)).toEqual(['fixtureLinear001']);
  });

  it('explains when no workflow matches', async () => {
    await expect(run({ target: 'nope' })).rejects.toThrow(/No workflow matches "nope"/);
  });

  it('lists the candidates when a selector is ambiguous', async () => {
    await editFile(
      join('workflows', 'fixture-if-branch.fixtureIfBranch1.json'),
      (w) => (w.name = 'Fixture: Linear'),
    );
    await expect(run({ target: 'Fixture: Linear' })).rejects.toThrow(
      /matches more than one workflow/,
    );
  });

  it('rejects a second argument without a git range', async () => {
    await expect(run({ target: 'a', workflow: 'b' })).rejects.toThrow(/Unexpected argument "b"/);
  });

  it('rejects a file whose content id does not match its file name', async () => {
    await editFile(LINEAR_FILE, (w) => (w.id = 'someOtherId'));
    await expect(run()).rejects.toThrow(
      /contains workflow id "someOtherId", but its file name says "fixtureLinear001"/,
    );
  });

  it('reports an invalid local file clearly', async () => {
    await writeFile(join(cwd, LINEAR_FILE), '{"id":"fixtureLinear001"}');
    await expect(run()).rejects.toThrow(
      /workflows\/fixture-linear\.fixtureLinear001\.json is not a valid workflow file: name:/,
    );
  });
});

describe('between git refs', () => {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });

  beforeEach(() => {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'flowdiff test');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'pull');
    git('switch', '--quiet', '-c', 'feature');
  });

  const noClient = () => {
    throw new Error('git mode must not contact the instance');
  };

  it('diffs workflow files between two refs without contacting the instance', async () => {
    await editFile(LINEAR_FILE, (w) => (w.active = true));
    git('commit', '--quiet', '-am', 'activate');

    const result = await run({ target: 'main..feature', getClient: noClient });

    expect(result.differs).toBe(true);
    expect(result.output).toContain('main → feature');
    expect(result.output).toContain('status  inactive → active');
  });

  it('matches a renamed file by workflow id', async () => {
    const renamed = join('workflows', 'renamed-flow.fixtureLinear001.json');
    await editFile(LINEAR_FILE, (w) => (w.name = 'Renamed Flow'));
    await rename(join(cwd, LINEAR_FILE), join(cwd, renamed));
    git('add', '--all');
    git('commit', '--quiet', '-m', 'rename');

    const result = await run({ target: 'main..feature', getClient: noClient });

    expect(result.output).toContain('name    "Fixture: Linear" → "Renamed Flow"');
    expect(result.output).not.toContain('only in');
  });

  it('filters by workflow after the range', async () => {
    await editFile(LINEAR_FILE, (w) => (w.active = true));
    git('commit', '--quiet', '-am', 'activate');

    const result = await run({
      target: 'main..feature',
      workflow: 'fixtureIfBranch1',
      getClient: noClient,
    });

    expect(result.differs).toBe(false);
  });

  it('reports an unknown ref', async () => {
    await expect(run({ target: 'main..nope', getClient: noClient })).rejects.toThrow(
      /Unknown git ref "nope"/,
    );
  });

  describe('--exit-code', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      process.exitCode = undefined;
    });
    afterEach(() => {
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('sets exit code 1 when there are changes', async () => {
      await editFile(LINEAR_FILE, (w) => (w.active = true));
      git('commit', '--quiet', '-am', 'activate');

      await runDiff(cwd, 'main..feature', undefined, { exitCode: true });

      expect(process.exitCode).toBe(1);
    });

    it('leaves the exit code at 0 when nothing changed', async () => {
      await runDiff(cwd, 'main..feature', undefined, { exitCode: true });
      expect(process.exitCode).toBeUndefined();
    });

    it('does not set it without the flag', async () => {
      await editFile(LINEAR_FILE, (w) => (w.active = true));
      git('commit', '--quiet', '-am', 'activate');

      await runDiff(cwd, 'main..feature', undefined, {});

      expect(process.exitCode).toBeUndefined();
    });
  });
});
