import { CONFIG_FILE_NAME, type Config } from './config-file.js';
import type { TagScope } from './tag-scope.js';

export type PushGuard =
  /** Push only touches workflows with this tag, locally and on the instance. */
  | { kind: 'tag'; tag: string; source: string }
  /** `requireTag: false`: the user explicitly allowed pushing any workflow. */
  | { kind: 'off' }
  /** Nothing configured: push refuses everything. */
  | { kind: 'unset' };

/**
 * Works out which tag push requires. Strict by default:
 *
 *   requireTag: "x"   → tag x (CLI flags never loosen it)
 *   requireTag: false → no tag required (explicit opt-out)
 *   otherwise         → the tag scope's tag (config `tag` or `--tag`)
 *   nothing set       → push refuses everything
 */
export function resolvePushGuard(config: Config, scope: TagScope): PushGuard {
  if (typeof config.requireTag === 'string') {
    return { kind: 'tag', tag: config.requireTag, source: `requireTag in ${CONFIG_FILE_NAME}` };
  }
  if (config.requireTag === false) return { kind: 'off' };
  if (scope.tag !== undefined) {
    const source = scope.source === '--tag' ? '--tag' : `tag in ${CONFIG_FILE_NAME}`;
    return { kind: 'tag', tag: scope.tag, source };
  }
  return { kind: 'unset' };
}

/** What to tell the user when push has no guard, including exactly what to add. */
export function unsetGuardMessage(): string {
  return [
    `push needs to know which workflows it may change. Add one of these to ${CONFIG_FILE_NAME}:`,
    '',
    '  "requireTag": "flowdiff"   push only touches workflows tagged "flowdiff" (recommended;',
    '                             use any tag name, and add that tag to the workflows in n8n)',
    '  "requireTag": false        push may change any workflow (not recommended)',
    '',
    'A "tag" setting also works as the push guard. Nothing was pushed.',
  ].join('\n');
}

export function describePushGuard(guard: PushGuard): string {
  switch (guard.kind) {
    case 'tag':
      return `push guard: tag "${guard.tag}" (${guard.source})`;
    case 'off':
      return `push guard: off (requireTag: false in ${CONFIG_FILE_NAME})`;
    case 'unset':
      return 'push guard: not configured';
  }
}
