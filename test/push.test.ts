import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pull } from '../src/commands/pull.js';
import { pushCommand, type PushFlags } from '../src/commands/push.js';
import { statusCommand } from '../src/commands/status.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import { normalizeWorkflow } from '../src/normalize/normalize.js';
import { buildUpdateBody } from '../src/push/request-body.js';
import { fakeClient, loadAllFixtures, loadFixture } from './helpers.js';

const config: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };
const LINEAR = join('workflows', 'fixture-linear.fixtureLinear001.json');
const IF_BRANCH = join('workflows', 'fixture-if-branch.fixtureIfBranch1.json');
const CRED = join('workflows', 'fixture-credential-reference.fixtureCredRef01.json');
const NOW = () => new Date('2027-02-03T04:05:06.789Z');

let cwd: string;
let client: ReturnType<typeof fakeClient>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flowdiff-push-'));
  client = fakeClient(loadAllFixtures(), {
    credentials: [{ id: 'credFakeId000001', name: 'Example API Key', type: 'httpHeaderAuth' }],
  });
  await writeConfig(cwd, config);
  await pull({ cwd, config, client });
  client.calls.length = 0;
});

interface RunOptions {
  flags?: PushFlags;
  target?: string;
  interactive?: boolean;
  /** Answers for each confirm prompt, in order. Defaults to yes. */
  answers?: boolean[];
  onConfirm?: (message: string) => void;
}

async function run(options: RunOptions = {}) {
  const output: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const result = await pushCommand({
    cwd,
    config,
    client,
    target: options.target,
    flags: options.flags ?? {},
    color: false,
    now: NOW,
    io: {
      interactive: options.interactive ?? true,
      confirm: (message) => {
        prompts.push(message);
        options.onConfirm?.(message);
        return Promise.resolve(answers.shift() ?? true);
      },
      log: (text) => output.push(text),
    },
  });
  return { ...result, output: output.join('\n'), prompts };
}

async function editLocal(
  file: string,
  edit: (w: Record<string, unknown> & { nodes: Record<string, unknown>[] }) => void,
) {
  const workflow = JSON.parse(await readFile(join(cwd, file), 'utf8')) as Record<
    string,
    unknown
  > & {
    nodes: Record<string, unknown>[];
  };
  edit(workflow);
  await writeFile(join(cwd, file), `${JSON.stringify(workflow, null, 2)}\n`);
}

const setUrl = (url: string) => (w: { nodes: Record<string, unknown>[] }) => {
  const node = w.nodes.find((n) => n.name === 'Fetch Items');
  if (node === undefined) throw new Error('missing node');
  node.parameters = { ...(node.parameters as object), url };
};

function instance(id: string) {
  const workflow = client.workflows.find((w) => w.id === id);
  if (workflow === undefined) throw new Error(`no workflow ${id}`);
  return workflow;
}

const updates = () => client.calls.filter((c) => c.method === 'update');

describe('request body', () => {
  it('sends only writable fields, never pinData or staticData', () => {
    const raw = { ...loadFixture('linear.json'), pinData: { x: [] }, staticData: { a: 1 } };
    const { body, dropped } = buildUpdateBody(normalizeWorkflow(raw));
    expect(Object.keys(body).sort()).toEqual(['connections', 'name', 'nodes', 'settings']);
    expect(dropped).toEqual([]);
  });

  it('drops fields n8n would reject and says which', () => {
    const workflow = normalizeWorkflow(loadFixture('linear.json'));
    Object.assign(workflow, { sourceWorkflowId: 'abc', description: 'kept' });
    Object.assign(workflow.nodes[0] ?? {}, { color: '#fff' });
    workflow.settings = { ...workflow.settings, someNewSetting: true };

    const { body, dropped } = buildUpdateBody(workflow);

    expect(body.description).toBe('kept');
    expect(body).not.toHaveProperty('sourceWorkflowId');
    expect(dropped).toEqual([
      'node "Manual Trigger" field "color"',
      'setting "someNewSetting"',
      'field "sourceWorkflowId"',
    ]);
  });

  it('sends nodeGroups with nodeIds as an array', () => {
    const { body } = buildUpdateBody(normalizeWorkflow(loadFixture('node-groups.json')));
    expect(body.nodeGroups).toEqual([
      expect.objectContaining({ name: 'Fetch', nodeIds: ['55555555-5555-4555-8555-000000000002'] }),
      expect.objectContaining({
        name: 'Prepare',
        nodeIds: ['55555555-5555-4555-8555-000000000003'],
      }),
    ]);
  });
});

