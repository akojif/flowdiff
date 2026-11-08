import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FlowdiffError } from '../errors.js';

export const CONFIG_FILE_NAME = 'flowdiff.config.json';

// The API key is deliberately not part of this schema: it is only ever read from env.
export const configSchema = z.strictObject({
  instanceUrl: z.url({ protocol: /^https?$/ }),
  workflowsDir: z.string().min(1).default('workflows'),
  /** Only track workflows with this tag. Applies to pull, diff, status and push. */
  tag: z.string().trim().min(1).optional(),
});

export type Config = z.infer<typeof configSchema>;

export function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

export function configExists(cwd: string): boolean {
  return existsSync(configPath(cwd));
}

export async function readConfig(cwd: string): Promise<Config> {
  const path = configPath(cwd);
  if (!existsSync(path)) {
    throw new FlowdiffError(`No ${CONFIG_FILE_NAME} found in ${cwd}. Run \`flowdiff init\` first.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new FlowdiffError(`${CONFIG_FILE_NAME} is not valid JSON: ${(error as Error).message}`);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new FlowdiffError(`${CONFIG_FILE_NAME} is invalid:\n${details}`);
  }
  return result.data;
}

export async function writeConfig(cwd: string, config: Config): Promise<void> {
  await writeFile(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
