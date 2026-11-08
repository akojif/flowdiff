import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client.js';
import { pull } from '../src/commands/pull.js';
import { writeConfig, type Config } from '../src/config/config-file.js';
import { loadAllFixtures } from './helpers.js';

function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeysDeep(child)]),
    );
  }
  return value;
}

// Phase 1 done criterion: running pull twice in a row produces zero git changes.
// Uses the real API client and a fake fetch, in a fresh git repo, because this
// project's own .gitignore ignores workflows/.
describe('pull twice in a git repo', () => {
  it('leaves the working tree clean after the second pull', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'flowdiff-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'flowdiff test');

    const config: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };
    await writeConfig(cwd, config);

    // Every other fetch reverses key order at every depth, like a server that does not
    // guarantee key order. zod rebuilds known fields in schema order, so the shuffle has
    // to reach parameters (passed through as-is) for this test to mean anything.
    const fixtures = loadAllFixtures();
    let call = 0;
    const fetchFn: typeof fetch = () => {
      call += 1;
      const data = call % 2 === 0 ? fixtures.map(reverseKeysDeep) : fixtures;
      return Promise.resolve(
        new Response(JSON.stringify({ data, nextCursor: null }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const client = createClient({
      connection: {
        instanceUrl: config.instanceUrl,
        urlSource: 'flowdiff.config.json',
        apiKey: 'fake',
      },
      fetch: fetchFn,
    });

    await pull({ cwd, config, client });
    git('add', '--all');
    git('commit', '--quiet', '-m', 'first pull');

    await pull({ cwd, config, client });

    expect(git('status', '--porcelain')).toBe('');
    expect(call).toBe(2);
  });
});
