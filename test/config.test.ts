import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig, type Config } from '../src/config/config-file.js';
import { resolveConnection } from '../src/config/connection.js';
import { readEnv } from '../src/config/env.js';

const config: Config = { instanceUrl: 'https://config.example.com', workflowsDir: 'workflows' };

describe('readEnv', () => {
  it('treats empty and whitespace-only values as unset', () => {
    expect(readEnv({ FLOWDIFF_API_KEY: '  ', FLOWDIFF_URL: '' })).toEqual({
      apiKey: undefined,
      url: undefined,
    });
  });

  it('trims values', () => {
    expect(
      readEnv({ FLOWDIFF_API_KEY: ' fake-key ', FLOWDIFF_URL: 'https://env.example.com ' }),
    ).toEqual({ apiKey: 'fake-key', url: 'https://env.example.com' });
  });
});

describe('resolveConnection', () => {
  it('uses the config URL when FLOWDIFF_URL is not set', () => {
    expect(resolveConnection(config, { apiKey: 'fake-key', url: undefined })).toEqual({
      instanceUrl: 'https://config.example.com',
      urlSource: 'flowdiff.config.json',
      apiKey: 'fake-key',
    });
  });

  it('lets FLOWDIFF_URL override the config URL', () => {
    const connection = resolveConnection(config, {
      apiKey: 'fake-key',
      url: 'https://env.example.com',
    });
    expect(connection.instanceUrl).toBe('https://env.example.com');
    expect(connection.urlSource).toBe('FLOWDIFF_URL');
  });

  it('explains how to set a missing API key', () => {
    expect(() => resolveConnection(config, { apiKey: undefined, url: undefined })).toThrow(
      /FLOWDIFF_API_KEY is not set.*\.env/,
    );
  });

  it('names the source of an invalid URL', () => {
    expect(() => resolveConnection(config, { apiKey: 'fake-key', url: 'not a url' })).toThrow(
      /"not a url" \(from FLOWDIFF_URL\) is not a valid URL/,
    );
  });
});

describe('config file', () => {
  async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'flowdiff-config-'));
  }

  it('round-trips through writeConfig and readConfig', async () => {
    const dir = await tempDir();
    await writeConfig(dir, config);
    await expect(readConfig(dir)).resolves.toEqual(config);
  });

  it('defaults workflowsDir', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'flowdiff.config.json'), '{"instanceUrl":"https://n8n.example.com"}');
    await expect(readConfig(dir)).resolves.toEqual({
      instanceUrl: 'https://n8n.example.com',
      workflowsDir: 'workflows',
    });
  });

  it('reads an optional tag and rejects an empty one', async () => {
    const dir = await tempDir();
    await writeConfig(dir, { ...config, tag: 'flowdiff-test' });
    await expect(readConfig(dir)).resolves.toMatchObject({ tag: 'flowdiff-test' });

    await writeFile(
      join(dir, 'flowdiff.config.json'),
      '{"instanceUrl":"https://n8n.example.com","tag":"  "}',
    );
    await expect(readConfig(dir)).rejects.toThrow(/tag/);
  });

  it('tells the user to run init when the file is missing', async () => {
    await expect(readConfig(await tempDir())).rejects.toThrow(/Run `flowdiff init` first/);
  });

  it('rejects an API key stored in config', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'flowdiff.config.json'),
      '{"instanceUrl":"https://n8n.example.com","apiKey":"fake-key"}',
    );
    await expect(readConfig(dir)).rejects.toThrow(/flowdiff.config.json is invalid/);
  });

  it('reports invalid JSON', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'flowdiff.config.json'), '{ nope');
    await expect(readConfig(dir)).rejects.toThrow(/not valid JSON/);
  });
});
