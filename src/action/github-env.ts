import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { FlowdiffError } from '../errors.js';

/**
 * Minimal helpers for the GitHub Actions runtime: inputs, outputs, the job
 * summary and workflow commands. Written here instead of depending on
 * @actions/core; they follow GitHub's documented file and escaping formats.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads an action input. JavaScript actions get `fail-on` as `INPUT_FAIL-ON`;
 * composite actions map inputs themselves and use `INPUT_FAIL_ON`, since names
 * with hyphens aren't valid shell variables. Both forms are accepted.
 */
export function getInput(env: Env, name: string): string {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (env[key] ?? env[key.replace(/-/g, '_')] ?? '').trim();
}

/**
 * One entry for the GITHUB_OUTPUT file, using the multi-line form
 * `name<<DELIMITER\nvalue\nDELIMITER`. The delimiter is random and re-chosen if
 * the value contains it, so a value can never end the entry early and inject
 * extra outputs. Pure apart from `randomId`.
 */
export function outputEntry(
  name: string,
  value: string,
  randomId: () => string = () => randomBytes(16).toString('hex'),
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new FlowdiffError(`Invalid output name "${name}".`);
  }
  let delimiter = `ghadelimiter_${randomId()}`;
  while (value.includes(delimiter)) delimiter = `ghadelimiter_${randomId()}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export async function setOutput(env: Env, name: string, value: string): Promise<void> {
  const file = env.GITHUB_OUTPUT;
  if (file === undefined || file === '') return;
  await appendFile(file, outputEntry(name, value), 'utf8');
}

/** Appends Markdown to the job summary shown on the workflow run page. */
export async function appendSummary(env: Env, markdown: string): Promise<boolean> {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file === undefined || file === '') return false;
  await appendFile(file, `${markdown}\n`, 'utf8');
  return true;
}

/**
 * A workflow command line such as `::warning::message`. Messages are escaped as
 * GitHub requires, so content can't start a new command on its own line.
 */
export function command(kind: 'notice' | 'warning' | 'error', message: string): string {
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::${kind}::${escaped}`;
}
