import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { FlowdiffError } from '../errors.js';
import type { WorkflowFile } from './local-files.js';
import { parseWorkflowFile } from './local-files.js';
import { workflowIdFromFileName } from './paths.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Runs git without a shell, so refs and paths are never interpreted by one. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? '';
    const detail = stderr === '' ? (error as Error).message : stderr;
    throw new FlowdiffError(`git ${args[0] ?? ''} failed: ${detail}`);
  }
}

/** Splits `A..B` into its two refs. Returns undefined for anything else (including `A...B`). */
export function parseRange(value: string): { from: string; to: string } | undefined {
  const parts = value.split('..');
  if (parts.length !== 2) return undefined;
  const [from, to] = parts;
  if (from === undefined || to === undefined || from === '' || to === '' || to.startsWith('.'))
    return undefined;
  return { from, to };
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads every workflow file under `workflowsDir` as it was at `ref`, keyed by id.
 * Paths are relative to `cwd`, which may be a subfolder of the repository.
 */
export async function readWorkflowsAtRef(
  cwd: string,
  ref: string,
  workflowsDir: string,
): Promise<Map<string, WorkflowFile>> {
  const listing = await git(cwd, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    '--end-of-options',
    ref,
    '--',
    workflowsDir,
  ]);
  const result = new Map<string, WorkflowFile>();
  for (const file of listing.split('\0').filter(Boolean)) {
    if (workflowIdFromFileName(basename(file)) === undefined) continue;
    const content = await git(cwd, ['show', `${ref}:./${file}`]);
    const workflow = parseWorkflowFile(content, `${file} at ${ref}`);
    result.set(workflow.id, { file, workflow });
  }
  return result;
}
