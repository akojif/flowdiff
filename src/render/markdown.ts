import type { Change, WorkflowComparison } from '../diff/index.js';
import {
  classifyChange,
  countChanges,
  formatPath,
  isPossibleDefaultChange,
} from '../diff/index.js';
import {
  breakdown,
  changeLines,
  hintsFor,
  isListed,
  orderForDisplay,
  plural,
  summaryLine,
  type TextRenderOptions,
} from './text.js';

/** GitHub rejects comments longer than 65,536 characters; stay well below. */
export const COMMENT_MAX_LENGTH = 60_000;

export interface MarkdownRenderOptions {
  beforeLabel: string;
  afterLabel: string;
  /** Heading text (plain; escaped by the renderer). */
  title: string;
  /** Show long values in full. Default: truncated like the text output. */
  full?: boolean;
  /** Stop adding per-workflow details beyond this many characters. */
  maxLength?: number;
  /** Link shown in the truncation notice, e.g. the workflow run with the full report. */
  fullReportUrl?: string;
  /** Whether --show-secrets exists where this is shown (false in the GitHub Action). */
  canShowSecrets?: boolean;
  /** Leave out the explanatory hints. */
  quiet?: boolean;
}

export interface MarkdownReport {
  markdown: string;
  /** Number of listed workflows whose details didn't fit. */
  omitted: number;
}

/**
 * Renders comparisons as GitHub-flavoured Markdown: a summary table, then
 * collapsible details per workflow until `maxLength` is reached.
 *
 * Workflow names, values and refs come from the repository (for a fork PR, from
 * anyone), so all of it is escaped: HTML, table syntax and @mentions, and code
 * blocks use fences longer than any backtick run inside them.
 */
export function renderMarkdown(
  comparisons: WorkflowComparison[],
  options: MarkdownRenderOptions,
): MarkdownReport {
  const listed = orderForDisplay(comparisons).filter(isListed);
  const head: string[] = [`## flowdiff: ${escapeInline(options.title)}`, ''];
  head.push(`**${escapeInline(summaryLine(comparisons, options))}**`, '');

  if (listed.length > 0) {
    head.push('| | Workflow | Behavior | Cosmetic | What changed |', '|---|---|---|---|---|');
    for (const comparison of listed) head.push(tableRow(comparison, options));
    head.push('');
  }

  const foot: string[] = [];
  const hints =
    options.quiet === true ? [] : hintsFor(comparisons, options.canShowSecrets ?? false);
  for (const hint of hints) {
    foot.push(`> ${hint.tone === 'warning' ? '⚠️ ' : ''}${escapeInline(hint.text)}`, '');
  }

  const max = options.maxLength ?? Number.POSITIVE_INFINITY;
  const details: string[] = [];
  let length = joinedLength(head) + joinedLength(foot) + NOTICE_RESERVE;
  let omitted = 0;
  for (const comparison of listed) {
    const block = detailsBlock(comparison, options);
    if (length + block.length + 1 > max) {
      omitted++;
      continue;
    }
    details.push(block);
    length += block.length + 1;
  }

  const notice =
    omitted === 0
      ? []
      : [
          `> **Note:** details for ${plural(omitted, 'more workflow')} omitted (comment size limit).` +
            (options.fullReportUrl === undefined
              ? ''
              : ` [Full report](${options.fullReportUrl}) in the job summary.`),
          '',
        ];
  return {
    markdown: [...head, ...details, ...notice, ...foot].join('\n').trimEnd() + '\n',
    omitted,
  };
}

/** Room kept for the truncation notice. */
const NOTICE_RESERVE = 300;

function joinedLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

const STATUS_ICON: Record<WorkflowComparison['status'], string> = {
  changed: '~',
  unchanged: '',
  'only-after': '+',
  'only-before': '−',
  untracked: '?',
  'deleted-on-instance': '!',
};

