import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { FlowdiffError } from '../errors.js';
import { sortKeysDeep } from '../normalize/normalize.js';

const STATE_PATH = join('.flowdiff', 'state.json');

const workflowStateSchema = z.object({
  /** sha256 of the file content flowdiff last wrote, to detect local edits. */
  hash: z.string(),
  /** Instance version at the last pull, to detect changes on the instance (Phase 3). */
  versionId: z.string().nullable(),
  updatedAt: z.string(),
});

const stateSchema = z.object({
  version: z.literal(1),
  workflows: z.record(z.string(), workflowStateSchema),
});

export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type State = z.infer<typeof stateSchema>;

export function emptyState(): State {
  return { version: 1, workflows: {} };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readState(cwd: string): Promise<State> {
  const path = join(cwd, STATE_PATH);
  if (!existsSync(path)) return emptyState();

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    raw = undefined;
  }
  const result = stateSchema.safeParse(raw);
  if (!result.success) {
    throw new FlowdiffError(`${STATE_PATH} is corrupt. Delete it and run \`flowdiff pull\` again.`);
  }
  return result.data;
}

export async function writeState(cwd: string, state: State): Promise<void> {
  const path = join(cwd, STATE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sortKeysDeep(state), null, 2)}\n`, 'utf8');
}
