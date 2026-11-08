import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EnvValues {
  apiKey: string | undefined;
  url: string | undefined;
}

/**
 * Loads `.env` from `cwd` into `process.env` if the file exists.
 * Variables already set in the shell win over values in the file.
 */
export function loadDotEnv(cwd: string): void {
  const path = join(cwd, '.env');
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

/** Reads flowdiff's variables, treating empty strings as unset. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvValues {
  return {
    apiKey: nonEmpty(env.FLOWDIFF_API_KEY),
    url: nonEmpty(env.FLOWDIFF_URL),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
