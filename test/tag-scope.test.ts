import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config/config-file.js';
import { describeTagScope, resolveTagScope } from '../src/config/tag-scope.js';

const base: Config = { instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' };
const withTag: Config = { ...base, tag: 'saved-tag' };

describe('resolveTagScope', () => {
  it('lets --tag override the config', () => {
    expect(resolveTagScope(withTag, 'cli-tag')).toEqual({ tag: 'cli-tag', source: '--tag' });
  });

  it('lets --no-tag turn a saved tag off', () => {
    expect(resolveTagScope(withTag, false)).toEqual({ tag: undefined, source: '--no-tag' });
  });

  it('uses the config tag when no flag is given', () => {
    expect(resolveTagScope(withTag, undefined)).toEqual({
      tag: 'saved-tag',
      source: 'flowdiff.config.json',
    });
  });

  it('applies no filter when neither is set', () => {
    expect(resolveTagScope(base, undefined)).toEqual({ tag: undefined, source: 'default' });
  });
});

describe('describeTagScope', () => {
  it('names the tag and its source', () => {
    expect(describeTagScope({ tag: 'x', source: '--tag' })).toBe(' with tag "x" (from --tag)');
    expect(describeTagScope({ tag: undefined, source: 'default' })).toBe('');
  });
});
