import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getInput } from '../src/action/github-env.js';

const root = new URL('../', import.meta.url);
const actionYml = readFileSync(new URL('action.yml', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  name: string;
  version: string;
};

/** Top-level keys under `inputs:` (two-space indented, ending with a colon). */
function declaredInputs(): string[] {
  const section = /^inputs:\n((?: {2}.*\n|\n)+)/m.exec(actionYml)?.[1] ?? '';
  return [...section.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1] ?? '');
}

describe('action.yml', () => {
  it('runs the exact package version from package.json', () => {
    expect(actionYml).toContain(`npx --yes ${pkg.name}@${pkg.version} github-action`);
    // The same check the release workflow runs.
    expect(() =>
      execFileSync('node', ['scripts/sync-action-version.mjs', '--check'], {
        cwd: root,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('declares the designed inputs, and none for showing secrets', () => {
    expect(declaredInputs().sort()).toEqual(['comment', 'fail-on', 'token', 'working-directory']);
    expect(actionYml).not.toMatch(/show[-_]secrets/i);
  });

  it('passes every input to the command under the name the code reads', () => {
    for (const input of declaredInputs()) {
      // The hyphenated form JavaScript actions get, which every released version reads.
      const envName = `INPUT_${input.toUpperCase()}`;
      expect(actionYml).toContain(`${envName}: \${{ inputs.${input} }}`);
      expect(getInput({ [envName]: 'value' }, input)).toBe('value');
    }
  });

  it('pins Node with setup-node v5 and skips dependency install scripts', () => {
    expect(actionYml).toContain('uses: actions/setup-node@v5');
    expect(actionYml).toContain("node-version: '24'");
    expect(actionYml).toContain("npm_config_ignore_scripts: 'true'");
  });
});
