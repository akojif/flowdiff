import { createColors } from 'picocolors';
import type { SyncStatus, WorkflowStatus } from '../workspace/status.js';
import { untrackedLines } from './untracked.js';

export interface StatusRenderOptions {
  color: boolean;
  /** List untracked instance workflows individually. */
  showAll: boolean;
  /** e.g. ` with tag "x" (from flowdiff.config.json)`, or empty. */
  scopeDescription: string;
}

/** Listed statuses, in order of how urgently they need attention. */
const LISTED: {
  status: SyncStatus;
  label: string;
  hint: string;
  color: 'red' | 'yellow' | 'green' | 'cyan';
}[] = [
  {
    status: 'conflict',
    label: 'conflict',
    hint: 'changed locally and on the instance',
    color: 'red',
  },
  {
    status: 'deleted-on-instance',
    label: 'deleted on instance',
    hint: "push won't recreate it",
    color: 'red',
  },
  {
    status: 'no-pull-record',
    label: 'no pull record',
    hint: 'run flowdiff pull to record a baseline',
    color: 'yellow',
  },
  {
    status: 'modified-locally',
    label: 'modified locally',
    hint: 'run flowdiff push',
    color: 'green',
  },
  {
    status: 'modified-on-instance',
    label: 'modified on instance',
    hint: 'run flowdiff pull',
    color: 'cyan',
  },
  {
    status: 'new-locally',
    label: 'new locally',
    hint: "push can't create workflows yet",
    color: 'yellow',
  },
];

const LABEL_WIDTH = Math.max(...LISTED.map((entry) => entry.label.length));

export function renderStatusText(statuses: WorkflowStatus[], options: StatusRenderOptions): string {
  const c = createColors(options.color);
  const lines = [c.dim(`Status${options.scopeDescription}`), ''];

  const listed = LISTED.flatMap((entry) =>
    statuses.filter((s) => s.status === entry.status).map((s) => ({ entry, s })),
  );
  const nameWidth = Math.max(0, ...listed.map(({ s }) => `${s.name} (${s.id})`.length));
  for (const { entry, s } of listed) {
    const label = c[entry.color](entry.label.padEnd(LABEL_WIDTH));
    lines.push(`  ${label}  ${`${s.name} (${s.id})`.padEnd(nameWidth)}  ${c.dim(entry.hint)}`);
  }
  if (listed.length > 0) lines.push('');

  const unchanged = statuses.filter((s) => s.status === 'unchanged').length;
  lines.push(
    listed.length === 0
      ? `Everything is in sync (${String(unchanged)} unchanged).`
      : `${String(listed.length)} need attention, ${String(unchanged)} unchanged.`,
  );
  lines.push(
    ...untrackedLines(
      statuses.filter((s) => s.status === 'untracked'),
      c,
      options.showAll,
    ),
  );
  return lines.join('\n');
}

export function renderStatusJson(statuses: WorkflowStatus[]): string {
  return JSON.stringify(
    { workflows: statuses },
    (_key, value: unknown) => (value === undefined ? null : value),
    2,
  );
}
