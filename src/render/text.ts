import { createColors } from 'picocolors';
import type {
  BrokenReference,
  Change,
  ConnectionRef,
  ValueChange,
  WorkflowComparison,
} from '../diff/index.js';
import {
  classifyChange,
  compare,
  countChanges,
  formatPath,
  hasDifferences,
  isPossibleDefaultChange,
} from '../diff/index.js';
import type { SecretFinding } from '../secrets/scan.js';
import { untrackedLines } from './untracked.js';

export const DEFAULT_MAX_VALUE_LENGTH = 80;
const DEFAULT_WIDTH = 80;

export interface TextRenderOptions {
  /** Names for the two sides, e.g. `instance` and `local`, or two git refs. */
  beforeLabel: string;
  afterLabel: string;
  color: boolean;
  /** Show long single-line values in full instead of truncating them. */
  full: boolean;
  /** List untracked instance workflows individually instead of one summary line. */
  showAll?: boolean;
  maxValueLength?: number;
  /** `detail` lists every change; `summary` shows one line per workflow. Default: detail. */
  view?: 'detail' | 'summary';
  /** Terminal width, used to fit workflow names in the summary view. */
  width?: number;
  /** Heading, e.g. "Changes push would make to the instance". Default: "before → after". */
  title?: string;
  /** Indent for lines of a line-level text diff. Default: aligned under the change. */
  hunkIndent?: string;
  /** Leave out the explanatory hints under the summary line. */
  quiet?: boolean;
}

type Colors = ReturnType<typeof createColors>;

/** Renders comparisons as readable terminal text. Unchanged workflows only appear in the summary line. */
export function renderText(comparisons: WorkflowComparison[], options: TextRenderOptions): string {
  const c = createColors(options.color);
  const ordered = orderForDisplay(comparisons);
  const sides = `${options.beforeLabel} → ${options.afterLabel}`;
  const title = options.title ?? sides;

  const lines: string[] = [];
  if (options.view === 'summary') {
    const count = ordered.filter(isListed).length;
    lines.push(
      c.dim(
        `${title}: ${String(count)} workflow${count === 1 ? '' : 's'}, summary view; ` +
          'use --no-stat or `flowdiff diff <workflow>` for details',
      ),
      '',
      ...summaryView(ordered, c, options),
    );
  } else {
    lines.push(c.bold(title), '', ...detailView(ordered, c, options));
  }

  lines.push(summaryLine(comparisons, options));
  if (options.quiet !== true) lines.push(...hints(comparisons, c, options.width));
  lines.push(
    ...untrackedLines(
      comparisons.filter((comparison) => comparison.status === 'untracked'),
      c,
      options.showAll === true,
    ),
  );
  return lines.join('\n');
}

/** Workflows that get their own entry (unchanged and untracked ones only appear in totals). */
export function isListed(comparison: WorkflowComparison): boolean {
  return comparison.status !== 'unchanged' && comparison.status !== 'untracked';
}

const STATUS_RANK: Record<WorkflowComparison['status'], number> = {
  'deleted-on-instance': 0,
  'only-before': 2,
  changed: 3,
  'only-after': 4,
  unchanged: 5,
  untracked: 6,
};

/** Workflows with broken-reference warnings come right after deleted ones. */
const WARNINGS_RANK = 1;

function displayRank(comparison: WorkflowComparison): number {
  const needsAttention = comparison.warnings.length > 0 || comparison.secrets.length > 0;
  if (comparison.status !== 'deleted-on-instance' && needsAttention) {
    return WARNINGS_RANK;
  }
  return STATUS_RANK[comparison.status];
}

/**
 * Display order: workflows that need attention first (deleted, then broken
 * references), then changed workflows with active ones and the most behavior
 * changes first, then new ones. JSON output keeps the plain name/id order.
 */
export function orderForDisplay(comparisons: WorkflowComparison[]): WorkflowComparison[] {
  const counts = new Map(
    comparisons.map((comparison) => [comparison, countChanges(comparison.changes)]),
  );
  return [...comparisons].sort((x, y) => {
    const rank = displayRank(x);
    const byRank = rank - displayRank(y);
    if (byRank !== 0) return byRank;
    if (rank === WARNINGS_RANK || rank === STATUS_RANK.changed) {
      const cx = counts.get(x);
      const cy = counts.get(y);
      const byActive = Number(y.active) - Number(x.active);
      const byBehavior = (cy?.behavior ?? 0) - (cx?.behavior ?? 0);
      const byCosmetic = (cy?.cosmetic ?? 0) - (cx?.cosmetic ?? 0);
      if (byActive !== 0 || byBehavior !== 0 || byCosmetic !== 0) {
        return byActive || byBehavior || byCosmetic;
      }
    }
    return compare(x.name, y.name) || compare(x.id, y.id);
  });
}

