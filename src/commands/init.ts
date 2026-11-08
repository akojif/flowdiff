import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { CONFIG_FILE_NAME, configExists, writeConfig } from '../config/config-file.js';

/** Entries init offers to add to the user's .gitignore. workflows/ is deliberately absent. */
export const REQUIRED_GITIGNORE_ENTRIES = ['.env', '.flowdiff/'] as const;

/** Returns the required entries that `gitignore` does not already cover. */
export function missingGitignoreEntries(gitignore: string): string[] {
  const lines = new Set(
    gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => line.replace(/^\//, '').replace(/\/$/, '')),
  );
  return REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry.replace(/\/$/, '')));
}

/** Returns an error message, or undefined if `dir` is an acceptable workflows folder. */
export function validateWorkflowsDir(dir: string | undefined): string | undefined {
  const value = dir?.trim() ?? '';
  if (value === '') return 'Enter a folder name.';
  if (isAbsolute(value)) return 'Use a path relative to the project folder.';
  if (normalize(value).split(sep).includes('..')) return 'The folder must be inside the project.';
  return undefined;
}

export function validateInstanceUrl(url: string | undefined): string | undefined {
  try {
    const { protocol } = new URL(url?.trim() ?? '');
    return protocol === 'https:' || protocol === 'http:' ? undefined : 'Use an http(s) URL.';
  } catch {
    return 'Enter a full URL, e.g. https://n8n.example.com';
  }
}

/** Prompts return a cancel symbol on Ctrl+C; stop cleanly in that case. */
function exitIfCancelled<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

/** CLI entry point for `flowdiff init`. Interactive. */
export async function runInit(cwd: string): Promise<void> {
  p.intro('flowdiff init');

  if (configExists(cwd)) {
    const overwrite = exitIfCancelled(
      await p.confirm({
        message: `${CONFIG_FILE_NAME} already exists. Overwrite it?`,
        initialValue: false,
      }),
    );
    if (!overwrite) {
      p.outro('Kept the existing config.');
      return;
    }
  }

  const instanceUrl = exitIfCancelled(
    await p.text({
      message: 'n8n instance URL',
      placeholder: 'https://n8n.example.com',
      validate: validateInstanceUrl,
    }),
  ).trim();

  const workflowsDir = exitIfCancelled(
    await p.text({
      message: 'Folder for workflow files',
      defaultValue: 'workflows',
      placeholder: 'workflows',
      validate: (value) => (value === '' ? undefined : validateWorkflowsDir(value)),
    }),
  ).trim();

  const tag = exitIfCancelled(
    await p.text({
      message: 'Only track workflows with this tag? (leave empty for all)',
      placeholder: 'e.g. flowdiff',
      defaultValue: '',
    }),
  ).trim();

  await writeConfig(cwd, { instanceUrl, workflowsDir, ...(tag === '' ? {} : { tag }) });
  p.log.success(`Wrote ${CONFIG_FILE_NAME}`);

  const gitignorePath = join(cwd, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
  const missing = missingGitignoreEntries(gitignore);
  if (missing.length > 0) {
    const add = exitIfCancelled(
      await p.confirm({ message: `Add ${missing.join(' and ')} to .gitignore?` }),
    );
    if (add) {
      const prefix = gitignore === '' || gitignore.endsWith('\n') ? '' : '\n';
      await appendFile(gitignorePath, `${prefix}${missing.join('\n')}\n`, 'utf8');
      p.log.success('Updated .gitignore');
    } else {
      p.log.warn('Make sure .env is never committed: it will hold your API key.');
    }
  }

  p.note(
    [
      'Put your API key in .env (never in the config file):',
      '',
      `  ${pc.cyan('FLOWDIFF_API_KEY=')}...`,
      '',
      `Optionally set ${pc.cyan('FLOWDIFF_URL')} there too; it overrides instanceUrl.`,
    ].join('\n'),
    'Next step',
  );
  p.outro(`Then run ${pc.cyan('flowdiff pull')}.`);
}
