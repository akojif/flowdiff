import { createColors } from 'picocolors';
import type { Change, ConnectionRef, ValueChange, WorkflowComparison } from '../diff/index.js';
import { formatPath, hasDifferences } from '../diff/index.js';

export const DEFAULT_MAX_VALUE_LENGTH = 80;

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
}

type Colors = ReturnType<typeof createColors>;

/** Renders comparisons as readable terminal text. Unchanged workflows only appear in the summary. */
export function renderText(comparisons: WorkflowComparison[], options: TextRenderOptions): string {
  const c = createColors(options.color);
  const lines: string[] = [c.dim(`${options.beforeLabel} → ${options.afterLabel}`), ''];

  for (const comparison of comparisons) {
    const title = `${comparison.name} ${c.dim(`(${comparison.id})`)}`;
    switch (comparison.status) {
      case 'unchanged':
      case 'untracked':
        break;
      case 'only-after':
        lines.push(`${c.green('+')} ${title}  ${c.dim(`only in ${options.afterLabel}`)}`, '');
        break;
      case 'only-before':
        lines.push(`${c.red('-')} ${title}  ${c.dim(`only in ${options.beforeLabel}`)}`, '');
        break;
      case 'deleted-on-instance':
        lines.push(`${c.red('!')} ${title}  ${c.red('deleted on instance')}`, '');
        break;
      case 'changed':
        lines.push(`${c.yellow('~')} ${c.bold(title)}`);
        for (const change of comparison.changes) {
          lines.push(...renderChange(change, c, options).map((line) => `    ${line}`));
        }
        lines.push('');
        break;
    }
  }

  lines.push(summary(comparisons, options));
  lines.push(...untrackedLines(comparisons, c, options));
  return lines.join('\n');
}

/**
 * Workflows on the instance that are not tracked locally: one dim line by
 * default, listed individually with `showAll`. They are never shown as removals,
 * because push never deletes.
 */
function untrackedLines(
  comparisons: WorkflowComparison[],
  c: Colors,
  options: TextRenderOptions,
): string[] {
  const untracked = comparisons.filter((comparison) => comparison.status === 'untracked');
  if (untracked.length === 0) return [];

  const count = untracked.length;
  const noun = count === 1 ? 'workflow' : 'workflows';
  const verb = count === 1 ? "isn't" : "aren't";
  const headline = `${String(count)} ${noun} on the instance ${verb} tracked locally (run flowdiff pull to add them)`;
  if (options.showAll !== true) return [c.dim(headline)];
  return [
    c.dim(`${headline}:`),
    ...untracked.map((comparison) => c.dim(`  ? ${comparison.name} (${comparison.id})`)),
  ];
}

function summary(comparisons: WorkflowComparison[], options: TextRenderOptions): string {
  const count = (status: WorkflowComparison['status']) =>
    comparisons.filter((comparison) => comparison.status === status).length;
  const optional = (status: WorkflowComparison['status'], label: string) =>
    count(status) > 0 ? `${String(count(status))} ${label}` : '';
  const parts = [
    `${String(count('changed'))} changed`,
    `${String(count('unchanged'))} unchanged`,
    optional('only-after', `only in ${options.afterLabel}`),
    optional('only-before', `only in ${options.beforeLabel}`),
    optional('deleted-on-instance', 'deleted on instance'),
  ].filter(Boolean);
  return hasDifferences(comparisons) ? `${parts.join(', ')}.` : `No changes (${parts[1] ?? ''}).`;
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
        const indent = ' '.repeat(LABEL_WIDTH + 2);
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
