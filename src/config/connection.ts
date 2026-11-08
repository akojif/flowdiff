import { FlowdiffError } from '../errors.js';
import { CONFIG_FILE_NAME, type Config } from './config-file.js';
import type { EnvValues } from './env.js';

export type UrlSource = 'FLOWDIFF_URL' | typeof CONFIG_FILE_NAME;

export interface Connection {
  /** Instance URL as given by the user, e.g. `https://n8n.example.com`. */
  instanceUrl: string;
  /** Where `instanceUrl` came from, so error messages can point at the right place. */
  urlSource: UrlSource;
  apiKey: string;
}

/**
 * Works out how to reach the n8n instance.
 *
 * Precedence for the instance URL:
 *   1. `FLOWDIFF_URL` from the environment (or `.env`), if set
 *   2. `instanceUrl` from flowdiff.config.json
 *
 * The API key is only ever read from `FLOWDIFF_API_KEY`; it is never stored in config.
 */
export function resolveConnection(config: Config, env: EnvValues): Connection {
  if (env.apiKey === undefined) {
    throw new FlowdiffError(
      'FLOWDIFF_API_KEY is not set. Add it to .env (see .env.example) or export it in your shell.',
    );
  }

  const [instanceUrl, urlSource]: [string, UrlSource] =
    env.url === undefined ? [config.instanceUrl, CONFIG_FILE_NAME] : [env.url, 'FLOWDIFF_URL'];

  if (!isHttpUrl(instanceUrl)) {
    throw new FlowdiffError(
      `Instance URL "${instanceUrl}" (from ${urlSource}) is not a valid URL. ` +
        'Expected something like https://n8n.example.com.',
    );
  }

  return { instanceUrl, urlSource, apiKey: env.apiKey };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