function title(comparison: WorkflowComparison, c: Colors): string {
  const active = comparison.active ? `  ${c.green('active')}` : '';
  return `${comparison.name} ${c.dim(`(${comparison.id})`)}${active}`;
}

function detailView(
  ordered: WorkflowComparison[],
  c: Colors,
  options: TextRenderOptions,
): string[] {
  const lines: string[] = [];
  const indent = (prefix: string) => (line: string) => `${prefix}${line}`;

  for (const comparison of ordered) {
    const warnings = [
      ...comparison.warnings.map((warning) => `    ${renderWarning(warning, c)}`),
      ...comparison.secrets.map((secret) => `    ${renderSecret(secret, c)}`),
    ];
    switch (comparison.status) {
      case 'unchanged':
      case 'untracked':
        break;
      case 'only-after':
        lines.push(
          `${c.green('+')} ${title(comparison, c)}  ${c.dim(`only in ${options.afterLabel}`)}`,
          ...warnings,
          '',
        );
        break;
      case 'only-before':
        lines.push(
          `${c.red('-')} ${title(comparison, c)}  ${c.dim(`only in ${options.beforeLabel}`)}`,
          '',
        );
        break;
      case 'deleted-on-instance':
        lines.push(
          `${c.red('!')} ${title(comparison, c)}  ${c.red('deleted on instance')}`,
          ...warnings,
          '',
        );
        break;
      case 'changed': {
        const behavior = comparison.changes.filter(
          (change) => classifyChange(change) === 'behavior',
        );
        const cosmetic = comparison.changes.filter(
          (change) => classifyChange(change) === 'cosmetic' && !isPossibleDefaultChange(change),
        );
        const possibleDefaults = comparison.changes.filter(isPossibleDefaultChange);

        lines.push(`${c.yellow('~')} ${c.bold(title(comparison, c))}`, ...warnings);
        lines.push(
          ...behavior.flatMap((change) => renderChange(change, c, options)).map(indent('    ')),
        );
        if (cosmetic.length > 0) {
          lines.push(`    ${c.dim('cosmetic:')}`);
          lines.push(
            ...cosmetic.flatMap((change) => renderChange(change, c, options)).map(indent('      ')),
          );
        }
        if (possibleDefaults.length > 0) {
          lines.push(`    ${c.dim('possible defaults:')}`);
          lines.push(
            ...possibleDefaults
              .flatMap((change) => renderChange(change, c, options))
              .map(indent('      ')),
          );
        }
        lines.push('');
        break;
      }
    }
  }
  return lines;
}

function renderSecret(secret: SecretFinding, c: Colors): string {
  return c.yellow(
    `⚠ "${secret.node.name}" › ${formatPath(secret.path)} looks like a hard-coded secret (${secret.label})`,
  );
}

function renderWarning(warning: BrokenReference, c: Colors): string {
  const where = `"${warning.node.name}" › ${formatPath(warning.path)}`;
  return c.yellow(
    `⚠ ${where} references "${warning.reference}", which is not a node in this workflow`,
  );
}

