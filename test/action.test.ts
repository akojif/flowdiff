import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMENT_MARKER, runAction } from '../src/action/run.js';
import { command, getInput, outputEntry } from '../src/action/github-env.js';
import { writeConfig } from '../src/config/config-file.js';
import { normalizeWorkflow, type NormalizedWorkflow } from '../src/normalize/normalize.js';
import { serializeWorkflow } from '../src/normalize/serialize.js';
import { workflowFileName } from '../src/workspace/paths.js';
import { chars } from './fake-secrets.js';
import { generateLargeFixture } from './fixtures/large.js';
import { loadAllFixtures } from './helpers.js';

/** A secret short enough that no output truncation could hide it. */
const SHORT_SECRET = chars(20);

/** Parses a GITHUB_OUTPUT file the way the runner does. */
function parseOutputs(content: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, name, delimiter] = heredoc as unknown as [string, string, string];
      const value: string[] = [];
      while (++i < lines.length && lines[i] !== delimiter) value.push(lines[i] ?? '');
      outputs[name] = value.join('\n');
    } else if (line.includes('=')) {
      const [name, ...rest] = line.split('=');
      outputs[name ?? ''] = rest.join('=');
    }
  }
  return outputs;
}

describe('GitHub Actions environment helpers', () => {
  it('reads inputs the way GitHub exposes them', () => {
    expect(getInput({ 'INPUT_FAIL-ON': ' behavior ' }, 'fail-on')).toBe('behavior');
    expect(getInput({}, 'comment')).toBe('');
  });

  it('writes multi-line output values intact', () => {
    const entry = outputEntry('report', 'line one\nline two\n\nline four', () => 'abc');
    expect(parseOutputs(entry)).toEqual({ report: 'line one\nline two\n\nline four' });
  });

  it('cannot be tricked into ending an entry early (delimiter injection)', () => {
    const ids = ['abc', 'abc', 'def'];
    const hostile = 'x\nghadelimiter_abc\ninjected=true\nmore<<EOF';
    const entry = outputEntry('changed', hostile, () => ids.shift() ?? 'zzz');
    expect(entry.startsWith('changed<<ghadelimiter_def\n')).toBe(true);
    expect(parseOutputs(entry)).toEqual({ changed: hostile });
  });

  it('rejects output names that could break the file format', () => {
    expect(() => outputEntry('bad\nname', 'x')).toThrow(/Invalid output name/);
    expect(() => outputEntry('a<<b', 'x')).toThrow(/Invalid output name/);
  });

  it('escapes workflow command messages', () => {
    expect(command('warning', '50% done\n::error::fake')).toBe(
      '::warning::50%25 done%0A::error::fake',
    );
  });
});

// --- runAction against a temporary git repo and a fake GitHub API -------------

interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

function fakeGitHub(options: { readOnly?: boolean } = {}) {
  const comments: FakeComment[] = [];
  const requests: { method: string; path: string }[] = [];
  let nextId = 1;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { body: string }) : undefined;
    if (method === 'GET') return Promise.resolve(json(comments));
    if (options.readOnly)
      return Promise.resolve(json({ message: 'Resource not accessible by integration' }, 403));
    if (method === 'POST') {
      comments.push({
        id: nextId++,
        body: body?.body ?? '',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      });
      return Promise.resolve(json({}, 201));
    }
    const id = Number(url.pathname.split('/').pop());
    const comment = comments.find((c) => c.id === id);
    if (comment) comment.body = body?.body ?? '';
    return Promise.resolve(json({}));
  };
  return { comments, requests, fetch: fetchFn };
}

let repo: string;
let runnerTemp: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

async function writeWorkflows(workflows: NormalizedWorkflow[]) {
  await rm(join(repo, 'workflows'), { recursive: true, force: true });
  await mkdir(join(repo, 'workflows'));
  for (const w of workflows)
    await writeFile(join(repo, 'workflows', workflowFileName(w)), serializeWorkflow(w));
}

function workflows(): NormalizedWorkflow[] {
  return loadAllFixtures().map(normalizeWorkflow);
}

