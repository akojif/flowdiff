import { describe, expect, it } from 'vitest';
import {
  missingGitignoreEntries,
  validateInstanceUrl,
  validateWorkflowsDir,
} from '../src/commands/init.js';

describe('missingGitignoreEntries', () => {
  it('returns both entries for an empty .gitignore', () => {
    expect(missingGitignoreEntries('')).toEqual(['.env', '.flowdiff/']);
  });

  it('accepts anchored and unanchored forms', () => {
    expect(missingGitignoreEntries('/.env\n.flowdiff\n')).toEqual([]);
    expect(missingGitignoreEntries('.env\r\n/.flowdiff/\r\n')).toEqual([]);
  });

  it('does not treat similar entries as covering .env', () => {
    expect(missingGitignoreEntries('.env.example\n.flowdiff/\n')).toEqual(['.env']);
  });
});

describe('validateWorkflowsDir', () => {
  it.each(['workflows', 'n8n/workflows', './flows'])('accepts %s', (dir) => {
    expect(validateWorkflowsDir(dir)).toBeUndefined();
  });

  it.each(['', '   ', '/abs/path', '../outside', 'a/../../b'])('rejects %j', (dir) => {
    expect(validateWorkflowsDir(dir)).toBeTypeOf('string');
  });
});

describe('validateInstanceUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(validateInstanceUrl('https://n8n.example.com')).toBeUndefined();
    expect(validateInstanceUrl('http://localhost:5678')).toBeUndefined();
  });

  it.each(['', 'n8n.example.com', 'ftp://example.com'])('rejects %j', (url) => {
    expect(validateInstanceUrl(url)).toBeTypeOf('string');
  });
});