/** One line per listed workflow: status, name, active, counts, a short breakdown, warnings. */
function summaryView(
  ordered: WorkflowComparison[],
  c: Colors,
  options: TextRenderOptions,
): string[] {
  const listed = ordered.filter(isListed);
  if (listed.length === 0) return [];

  const width = options.width ?? DEFAULT_WIDTH;
  const longest = Math.max(
    ...listed.map((comparison) => `${comparison.name} (${comparison.id})`.length),
  );
  const nameWidth = Math.min(longest, Math.max(20, width - 56));

  const rows = listed.map((comparison) => {
    const label = fit(`${comparison.name} (${comparison.id})`, nameWidth);
    const active = (comparison.active ? 'active' : '').padEnd(6);
    const flags = [
      comparison.warnings.length > 0 ? plural(comparison.warnings.length, 'broken reference') : '',
      comparison.secrets.length > 0 ? plural(comparison.secrets.length, 'possible secret') : '',
    ].filter(Boolean);
    const warnings = flags.length > 0 ? `  ${c.yellow(`⚠ ${flags.join(', ')}`)}` : '';
    switch (comparison.status) {
      case 'only-after':
        return `${c.green('+')} ${label}  ${active}  ${c.dim(`only in ${options.afterLabel}`)}${warnings}`;
      case 'only-before':
        return `${c.red('-')} ${label}  ${active}  ${c.dim(`only in ${options.beforeLabel}`)}`;
      case 'deleted-on-instance':
        return `${c.red('!')} ${label}  ${active}  ${c.red('deleted on instance')}${warnings}`;
      default: {
        const counts = countChanges(comparison.changes);
        const behavior = `${String(counts.behavior)} behavior`.padEnd(11);
        const cosmetic = (counts.cosmetic > 0 ? `${String(counts.cosmetic)} cosmetic` : '').padEnd(
          11,
        );
        return `${c.yellow('~')} ${label}  ${c.green(active)}  ${behavior}  ${c.dim(cosmetic)}  ${c.dim(breakdown(comparison.changes))}${warnings}`.trimEnd();
      }
    }
  });
  return [...rows, ''];
}