/** main has the fixtures; a feature branch changes them with `edit`; returns base/head SHAs. */
async function setupPr(edit: (ws: NormalizedWorkflow[]) => void) {
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'flowdiff test');
  await writeConfig(repo, { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' });
  await writeWorkflows(workflows());
  git('add', '--all');
  git('commit', '--quiet', '-m', 'base');
  git('switch', '--quiet', '-c', 'feature');
  const changed = workflows();
  edit(changed);
  await writeWorkflows(changed);
  git('add', '--all');
  git('commit', '--quiet', '-m', 'feature');
  return { base: git('rev-parse', 'main'), head: git('rev-parse', 'feature') };
}

async function env(shas: { base: string; head: string }, extra: Record<string, string> = {}) {
  const eventPath = join(runnerTemp, 'event.json');
  await writeFile(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 7,
        base: { sha: shas.base, ref: 'main' },
        head: { sha: shas.head, ref: 'feature' },
      },
    }),
  );
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: repo,
    GITHUB_REPOSITORY: 'octo/demo',
    GITHUB_SERVER_URL: 'https://github.example.com',
    GITHUB_API_URL: 'https://api.github.example.com',
    GITHUB_RUN_ID: '42',
    GITHUB_OUTPUT: join(runnerTemp, 'output'),
    GITHUB_STEP_SUMMARY: join(runnerTemp, 'summary.md'),
    RUNNER_TEMP: runnerTemp,
    INPUT_TOKEN: 'fake-token',
    ...extra,
  };
}

async function run(environment: Record<string, string>, github = fakeGitHub()) {
  const log: string[] = [];
  const exitCode = await runAction({
    env: environment,
    fetch: github.fetch,
    log: (l) => log.push(l),
  });
  const read = (file: string) => readFile(file, 'utf8').catch(() => '');
  return {
    exitCode,
    log: log.join('\n'),
    github,
    summary: await read(environment.GITHUB_STEP_SUMMARY ?? ''),
    outputs: parseOutputs(await read(environment.GITHUB_OUTPUT ?? '')),
  };
}

const node = (w: NormalizedWorkflow, name: string) => {
  const found = w.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`missing node ${name}`);
  return found;
};
const linearOf = (ws: NormalizedWorkflow[]) => {
  const found = ws.find((w) => w.id === 'fixtureLinear001');
  if (!found) throw new Error('missing linear');
  return found;
};
const behaviorChange = (ws: NormalizedWorkflow[]) => {
  node(linearOf(ws), 'Fetch Items').parameters.url = 'https://api.example.com/v2/items';
};
const cosmeticChange = (ws: NormalizedWorkflow[]) => {
  Object.assign(node(linearOf(ws), 'Fetch Items'), { notes: 'just a note' });
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'flowdiff-action-repo-'));
  runnerTemp = await mkdtemp(join(tmpdir(), 'flowdiff-action-runner-'));
});

