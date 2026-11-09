import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Saves the instance version of a workflow before push overwrites it, as the
 * full API response (including pin data). Returns the path relative to `cwd`.
 */
export async function writeBackup(
  cwd: string,
  workflowId: string,
  workflow: unknown,
  date: Date,
): Promise<string> {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  const file = join('.flowdiff', 'backups', workflowId, `${stamp}.json`);
  await mkdir(dirname(join(cwd, file)), { recursive: true });
  // 'wx' fails instead of overwriting if two pushes land in the same millisecond.
  await writeFile(join(cwd, file), `${JSON.stringify(workflow, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return file;
}
