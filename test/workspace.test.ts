import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  indexWorkflowFiles,
  slugify,
  workflowFileName,
  workflowIdFromFileName,
} from '../src/workspace/paths.js';
import { emptyState, hashContent, readState, writeState } from '../src/workspace/state.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'flowdiff-workspace-'));
}

describe('slugify', () => {
  it.each([
    ['Fixture: Linear', 'fixture-linear'],
    ['  Leading and trailing  ', 'leading-and-trailing'],
    ['Crème brûlée Sync', 'creme-brulee-sync'],
    ['v2.1 / nightly_job', 'v2-1-nightly-job'],
    ['日本語', 'workflow'],
    ['', 'workflow'],
    ['---', 'workflow'],
  ])('%j -> %j', (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  it('caps the length without leaving a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(59)} b`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toMatch(/-$/);
  });
});

describe('workflow file names', () => {
  it('combines slug and id', () => {
    expect(workflowFileName({ id: 'abc123', name: 'My Flow' })).toBe('my-flow.abc123.json');
  });

  it('reads the id back from a file name', () => {
    expect(workflowIdFromFileName('my-flow.abc123.json')).toBe('abc123');
    expect(workflowIdFromFileName('notes.txt')).toBeUndefined();
    expect(workflowIdFromFileName('missing-id.json')).toBeUndefined();
  });

  it('indexes files by id and ignores other files', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'old-name.abc123.json'), '{}');
    await writeFile(join(dir, 'new-name.abc123.json'), '{}');
    await writeFile(join(dir, 'other.def456.json'), '{}');
    await writeFile(join(dir, 'README.md'), '');

    const index = await indexWorkflowFiles(dir);

    expect(Object.fromEntries(index)).toEqual({
      abc123: ['new-name.abc123.json', 'old-name.abc123.json'],
      def456: ['other.def456.json'],
    });
  });

  it('returns an empty index for a missing directory', async () => {
    expect((await indexWorkflowFiles(join(await tempDir(), 'nope'))).size).toBe(0);
  });
});

describe('state', () => {
  it('starts empty when there is no state file', async () => {
    await expect(readState(await tempDir())).resolves.toEqual(emptyState());
  });

  it('round-trips through writeState and readState', async () => {
    const dir = await tempDir();
    const state = {
      version: 1 as const,
      workflows: { abc: { hash: hashContent('x'), versionId: 'v1', updatedAt: '2026-01-01' } },
    };
    await writeState(dir, state);
    await expect(readState(dir)).resolves.toEqual(state);
  });

  it('explains how to recover from a corrupt state file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.flowdiff'));
    await writeFile(join(dir, '.flowdiff', 'state.json'), 'not json');
    await expect(readState(dir)).rejects.toThrow(/corrupt\. Delete it/);
  });
});