describe('push happy path', () => {
  beforeEach(async () => {
    await editLocal(LINEAR, setUrl('https://api.example.com/v2/items'));
  });

  it('shows the diff under the push heading, asks, backs up, then updates', async () => {
    const { exitCode, output, prompts } = await run();

    expect(exitCode).toBe(0);
    expect(output).toContain('Changes push would make to the instance');
    expect(output).toContain(
      'url: "https://api.example.com/items" → "https://api.example.com/v2/items"',
    );
    expect(prompts).toEqual(['Push 1 workflow to https://n8n.example.com?']);
    expect(client.calls.map((c) => c.method)).toEqual([
      'list',
      'listCredentials',
      'get',
      'update',
      'get',
    ]);
    expect(client.calls[2]?.query).toEqual({ includePinData: true });
  });

  it('writes the backup before updating, with the full instance version', async () => {
    const before = structuredClone(instance('fixtureLinear001'));
    const { results } = await run();

    const backup = results[0]?.backup ?? '';
    expect(backup).toBe(
      join('.flowdiff', 'backups', 'fixtureLinear001', '2027-02-03T04-05-06-789Z.json'),
    );
    expect(JSON.parse(await readFile(join(cwd, backup), 'utf8'))).toEqual(before);
  });

  it('sends exactly the writable fields', async () => {
    await run();
    expect(Object.keys(updates()[0]?.body as object).sort()).toEqual([
      'connections',
      'name',
      'nodes',
      'settings',
    ]);
  });

  it('leaves pinData and staticData on the instance untouched', async () => {
    Object.assign(instance('fixtureLinear001'), {
      pinData: { 'Manual Trigger': [{ json: { a: 1 } }] },
      staticData: { global: { b: 2 } },
    });
    await run();
    expect(instance('fixtureLinear001')).toMatchObject({
      pinData: { 'Manual Trigger': [{ json: { a: 1 } }] },
      staticData: { global: { b: 2 } },
    });
  });

  it('refreshes the local file and pull record, so status is unchanged afterwards', async () => {
    await run();
    const { statuses } = await statusCommand({ cwd, config, client, flags: {}, color: false });
    expect(statuses.find((s) => s.id === 'fixtureLinear001')?.status).toBe('unchanged');
  });

  it('changes nothing when the confirmation is declined', async () => {
    const { exitCode, output } = await run({ answers: [false] });
    expect(exitCode).toBe(1);
    expect(updates()).toEqual([]);
    expect(existsSync(join(cwd, '.flowdiff', 'backups'))).toBe(false);
    expect(output).toContain('Nothing was pushed.');
  });

  it('--dry-run changes nothing and asks nothing', async () => {
    const { exitCode, output, prompts } = await run({ flags: { dryRun: true } });
    expect(exitCode).toBe(0);
    expect(prompts).toEqual([]);
    expect(updates()).toEqual([]);
    expect(existsSync(join(cwd, '.flowdiff', 'backups'))).toBe(false);
    expect(output).toContain(
      'Dry run: would push 1 workflow to https://n8n.example.com. Nothing was changed.',
    );
  });

  it('refuses without an interactive terminal', async () => {
    const { exitCode, output } = await run({ interactive: false });
    expect(exitCode).toBe(1);
    expect(updates()).toEqual([]);
    expect(output).toContain('push needs an interactive terminal to confirm');
  });

  it('refuses if the instance changes between planning and writing', async () => {
    const { results, exitCode } = await run({
      onConfirm: () => {
        instance('fixtureLinear001').name = 'Edited meanwhile';
      },
    });
    expect(results[0]).toMatchObject({ outcome: 'refused', backup: undefined });
    expect(updates()).toEqual([]);
    expect(exitCode).toBe(1);
  });

  it('reports a failed update with exit code 2 and keeps the backup', async () => {
    client.updateWorkflow = () => Promise.reject(new Error('n8n said no'));
    const { results, exitCode } = await run();
    expect(exitCode).toBe(2);
    expect(results[0]).toMatchObject({ outcome: 'failed', message: 'update failed: n8n said no' });
    expect(existsSync(join(cwd, results[0]?.backup ?? 'missing'))).toBe(true);
  });
});

describe('dev guard', () => {
  it('refuses a workflow without the flowdiff-test tag, even with --force', async () => {
    await editLocal(IF_BRANCH, (w) => (w.active = false));
    for (const flags of [{}, { force: true }]) {
      const { output, exitCode } = await run({ flags });
      expect(output).toContain(
        'refused  Fixture: IF Branch (fixtureIfBranch1): dev guard: needs the "flowdiff-test" tag (missing locally and on the instance)',
      );
      expect(exitCode).toBe(1);
    }
    expect(updates()).toEqual([]);
  });

  it('refuses when only the local file has the tag', async () => {
    await editLocal(IF_BRANCH, (w) => (w.tags = ['flowdiff-test']));
    const { output } = await run();
    expect(output).toContain('missing on the instance');
    expect(updates()).toEqual([]);
  });

  it('refuses when the tag was removed on the instance after planning', async () => {
    await editLocal(LINEAR, setUrl('https://api.example.com/v2/items'));
    const { results } = await run({
      onConfirm: () => {
        instance('fixtureLinear001').tags = [];
      },
      flags: { force: true },
    });
    expect(results[0]?.message).toContain('dev guard');
    expect(updates()).toEqual([]);
  });
});

