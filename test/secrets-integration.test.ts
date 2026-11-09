import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { diffCommand, type DiffFlags } from '../src/commands/diff.js';
import { formatPullResult, pull } from '../src/commands/pull.js';
import { pushCommand, type PushFlags } from '../src/commands/push.js';
import { statusCommand } from '../src/commands/status.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import { chars, FAKE } from './fake-secrets.js';
import { fakeClient, loadAllFixtures, loadFixture } from './helpers.js';

const config: Config = {
  instanceUrl: 'https://n8n.example.com',
  workflowsDir: 'workflows',
  requireTag: 'flowdiff-test',
};
const LINEAR = join('workflows', 'fixture-linear.fixtureLinear001.json');
const CODE = join('workflows', 'fixture-code-and-ai.fixtureCodeNode1.json');
const MARKER = /‹redacted [A-Za-z -]+ #[0-9a-f]{4}›/;

let cwd: string;
let client: ReturnType<typeof fakeClient>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flowdiff-secrets-'));
  // Includes the Code-node fixture (untagged: fine for diff, which doesn't use the push guard).
  client = fakeClient([...loadAllFixtures(), loadFixture('code-node.json')]);
  await writeConfig(cwd, config);
  await pull({ cwd, config, client });
  client.calls.length = 0;
});

type Workflow = Record<string, unknown> & { nodes: Record<string, unknown>[] };

async function editLocal(file: string, edit: (w: Workflow) => void) {
  const workflow = JSON.parse(await readFile(join(cwd, file), 'utf8')) as Workflow;
  edit(workflow);
  await writeFile(join(cwd, file), `${JSON.stringify(workflow, null, 2)}\n`);
}

function node(w: { nodes: Record<string, unknown>[] }, name: string): Record<string, unknown> {
  const found = w.nodes.find((n) => n.name === name);
  if (found === undefined) throw new Error(`missing node ${name}`);
  return found;
}