/** Pads or cuts `text` to exactly `width` characters. */
function fit(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

const MAX_BREAKDOWN_ITEMS = 4;

/** A compact description of what changed, e.g. "+1 node · 3 params · 1 link". */
export function breakdown(changes: Change[]): string {
  const count = (predicate: (change: Change) => boolean) => changes.filter(predicate).length;
  const items: [number, string][] = [
    [count((ch) => ch.kind === 'active-changed'), 'status'],
    [count((ch) => ch.kind === 'node-added'), '+node'],
    [count((ch) => ch.kind === 'node-removed'), '-node'],
    [
      count(
        (ch) =>
          classifyChange(ch) === 'behavior' &&
          (ch.kind === 'parameter-changed' ||
            ch.kind === 'node-type-changed' ||
            ch.kind === 'node-property-changed'),
      ),
      'param',
    ],
    [count((ch) => ch.kind === 'credential-changed'), 'credential'],
    [count((ch) => ch.kind === 'connection-added' || ch.kind === 'connection-removed'), 'link'],
    [count((ch) => ch.kind === 'setting-changed' || ch.kind === 'field-changed'), 'setting'],
    [
      count(
        (ch) =>
          ch.kind === 'workflow-renamed' ||
          ch.kind === 'node-renamed' ||
          ch.kind === 'group-renamed',
      ),
      'rename',
    ],
    [count(isPossibleDefaultChange), 'possible default'],
    [
      count((ch) => ch.kind === 'node-property-changed' && classifyChange(ch) === 'cosmetic'),
      'note',
    ],
    [count((ch) => ch.kind === 'node-moved'), 'layout'],
    [count((ch) => ch.kind === 'tag-added' || ch.kind === 'tag-removed'), 'tag'],
    [count((ch) => ch.kind.startsWith('group-') && ch.kind !== 'group-renamed'), 'group change'],
  ];
  const parts = items
    .filter(([n]) => n > 0)
    .map(([n, noun]) => {
      if (noun === 'status' || noun === 'layout') return noun;
      if (noun.startsWith('+') || noun.startsWith('-'))
        return `${noun[0] ?? ''}${plural(n, noun.slice(1))}`;
      return plural(n, noun);
    });
  return parts.length > MAX_BREAKDOWN_ITEMS
    ? `${parts.slice(0, MAX_BREAKDOWN_ITEMS).join(' · ')} · …`
    : parts.join(' · ');
}

export function summaryLine(
  comparisons: WorkflowComparison[],
  options: Pick<TextRenderOptions, 'beforeLabel' | 'afterLabel'>,
): string {
  const count = (status: WorkflowComparison['status']) =>
    comparisons.filter((comparison) => comparison.status === status).length;
  const optional = (n: number, label: string) => (n > 0 ? `${String(n)} ${label}` : '');

  const changed = comparisons.filter((comparison) => comparison.status === 'changed');
  const withBehavior = changed.filter(
    (comparison) => countChanges(comparison.changes).behavior > 0,
  ).length;
  const possibleDefaults = comparisons.reduce(
    (sum, comparison) => sum + countChanges(comparison.changes).possibleDefaults,
    0,
  );
  const brokenReferences = comparisons.reduce(
    (sum, comparison) => sum + comparison.warnings.length,
    0,
  );
  const secrets = comparisons.reduce((sum, comparison) => sum + comparison.secrets.length, 0);

  const parts = [
    changed.length > 0
      ? `${String(changed.length)} changed (${String(withBehavior)} with behavior changes)`
      : '0 changed',
    `${String(count('unchanged'))} unchanged`,
    optional(count('only-after'), `only in ${options.afterLabel}`),
    optional(count('only-before'), `only in ${options.beforeLabel}`),
    optional(count('deleted-on-instance'), 'deleted on instance'),
    possibleDefaults > 0 ? plural(possibleDefaults, 'possible default') : '',
    brokenReferences > 0 ? plural(brokenReferences, 'broken reference') : '',
    secrets > 0 ? plural(secrets, 'possible secret') : '',
  ].filter(Boolean);
  return hasDifferences(comparisons) ? `${parts.join(', ')}.` : `No changes (${parts[1] ?? ''}).`;
}

export interface Hint {
  tone: 'info' | 'warning';
  text: string;
}

/**
 * Explanations printed under the summary, shared by the text and Markdown
 * renderers. `canShowSecrets` is false where --show-secrets doesn't exist
 * (the GitHub Action), so the hint never suggests it there.
 */
export function hintsFor(comparisons: WorkflowComparison[], canShowSecrets: boolean): Hint[] {
  const hints: Hint[] = [];
  if (comparisons.some((comparison) => comparison.changes.some(isPossibleDefaultChange))) {
    hints.push({
      tone: 'info',
      text: 'Possible defaults: likely removed by the n8n editor on save; flowdiff pull refreshes your baseline.',
    });
  }
  if (comparisons.some((comparison) => comparison.warnings.length > 0)) {
    hints.push({
      tone: 'warning',
      text: "Broken references: these expressions name nodes that don't exist, so those nodes will fail.",
    });
  }
  if (comparisons.some((comparison) => comparison.secrets.length > 0)) {
    hints.push({
      tone: 'warning',
      text: `Possible secrets are redacted${canShowSecrets ? ' (--show-secrets shows them)' : ''}; use n8n credentials and rotate any real key.`,
    });
  }
  return hints;
}

function hints(comparisons: WorkflowComparison[], c: Colors, width: number | undefined): string[] {
  return hintsFor(comparisons, true).flatMap((hint) =>
    wrapWords(hint.text, width).map((line) =>
      hint.tone === 'warning' ? c.yellow(line) : c.dim(line),
    ),
  );
}

/** Splits text into lines of at most `width` characters at word boundaries. No width: one line. */
export function wrapWords(text: string, width: number | undefined): string[] {
  if (width === undefined || text.length <= width) return [text];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Plain (uncoloured) lines for one change. */
export function changeLines(change: Change, options: TextRenderOptions): string[] {
  return renderChange(change, createColors(false), options);
}

const LABEL_WIDTH = 8;

function renderChange(change: Change, c: Colors, options: TextRenderOptions): string[] {
  const value = (v: unknown) => formatValue(v, options);
  const name = (n: string) => `"${n}"`;
  const line = (symbol: '+' | '-' | '~', label: string, text: string) => {
    const colored =
      symbol === '+' ? c.green(symbol) : symbol === '-' ? c.red(symbol) : c.yellow(symbol);
    return `${colored} ${c.dim(label.padEnd(LABEL_WIDTH))}${text}`;
  };

  switch (change.kind) {
    case 'workflow-renamed':
      return [line('~', 'name', `${name(change.from)} → ${name(change.to)}`)];
    case 'active-changed':
      return [line('~', 'status', `${activeLabel(change.from)} → ${activeLabel(change.to)}`)];
    case 'tag-added':
      return [line('+', 'tag', change.tag)];
    case 'tag-removed':
      return [line('-', 'tag', change.tag)];
    case 'node-added':
      return [line('+', 'node', `${name(change.node.name)} ${c.dim(`(${change.node.type})`)}`)];
    case 'node-removed':
      return [line('-', 'node', `${name(change.node.name)} ${c.dim(`(${change.node.type})`)}`)];
    case 'node-renamed':
      return [line('~', 'node', `${name(change.from)} renamed to ${name(change.to)}`)];
    case 'node-type-changed':
      return [
        line(
          '~',
          'node',
          `${name(change.node.name)} ${change.field}: ${value(change.from)} → ${value(change.to)}`,
        ),
      ];
    case 'parameter-changed':
      return renderValueChange(
        'param',
        `${name(change.node.name)} › ${formatPath(change.path)}`,
        change.change,
      );
    case 'node-property-changed':
      return renderValueChange(
        'prop',
        `${name(change.node.name)} › ${formatPath(change.path)}`,
        change.change,
      );
    case 'credential-changed': {
      const subject = `${name(change.node.name)} ${change.credentialType}`;
      if (change.from === null) return [line('+', 'cred', `${subject}: ${name(change.to ?? '')}`)];
      if (change.to === null) return [line('-', 'cred', `${subject}: ${name(change.from)}`)];
      return [line('~', 'cred', `${subject}: ${name(change.from)} → ${name(change.to)}`)];
    }
    case 'node-moved':
      return [
        line(
          '~',
          'layout',
          `${name(change.node.name)} ${value(change.from)} → ${value(change.to)}`,
        ),
      ];
    case 'connection-added':
      return [line('+', 'link', formatConnection(change.connection))];
    case 'connection-removed':
      return [line('-', 'link', formatConnection(change.connection))];
    case 'group-added':
      return [line('+', 'group', name(change.group.name))];
    case 'group-removed':
      return [line('-', 'group', name(change.group.name))];
    case 'group-renamed':
      return [line('~', 'group', `${name(change.from)} renamed to ${name(change.to)}`)];
    case 'group-description-changed':
      return renderValueChange('group', `${name(change.group.name)} › description`, change.change);
    case 'group-node-joined':
      return [
        line('+', 'group', `${name(change.group.name)} now contains ${name(change.node.name)}`),
      ];
    case 'group-node-left':
      return [
        line(
          '-',
          'group',
          `${name(change.group.name)} no longer contains ${name(change.node.name)}`,
        ),
      ];
    case 'setting-changed':
      return renderValueChange('setting', formatPath(change.path), change.change);
    case 'field-changed':
      return renderValueChange('field', formatPath(change.path), change.change);
  }

  function renderValueChange(label: string, subject: string, valueChange: ValueChange): string[] {
    switch (valueChange.type) {
      case 'added':
        return [line('+', label, `${subject}: ${value(valueChange.value)}`)];
      case 'removed':
        return [line('-', label, `${subject}: ${value(valueChange.value)}`)];
      case 'modified':
        return [
          line('~', label, `${subject}: ${value(valueChange.from)} → ${value(valueChange.to)}`),
        ];
      case 'reordered':
        return [
          line(
            '~',
            label,
            `${subject}: order ${valueChange.from.join(', ')} → ${valueChange.to.join(', ')}`,
          ),
        ];
      case 'text': {
        const indent = options.hunkIndent ?? ' '.repeat(LABEL_WIDTH + 2);
        const out = [line('~', label, subject)];
        if (valueChange.lineEndingsChanged) out.push(`${indent}${c.dim('(line endings changed)')}`);
        for (const hunk of valueChange.hunks) {
          out.push(
            `${indent}${c.cyan(
              `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
            )}`,
          );
          for (const hunkLine of hunk.lines) {
            const colored = hunkLine.startsWith('+')
              ? c.green(hunkLine)
              : hunkLine.startsWith('-')
                ? c.red(hunkLine)
                : hunkLine;
            out.push(`${indent}${colored}`);
          }
        }
        return out;
      }
    }
  }
}

function activeLabel(active: boolean): string {
  return active ? 'active' : 'inactive';
}

function formatConnection(connection: ConnectionRef): string {
  const output =
    connection.outputLabel !== undefined
      ? ` (${connection.outputLabel})`
      : connection.output > 0
        ? ` (output ${String(connection.output)})`
        : '';
  const type = connection.type === 'main' ? '' : ` [${connection.type}]`;
  const input = connection.input > 0 ? ` (input ${String(connection.input)})` : '';
  return `"${connection.source.name}"${output} → "${connection.target.name}"${input}${type}`;
}

/**
 * JSON-style value for display. Long values are cut with an explicit marker
 * unless `full` is set; multi-line text never reaches here (it gets hunks).
 */
export function formatValue(
  value: unknown,
  options: Pick<TextRenderOptions, 'full' | 'maxValueLength'>,
): string {
  // JSON.stringify(undefined) returns undefined at runtime, despite its declared type.
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  const max = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
  if (options.full || text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${String(text.length)} chars; use --full]`;
}