function tableRow(comparison: WorkflowComparison, options: MarkdownRenderOptions): string {
  const attention = comparison.warnings.length > 0 || comparison.secrets.length > 0;
  const icon = attention ? '⚠️' : STATUS_ICON[comparison.status];
  const name = `${escapeCell(comparison.name)} (\`${escapeCode(comparison.id)}\`)${comparison.active ? ' · active' : ''}`;
  const counts = countChanges(comparison.changes);
  const flags = [
    comparison.warnings.length > 0 ? plural(comparison.warnings.length, 'broken reference') : '',
    comparison.secrets.length > 0 ? plural(comparison.secrets.length, 'possible secret') : '',
  ].filter(Boolean);
  const what =
    comparison.status === 'changed'
      ? [breakdown(comparison.changes), ...flags].filter(Boolean).join(' · ')
      : [statusText(comparison, options), ...flags].join(' · ');
  const behavior = comparison.status === 'changed' ? String(counts.behavior) : '';
  const cosmetic = comparison.status === 'changed' ? String(counts.cosmetic) : '';
  return `| ${icon} | ${name} | ${behavior} | ${cosmetic} | ${escapeCell(what)} |`;
}

function statusText(comparison: WorkflowComparison, options: MarkdownRenderOptions): string {
  switch (comparison.status) {
    case 'only-after':
      return `only in ${options.afterLabel}`;
    case 'only-before':
      return `only in ${options.beforeLabel}`;
    case 'deleted-on-instance':
      return 'deleted on instance';
    default:
      return comparison.status;
  }
}

function detailsBlock(comparison: WorkflowComparison, options: MarkdownRenderOptions): string {
  const counts = countChanges(comparison.changes);
  const summary =
    comparison.status === 'changed'
      ? `${plural(counts.behavior, 'behavior change')}, ${String(counts.cosmetic)} cosmetic`
      : statusText(comparison, options);
  const lines = [
    '<details>',
    `<summary>${escapeHtml(comparison.name)} (${escapeHtml(comparison.id)}): ${escapeHtml(summary)}</summary>`,
    '',
  ];

  for (const warning of comparison.warnings) {
    lines.push(
      `- ⚠️ ${escapeInline(`"${warning.node.name}" › ${formatPath(warning.path)} references "${warning.reference}", which is not a node in this workflow`)}`,
    );
  }
  for (const secret of comparison.secrets) {
    lines.push(
      `- ⚠️ ${escapeInline(`"${secret.node.name}" › ${formatPath(secret.path)} looks like a hard-coded secret (${secret.label})`)}`,
    );
  }
  if (comparison.warnings.length + comparison.secrets.length > 0) lines.push('');

  const textOptions: TextRenderOptions = {
    beforeLabel: options.beforeLabel,
    afterLabel: options.afterLabel,
    color: false,
    full: options.full === true,
    // Unindented, so GitHub colours +/- lines inside ```diff blocks.
    hunkIndent: '',
  };
  const groups: [string, Change[]][] = [
    ['Behavior', comparison.changes.filter((c) => classifyChange(c) === 'behavior')],
    [
      'Cosmetic',
      comparison.changes.filter(
        (c) => classifyChange(c) === 'cosmetic' && !isPossibleDefaultChange(c),
      ),
    ],
    ['Possible defaults', comparison.changes.filter(isPossibleDefaultChange)],
  ];
  for (const [label, changes] of groups) {
    if (changes.length === 0) continue;
    lines.push(
      `**${label}**`,
      '',
      codeBlock(
        changes.flatMap((change) => changeLines(change, textOptions)),
        'diff',
      ),
      '',
    );
  }
  lines.push('</details>', '');
  return lines.join('\n');
}

/** A fenced code block whose fence can't be closed by the content. */
export function codeBlock(lines: string[], language = ''): string {
  const content = lines.join('\n');
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

/** Stops @mentions from notifying anyone (zero-width joiner after the @). */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, '@‍');
}

export function escapeHtml(text: string): string {
  return neutralizeMentions(
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  );
}

/** Escapes Markdown syntax and HTML in inline text. */
export function escapeInline(text: string): string {
  return neutralizeMentions(
    text
      .replace(/[\\`*_[\]()#+!|~>]/g, (char) => `\\${char}`)
      .replace(/</g, '&lt;')
      .replace(/\r?\n/g, ' '),
  );
}

function escapeCell(text: string): string {
  return escapeInline(text);
}

/** Text inside an inline code span: backticks can't be escaped, so drop them. */
function escapeCode(text: string): string {
  return text.replace(/`/g, "'").replace(/\|/g, '\\|');
}