const withAuthHeader = (token: string) => (w: Workflow) => {
  const fetch = node(w, 'Fetch Items');
  fetch.parameters = {
    ...(fetch.parameters as object),
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${token}` }] },
  };
};

// `full` so long values aren't truncated: the tests must see whole values to prove redaction.
const diff = (flags: DiffFlags = {}, target?: string) =>
  diffCommand({
    cwd,
    config,
    target,
    flags: { full: true, ...flags },
    getClient: () => client,
    color: false,
  });

async function push(flags: PushFlags = {}, answers: boolean[] = []) {
  const output: string[] = [];
  const prompts: string[] = [];
  const queue = [...answers];
  const result = await pushCommand({
    cwd,
    config,
    client,
    flags,
    color: false,
    io: {
      interactive: true,
      confirm: (message) => {
        prompts.push(message);
        return Promise.resolve(queue.shift() ?? true);
      },
      log: (text) => output.push(text),
    },
  });
  return { ...result, output: output.join('\n'), prompts };
}

describe('diff', () => {
  it('warns about and redacts an added bearer token', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    const { output } = await diff();

    expect(output).not.toContain(FAKE.bearer);
    expect(output).toMatch(MARKER);
    expect(output).toContain(
      '⚠ "Fetch Items" › headerParameters.parameters[0].value looks like a hard-coded secret (bearer token)',
    );
    expect(output).toContain('1 possible secret');
    expect(output).toContain('--show-secrets shows them');
  });

  it('redacts JSON output too, and lists the finding without its value', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    const { output } = await diff({ json: true });
    expect(output).not.toContain(FAKE.bearer);
    const parsed = JSON.parse(output) as {
      workflows: { id: string; secrets: { label: string }[] }[];
    };
    expect(parsed.workflows.find((w) => w.id === 'fixtureLinear001')?.secrets).toMatchObject([
      { label: 'bearer token' },
    ]);
  });

  it('shows the value with --show-secrets', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    expect((await diff({ showSecrets: true })).output).toContain(FAKE.bearer);
  });

  it('redacts secrets inside a line-level Code node diff', async () => {
    await editLocal(CODE, (w) => {
      const code = node(w, 'Transform Items');
      code.parameters = { jsCode: `const apiKey = "${FAKE.openai}";\nreturn items;\n` };
    });
    const { output } = await diff();
    expect(output).not.toContain(FAKE.openai);
    expect(output).toMatch(new RegExp(`\\+const apiKey = "${MARKER.source}";`));
  });

  it('redacts a secret that is being removed', async () => {
    const instanceLinear = client.workflows.find((w) => w.id === 'fixtureLinear001');
    if (instanceLinear === undefined) throw new Error('missing fixture');
    withAuthHeader(FAKE.bearer)(instanceLinear);
    const { output } = await diff();
    expect(output).not.toContain(FAKE.bearer);
    expect(output).toMatch(MARKER);
  });

  it('shows a changed secret as a change without revealing either value', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    await pull({ cwd, config, client, force: true });
    const instanceLinear = client.workflows.find((w) => w.id === 'fixtureLinear001');
    if (instanceLinear === undefined) throw new Error('missing fixture');
    withAuthHeader(FAKE.bearer)(instanceLinear);
    await editLocal(LINEAR, withAuthHeader(chars(32, 'Zy9Xw8')));

    const { output } = await diff();

    expect(output).toMatch(new RegExp(`${MARKER.source}" → "Bearer ${MARKER.source}`));
    expect(output).not.toContain(FAKE.bearer);
  });

  it('redacts in git-range mode', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'flowdiff test');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'base');
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    git('commit', '--quiet', '-am', 'add header');

    const { output } = await diff({}, 'HEAD~1..HEAD');

    expect(output).not.toContain(FAKE.bearer);
    expect(output).toContain('looks like a hard-coded secret');
  });
});

describe('status and pull', () => {
  it('status lists local files with possible secrets', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    const { output } = await statusCommand({ cwd, config, client, flags: {}, color: false });
    expect(output).toContain(
      'Possible hard-coded secrets in local files (check before committing):',
    );
    expect(output).toContain('⚠ Fixture: Linear (fixtureLinear001): 1');
    expect(output).not.toContain(FAKE.bearer);
  });

  it('pull warns to check pulled files before committing', async () => {
    const instanceLinear = client.workflows.find((w) => w.id === 'fixtureLinear001');
    if (instanceLinear === undefined) throw new Error('missing fixture');
    withAuthHeader(FAKE.bearer)(instanceLinear);

    const result = await pull({ cwd, config, client });
    const text = formatPullResult(result, 'workflows');

    expect(text).toContain(
      'Possible hard-coded secrets in 1 pulled file(s); check before committing:',
    );
    expect(text).toContain('workflows/fixture-linear.fixtureLinear001.json: bearer token');
    expect(text).not.toContain(FAKE.bearer);
  });
});

describe('push', () => {
  it('asks before pushing an added secret and skips it when declined', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    const { prompts, output, exitCode } = await push({}, [false]);
    expect(prompts[0]).toBe(
      '"Fixture: Linear" adds or changes a possible hard-coded secret. Push it anyway?',
    );
    expect(client.calls.some((c) => c.method === 'update')).toBe(false);
    expect(output).not.toContain(FAKE.bearer);
    expect(exitCode).toBe(1);
  });

  it('sends the real value when confirmed: redaction never touches the request', async () => {
    await editLocal(LINEAR, withAuthHeader(FAKE.bearer));
    await push({}, [true, true]);
    const update = client.calls.find((c) => c.method === 'update');
    expect(JSON.stringify(update?.body)).toContain(`Bearer ${FAKE.bearer}`);
    expect(JSON.stringify(update?.body)).not.toContain('‹redacted');
  });

  it('only warns about an existing, unchanged secret', async () => {
    const instanceLinear = client.workflows.find((w) => w.id === 'fixtureLinear001');
    if (instanceLinear === undefined) throw new Error('missing fixture');
    withAuthHeader(FAKE.bearer)(instanceLinear);
    await pull({ cwd, config, client });
    await editLocal(LINEAR, (w) => Object.assign(node(w, 'Set Defaults'), { notes: 'edited' }));

    const { prompts, output } = await push();

    expect(prompts).toEqual(['Push 1 workflow to https://n8n.example.com?']);
    expect(output).toContain(
      '1 possible secret(s) already in this workflow (unchanged by this push)',
    );
    expect(output).not.toContain(FAKE.bearer);
  });

  it('asks when a new node brings a secret', async () => {
    await editLocal(LINEAR, (w) => {
      w.nodes.push({
        id: 'new-node',
        name: 'Call API',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [660, 0],
        parameters: { url: 'https://api.example.com', apiKey: chars(24) },
      });
    });
    const { prompts } = await push({ dryRun: false }, [false]);
    expect(prompts[0]).toContain('adds or changes a possible hard-coded secret');
  });

  it('shows the value only with --show-secrets', async () => {
    // A short value, so push's (truncating) diff output shows it whole.
    await editLocal(LINEAR, (w) => {
      const fetch = node(w, 'Fetch Items');
      fetch.parameters = { ...(fetch.parameters as object), apiKey: chars(20) };
    });
    expect((await push({ dryRun: true })).output).not.toContain(chars(20));
    expect((await push({ dryRun: true, showSecrets: true })).output).toContain(chars(20));
  });
});
