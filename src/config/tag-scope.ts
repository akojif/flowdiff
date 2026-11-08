import { CONFIG_FILE_NAME, type Config } from './config-file.js';

export interface TagScope {
  /** Undefined means no tag filter. */
  tag: string | undefined;
  /** Where the tag (or its absence) came from, for messages. */
  source: '--tag' | '--no-tag' | typeof CONFIG_FILE_NAME | 'default';
}

/**
 * Works out which tag filter a command uses.
 *
 * Precedence:
 *   1. `--tag <name>` on the command line
 *   2. `--no-tag`, which turns a saved filter off for this run
 *   3. `tag` from flowdiff.config.json
 *
 * Commander gives `flagTag` as a string for `--tag`, `false` for `--no-tag`,
 * and `undefined` when neither was passed.
 */
export function resolveTagScope(config: Config, flagTag: string | false | undefined): TagScope {
  if (typeof flagTag === 'string') return { tag: flagTag, source: '--tag' };
  if (flagTag === false) return { tag: undefined, source: '--no-tag' };
  if (config.tag !== undefined) return { tag: config.tag, source: CONFIG_FILE_NAME };
  return { tag: undefined, source: 'default' };
}

/** Describes the filter for status lines, e.g. ` with tag "x" (from flowdiff.config.json)`. */
export function describeTagScope(scope: TagScope): string {
  return scope.tag === undefined ? '' : ` with tag "${scope.tag}" (from ${scope.source})`;
}