describe('conflicts and statuses', () => {
  it('refuses a conflict without --force and pushes it with --force', async () => {
    await editLocal(LINEAR, setUrl('https://api.example.com/v2/items'));
    instance('fixtureLinear001').name = 'Renamed on instance';

    const refused = await run();
    expect(refused.output).toContain(
      'changed on the instance since the last pull; run flowdiff pull, or use --force',
    );
    expect(updates()).toEqual([]);

    const forced = await run({ flags: { force: true } });
    expect(forced.exitCode).toBe(0);
    expect(updates()).toHaveLength(1);
  });

  it('never recreates a workflow deleted on the instance', async () => {
    client.workflows = client.workflows.filter((w) => w.id !== 'fixtureLinear001');
    const { output } = await run({ target: 'fixtureLinear001' });
    expect(output).toContain("deleted on the instance; push won't recreate it");
    expect(updates()).toEqual([]);
  });

  it('skips a workflow that only changed on the instance', async () => {
    instance('fixtureLinear001').name = 'Renamed on instance';
    const { output } = await run({ target: 'fixtureLinear001' });
    expect(output).toContain('only changed on the instance; run flowdiff pull');
  });
});

describe('broken references', () => {
  beforeEach(async () => {
    await editLocal(LINEAR, (w) => {
      const fetch = w.nodes.find((n) => n.name === 'Fetch Items');
      if (fetch === undefined) throw new Error('missing node');
      fetch.parameters = {
        ...(fetch.parameters as object),
        url: "={{ $('Old Name').item.json.url }}",
      };
    });
  });

  it('asks separately and skips the workflow when declined', async () => {
    const { prompts, exitCode, output } = await run({ answers: [false] });
    expect(prompts[0]).toBe('"Fixture: Linear" has 1 broken reference(s). Push it anyway?');
    expect(output).toContain('references "Old Name", which is not a node in this workflow');
    expect(updates()).toEqual([]);
    expect(exitCode).toBe(1);
  });

  it('pushes when both prompts are accepted', async () => {
    const { prompts } = await run({ answers: [true, true] });
    expect(prompts).toHaveLength(2);
    expect(updates()).toHaveLength(1);
  });
});

describe('active, tags and credentials', () => {
  it('does not change active without --apply-active', async () => {
    await editLocal(LINEAR, (w) => (w.active = true));
    const { output } = await run();
    expect(output).toContain(
      "nothing push can change (active on/off isn't changed without --apply-active)",
    );
    expect(client.calls.some((c) => c.method === 'activate' || c.method === 'update')).toBe(false);
  });

  it('activates after the update with --apply-active', async () => {
    await editLocal(LINEAR, (w) => (w.active = true));
    const { output } = await run({ flags: { applyActive: true } });
    expect(output).toContain('will activate the workflow');
    expect(client.calls.map((c) => c.method)).toEqual([
      'list',
      'listCredentials',
      'get',
      'update',
      'activate',
      'get',
    ]);
    expect(instance('fixtureLinear001').active).toBe(true);
  });

  it("says tag changes aren't pushed", async () => {
    await editLocal(LINEAR, (w) => {
      w.tags = ['flowdiff-test', 'reviewed'];
      setUrl('https://api.example.com/v2/items')(w);
    });
    const { output } = await run();
    expect(output).toContain("! tag changes aren't pushed");
  });

  it('warns about a credential name that does not exist on the instance', async () => {
    await editLocal(CRED, (w) => {
      const node = w.nodes.find((n) => n.name === 'Forward to API');
      if (node === undefined) throw new Error('missing node');
      node.credentials = { httpHeaderAuth: { id: 'otherInstanceId', name: 'Missing Key' } };
    });
    const { output } = await run({ flags: { dryRun: true } });
    expect(output).toContain(
      'node "Forward to API" uses credential "Missing Key" (httpHeaderAuth), which doesn\'t exist on the instance',
    );
  });

  it('accepts a credential that matches by name with a different id', async () => {
    await editLocal(CRED, (w) => {
      const node = w.nodes.find((n) => n.name === 'Forward to API');
      if (node === undefined) throw new Error('missing node');
      node.credentials = { httpHeaderAuth: { id: 'otherInstanceId', name: 'Example API Key' } };
      node.notes = 'changed';
    });
    const { output } = await run({ flags: { dryRun: true } });
    expect(output).not.toContain("doesn't exist on the instance");
  });

  it('says the credential check was skipped without credential:list', async () => {
    client.credentials = 'forbidden';
    await editLocal(LINEAR, setUrl('https://api.example.com/v2/items'));
    const { output } = await run({ flags: { dryRun: true } });
    expect(output).toContain(
      'Credential check skipped: the API key lacks the "credential:list" scope.',
    );
  });
});

describe('backups folder', () => {
  it('keeps one file per push', async () => {
    await editLocal(LINEAR, setUrl('https://api.example.com/v2/a'));
    await run();
    await editLocal(LINEAR, setUrl('https://api.example.com/v2/b'));
    let tick = 0;
    await pushCommand({
      cwd,
      config,
      client,
      flags: {},
      color: false,
      now: () => new Date(Date.UTC(2027, 1, 3, 4, 5, 7 + tick++)),
      io: { interactive: true, confirm: () => Promise.resolve(true), log: () => undefined },
    });
    expect(await readdir(join(cwd, '.flowdiff', 'backups', 'fixtureLinear001'))).toHaveLength(2);
  });
});