describe('runAction', () => {
  it('creates one sticky comment, writes the job summary, report and outputs', async () => {
    const shas = await setupPr(behaviorChange);
    const { exitCode, github, summary, outputs } = await run(await env(shas));

    expect(exitCode).toBe(0);
    expect(github.comments).toHaveLength(1);
    expect(
      github.comments[0]?.body.startsWith(
        `${COMMENT_MARKER}\n## flowdiff: Changes from main to feature`,
      ),
    ).toBe(true);
    expect(summary).toContain('## flowdiff: Changes from main to feature');
    expect(outputs).toEqual({
      changed: '1',
      behavior: 'true',
      'report-path': join(runnerTemp, 'flowdiff-report.md'),
    });
    expect(await readFile(outputs['report-path'] ?? '', 'utf8')).toContain('url');
  });

  it('updates the same comment on the next push', async () => {
    const shas = await setupPr(behaviorChange);
    const github = fakeGitHub();
    await run(await env(shas), github);
    await run(await env(shas), github);
    expect(github.comments).toHaveLength(1);
    expect(github.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(github.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it("doesn't take over a person's comment that happens to contain the marker", async () => {
    const shas = await setupPr(behaviorChange);
    const github = fakeGitHub();
    github.comments.push({
      id: 99,
      body: `${COMMENT_MARKER} quoted`,
      user: { login: 'someone', type: 'User' },
    });
    await run(await env(shas), github);
    expect(github.comments.find((c) => c.id === 99)?.body).toBe(`${COMMENT_MARKER} quoted`);
    expect(github.comments).toHaveLength(2);
  });

  it('falls back to the job summary when commenting is forbidden (fork PRs)', async () => {
    const shas = await setupPr(behaviorChange);
    const { exitCode, log, summary } = await run(await env(shas), fakeGitHub({ readOnly: true }));
    expect(exitCode).toBe(0);
    expect(log).toContain('::notice::Could not comment on this pull request');
    expect(summary).toContain('## flowdiff');
  });

  it('makes no GitHub API calls with comment: false', async () => {
    const shas = await setupPr(behaviorChange);
    const { github } = await run(await env(shas, { INPUT_COMMENT: 'false' }));
    expect(github.requests).toEqual([]);
  });

  it.each([
    ['none', behaviorChange, 0],
    ['changes', cosmeticChange, 1],
    ['behavior', cosmeticChange, 0],
    ['behavior', behaviorChange, 1],
  ] as const)('fail-on %s with %o exits %i', async (failOn, edit, expected) => {
    const shas = await setupPr(edit);
    const { exitCode, log } = await run(await env(shas, { 'INPUT_FAIL-ON': failOn }));
    expect(exitCode).toBe(expected);
    if (expected === 1) expect(log).toContain('::error::flowdiff: workflow');
  });

  it('fails on behavior for an added workflow', async () => {
    const shas = await setupPr((ws) => {
      ws.push({ ...structuredClone(linearOf(ws)), id: 'brandNewFlow0001', name: 'Brand New' });
    });
    const { exitCode } = await run(await env(shas, { 'INPUT_FAIL-ON': 'behavior' }));
    expect(exitCode).toBe(1);
  });

  it('diffs from the merge base, so later changes on main are not shown reversed', async () => {
    const shas = await setupPr(behaviorChange);
    git('switch', '--quiet', 'main');
    // A content change that keeps the file name, committed on main after the branch.
    const mainLater = workflows();
    const ifBranch = mainLater.find((w) => w.id === 'fixtureIfBranch1');
    if (ifBranch) ifBranch.settings = { ...ifBranch.settings, timezone: 'Etc/GMT+5' };
    await writeWorkflows(mainLater);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'main moves on');
    const { github } = await run(await env({ base: git('rev-parse', 'main'), head: shas.head }));
    const body = github.comments[0]?.body ?? '';
    expect(body).not.toContain('Fixture: IF Branch');
    expect(body).toContain('1 changed \\(1 with behavior changes\\), 2 unchanged.');
  });

  it('never shows secrets, even if someone sets a show-secrets input', async () => {
    // A short value, so output truncation can't be what hides it.
    const shas = await setupPr((ws) => {
      node(linearOf(ws), 'Fetch Items').parameters.apiKey = SHORT_SECRET;
    });
    const { github, summary, outputs } = await run(
      await env(shas, { 'INPUT_SHOW-SECRETS': 'true', INPUT_SHOW_SECRETS: 'true' }),
    );
    const report = await readFile(outputs['report-path'] ?? '', 'utf8');
    for (const text of [github.comments[0]?.body ?? '', summary, report]) {
      expect(text).not.toContain(SHORT_SECRET);
      expect(text).toContain('possible secret');
    }
    expect(github.comments[0]?.body).not.toContain('--show-secrets');
  });

  // Builds two commits of 50 large workflows (~3s alone); allow for a busy machine.
  it(
    'keeps the comment under GitHub’s size limit and points to the full report',
    { timeout: 30_000 },
    async () => {
      git('init', '--quiet', '--initial-branch=main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'flowdiff test');
      await writeConfig(repo, {
        instanceUrl: 'https://n8n.example.com',
        workflowsDir: 'workflows',
      });
      const fixture = generateLargeFixture();
      // Multi-line text that differs between the branches gives every workflow a big
      // line-level diff, so the details overflow the comment budget.
      const padded = (w: NormalizedWorkflow, side: string) => {
        const copy = structuredClone(w);
        const filler = Array.from(
          { length: 60 },
          (_, i) => `${side} line ${String(i)} of ${w.id}`,
        ).join('\n');
        for (const n of copy.nodes) n.parameters = { ...n.parameters, filler };
        return copy;
      };
      await writeWorkflows([...fixture.instance.values()].map((w) => padded(w, 'before')));
      git('add', '--all');
      git('commit', '--quiet', '-m', 'base');
      git('switch', '--quiet', '-c', 'feature');
      await writeWorkflows([...fixture.local.values()].map((w) => padded(w, 'after')));
      git('add', '--all');
      git('commit', '--quiet', '-m', 'feature');

      const { github, summary } = await run(
        await env({ base: git('rev-parse', 'main'), head: git('rev-parse', 'feature') }),
      );

      const body = github.comments[0]?.body ?? '';
      expect(body.length).toBeLessThanOrEqual(65_536);
      expect(body).toContain('omitted (comment size limit)');
      expect(body).toContain('[Full report](https://github.example.com/octo/demo/actions/runs/42)');
      expect(summary.length).toBeGreaterThan(body.length);
    },
  );
});

describe('runAction refusals', () => {
  it('refuses pull_request_target', async () => {
    const shas = await setupPr(behaviorChange);
    await expect(
      run(await env(shas, { GITHUB_EVENT_NAME: 'pull_request_target' })),
    ).rejects.toThrow(/refuses to run on pull_request_target/);
  });

  it('explains how to fix a shallow checkout', async () => {
    const shas = await setupPr(behaviorChange);
    await expect(run(await env({ ...shas, base: '0'.repeat(40) }))).rejects.toThrow(
      /fetch-depth: 0/,
    );
  });

  it('rejects an unknown fail-on value', async () => {
    const shas = await setupPr(behaviorChange);
    await expect(run(await env(shas, { 'INPUT_FAIL-ON': 'secrets' }))).rejects.toThrow(
      /Invalid fail-on "secrets"/,
    );
  });
});
