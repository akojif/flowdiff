import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pull } from '../src/commands/pull.js';
import { pushCommand, type PushFlags } from '../src/commands/push.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import { resolvePushGuard } from '../src/config/push-guard.js';
import { resolveTagScope } from '../src/config/tag-scope.js';
import { fakeClient, loadAllFixtures } from './helpers.js';

const base: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };

describe('resolvePushGuard', () => {
  const guard = (config: Config, flagTag?: string | false) =>
    resolvePushGuard(config, resolveTagScope(config, flagTag));

  it('uses requireTag when set', () => {
    expect(guard({ ...base, requireTag: 'safe', tag: 'scope' })).toEqual({
      kind: 'tag',
      tag: 'safe',
      source: 'requireTag in flowdiff.config.json',
    });
  });

  it('falls back to the tag scope', () => {
    expect(guard({ ...base, tag: 'scope' })).toEqual({
      kind: 'tag',
      tag: 'scope',
      source: 'tag in flowdiff.config.json',
    });
  });

  it('is unset when nothing is configured', () => {
    expect(guard(base)).toEqual({ kind: 'unset' });
  });

  it('is off only with an explicit requireTag: false', () => {
    expect(guard({ ...base, requireTag: false })).toEqual({ kind: 'off' });
  });

  it('is not loosened by --tag or --no-tag when requireTag is set', () => {
    expect(guard({ ...base, requireTag: 'safe' }, 'other')).toMatchObject({ tag: 'safe' });
    expect(guard({ ...base, requireTag: 'safe' }, false)).toMatchObject({ tag: 'safe' });
  });

  it('follows --tag when there is no requireTag (still a tag check)', () => {
    expect(guard({ ...base, tag: 'scope' }, 'narrower')).toEqual({
      kind: 'tag',
      tag: 'narrower',
      source: '--tag',
    });
  });

  it('becomes unset with --no-tag when only tag is configured', () => {
    expect(guard({ ...base, tag: 'scope' }, false)).toEqual({ kind: 'unset' });
  });
});

describe('push with each guard setting', () => {
  let cwd: string;
  let client: ReturnType<typeof fakeClient>;
  const IF_BRANCH = join('workflows', 'fixture-if-branch.fixtureIfBranch1.json');
  const LINEAR = join('workflows', 'fixture-linear.fixtureLinear001.json');

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'flowdiff-guard-'));
    client = fakeClient(loadAllFixtures());
    await writeConfig(cwd, base);
    await pull({ cwd, config: base, client });
    client.calls.length = 0;
  });

  async function editLocal(file: string, edit: (w: Record<string, unknown>) => void) {
    const workflow = JSON.parse(await readFile(join(cwd, file), 'utf8')) as Record<string, unknown>;
    edit(workflow);
    await writeFile(join(cwd, file), `${JSON.stringify(workflow, null, 2)}\n`);
  }

  async function run(config: Config, flags: PushFlags = {}) {
    const output: string[] = [];
    const result = await pushCommand({
      cwd,
      config,
      client,
      flags,
      color: false,
      io: { interactive: true, confirm: () => Promise.resolve(true), log: (t) => output.push(t) },
    });
    return { ...result, output: output.join('\n') };
  }

  const updates = () => client.calls.filter((c) => c.method === 'update');
  const notes = (w: Record<string, unknown>) => {
    const nodes = w.nodes as Record<string, unknown>[];
    Object.assign(nodes[0] ?? {}, { notes: 'edited' });
  };

  it('refuses everything without a guard and says exactly what to add', async () => {
    await editLocal(LINEAR, notes);
    const { exitCode, output } = await run(base);
    expect(exitCode).toBe(1);
    expect(output).toContain('Add one of these to flowdiff.config.json:');
    expect(output).toContain('"requireTag": "flowdiff"');
    expect(output).toContain('"requireTag": false');
    expect(client.calls).toEqual([]);
  });

  it('refuses everything with --no-tag when only tag is configured', async () => {
    await editLocal(LINEAR, notes);
    const { exitCode, output } = await run({ ...base, tag: 'flowdiff-test' }, { tag: false });
    expect(exitCode).toBe(1);
    expect(output).toContain('push needs to know which workflows it may change');
    expect(updates()).toEqual([]);
  });

  it('uses the configured tag as the guard', async () => {
    await editLocal(LINEAR, notes);
    const { results, output } = await run({ ...base, tag: 'flowdiff-test' });
    expect(output).toContain('push guard: tag "flowdiff-test" (tag in flowdiff.config.json)');
    expect(results).toMatchObject([{ id: 'fixtureLinear001', outcome: 'pushed' }]);
  });

  it('refuses a tracked workflow whose tag was removed on the instance', async () => {
    await editLocal(LINEAR, notes);
    const linear = client.workflows.find((w) => w.id === 'fixtureLinear001');
    if (linear === undefined) throw new Error('missing fixture');
    linear.tags = [];

    const { output } = await run({ ...base, requireTag: 'flowdiff-test' }, { force: true });

    expect(output).toContain('missing on the instance');
    expect(updates()).toEqual([]);
  });

  it('allows untagged workflows only with requireTag: false, reading the full list', async () => {
    await editLocal(IF_BRANCH, notes);

    const refused = await run({ ...base, requireTag: 'flowdiff-test' });
    expect(refused.output).toContain('push guard: needs the tag "flowdiff-test"');
    expect(updates()).toEqual([]);

    client.calls.length = 0;
    const allowed = await run({ ...base, requireTag: false });
    expect(allowed.output).toContain('push guard: off (requireTag: false in flowdiff.config.json)');
    expect(allowed.results).toMatchObject([{ id: 'fixtureIfBranch1', outcome: 'pushed' }]);
    const preWriteList = client.calls.filter((c) => c.method === 'list')[1];
    expect(preWriteList?.query).toEqual({});
  });
});
