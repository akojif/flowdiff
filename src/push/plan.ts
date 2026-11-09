import type { WorkflowUpdateBody } from '../api/client.js';
import type { ApiCredential } from '../api/schemas.js';
import {
  diffWorkflows,
  findBrokenReferences,
  type BrokenReference,
  type Change,
  type WorkflowComparison,
} from '../diff/index.js';
import type { PushGuard } from '../config/push-guard.js';
import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { REDACTION_PREFIX, redactWorkflow, scanWorkflowSecrets } from '../secrets/scan.js';
import type { WorkflowFile } from '../workspace/local-files.js';
import type { WorkflowStatus } from '../workspace/status.js';
import { buildUpdateBody } from './request-body.js';

export interface PlannedPush {
  action: 'push';
  id: string;
  name: string;
  file: string;
  body: WorkflowUpdateBody;
  /** Fields left out of the request because n8n would reject them. */
  dropped: string[];
  /** For rendering the diff (instance → local). */
  comparison: WorkflowComparison;
  brokenReferences: BrokenReference[];
  /** This push adds or changes a possible secret (unchanged existing ones don't count). */
  changesSecret: boolean;
  credentialWarnings: string[];
  /** Things push will not do for this workflow, e.g. tag changes. */
  notes: string[];
  /** Only set with --apply-active. */
  activeChange: 'activate' | 'deactivate' | undefined;
}

export interface NotPushed {
  action: 'skip' | 'refuse';
  id: string;
  name: string;
  reason: string;
}

export type PushDecision = PlannedPush | NotPushed;

export interface PlanInput {
  statuses: WorkflowStatus[];
  local: ReadonlyMap<string, WorkflowFile>;
  instance: ReadonlyMap<string, NormalizedWorkflow>;
  /** Credentials on the instance, or undefined when they could not be listed. */
  credentials: ApiCredential[] | undefined;
  /** Only consider these workflow ids (from a selector). */
  selected?: ReadonlySet<string> | undefined;
  force: boolean;
  applyActive: boolean;
  /** Show secret values in the diff. The request body is never redacted. */
  showSecrets: boolean;
  /**
   * The resolved push guard (see resolvePushGuard). With a tag, workflows without
   * it, locally or on the instance, are refused; --force does not bypass this.
   * An unset guard must be handled before planning.
   */
  guard: Exclude<PushGuard, { kind: 'unset' }>;
}

const SKIP_REASONS: Partial<Record<WorkflowStatus['status'], string>> = {
  unchanged: 'nothing to push',
  'modified-on-instance': 'only changed on the instance; run flowdiff pull',
  'new-locally': "not on the instance; push can't create workflows yet",
  'deleted-on-instance': "deleted on the instance; push won't recreate it",
  untracked: 'not tracked locally',
};

/** Decides what push does with each workflow, and why. Pure. */
export function planPush(input: PlanInput): PushDecision[] {
  const considered = input.statuses.filter((s) =>
    input.selected === undefined
      ? s.status !== 'unchanged' && s.status !== 'untracked'
      : input.selected.has(s.id),
  );
  return considered.map((status) => decide(status, input));
}

function decide(status: WorkflowStatus, input: PlanInput): PushDecision {
  const { id, name } = status;
  const skipReason = SKIP_REASONS[status.status];
  if (skipReason !== undefined) return { action: 'skip', id, name, reason: skipReason };

  const local = input.local.get(id);
  const remote = input.instance.get(id);
  if (local === undefined || remote === undefined) {
    return { action: 'skip', id, name, reason: 'missing on one side' };
  }

  if (input.guard.kind === 'tag') {
    const { tag, source } = input.guard;
    const missingTag = [
      local.workflow.tags.includes(tag) ? '' : 'locally',
      remote.tags.includes(tag) ? '' : 'on the instance',
    ].filter(Boolean);
    if (missingTag.length > 0) {
      return {
        action: 'refuse',
        id,
        name,
        reason: `push guard: needs the tag "${tag}" (${source}), missing ${missingTag.join(' and ')}`,
      };
    }
  }

  if ((status.status === 'conflict' || status.status === 'no-pull-record') && !input.force) {
    const why =
      status.status === 'conflict'
        ? 'changed on the instance since the last pull'
        : 'no pull record, so instance changes cannot be ruled out';
    return {
      action: 'refuse',
      id,
      name,
      reason: `${why}; run flowdiff pull, or use --force to overwrite`,
    };
  }

  const changes = diffWorkflows(remote, local.workflow);
  const notes: string[] = [];
  if (changes.some((c) => c.kind === 'tag-added' || c.kind === 'tag-removed')) {
    notes.push("tag changes aren't pushed");
  }
  const activeDiffers = remote.active !== local.workflow.active;
  if (activeDiffers && !input.applyActive) {
    notes.push(`active on/off isn't changed without --apply-active`);
  }

  const contentChanges = changes.filter(
    (c) => c.kind !== 'tag-added' && c.kind !== 'tag-removed' && c.kind !== 'active-changed',
  );
  if (contentChanges.length === 0 && !(activeDiffers && input.applyActive)) {
    return { action: 'skip', id, name, reason: `nothing push can change (${notes.join('; ')})` };
  }

  // The request body always comes from the real local file; only what is shown is redacted.
  const { body, dropped } = buildUpdateBody(local.workflow);
  const brokenReferences = findBrokenReferences(local.workflow);
  const redactedChanges = diffWorkflows(redactWorkflow(remote), redactWorkflow(local.workflow));
  const secrets = scanWorkflowSecrets(local.workflow);
  const addedNodeIds = new Set(
    changes.flatMap((c) => (c.kind === 'node-added' ? [c.node.id] : [])),
  );
  return {
    action: 'push',
    id,
    name,
    file: local.file,
    body,
    dropped,
    comparison: {
      id,
      name,
      status: 'changed',
      active: remote.active,
      changes: visible(input.showSecrets ? changes : redactedChanges, input),
      warnings: brokenReferences,
      secrets,
    },
    brokenReferences,
    changesSecret:
      redactedChanges.some(addsOrChangesSecret) || secrets.some((f) => addedNodeIds.has(f.node.id)),
    credentialWarnings: checkCredentials(local.workflow, input.credentials),
    notes,
    activeChange:
      activeDiffers && input.applyActive
        ? local.workflow.active
          ? 'activate'
          : 'deactivate'
        : undefined,
  };
}

/**
 * Whether a value change (from redacted workflows) introduces a secret: a
 * redaction marker in an added or new value, or on an added line. Removed and
 * unchanged secrets don't count; context lines in a text diff are ignored.
 * Secrets inside newly added nodes are handled by the caller.
 */
function addsOrChangesSecret(change: Change): boolean {
  if (!('change' in change)) return false;
  const value = change.change;
  switch (value.type) {
    case 'added':
      return containsMarker(value.value);
    case 'modified':
      return containsMarker(value.to);
    case 'text':
      return value.hunks.some((hunk) =>
        hunk.lines.some((line) => line.startsWith('+') && line.includes(REDACTION_PREFIX)),
      );
    default:
      return false;
  }
}

function containsMarker(value: unknown): boolean {
  // JSON.stringify(undefined) returns undefined at runtime, despite its declared type.
  return value !== undefined && JSON.stringify(value).includes(REDACTION_PREFIX);
}

/** The diff shown before confirming: without the active change unless it will be applied. */
function visible(changes: Change[], input: PlanInput): Change[] {
  return input.applyActive ? changes : changes.filter((c) => c.kind !== 'active-changed');
}

/**
 * Credentials are referenced by name: on update, n8n resolves a credential id it
 * doesn't know by name and type (if exactly one matches). Warn when that cannot work.
 */
function checkCredentials(
  workflow: NormalizedWorkflow,
  credentials: ApiCredential[] | undefined,
): string[] {
  if (credentials === undefined) return [];
  const warnings: string[] = [];
  for (const node of workflow.nodes) {
    for (const [type, ref] of Object.entries(node.credentials ?? {})) {
      if (credentials.some((c) => c.type === type && c.id === ref.id)) continue;
      const byName = credentials.filter((c) => c.type === type && c.name === ref.name);
      if (byName.length === 0) {
        warnings.push(
          `node "${node.name}" uses credential "${ref.name}" (${type}), which doesn't exist on the instance`,
        );
      } else if (byName.length > 1) {
        warnings.push(
          `node "${node.name}" uses credential "${ref.name}" (${type}), which matches ${String(byName.length)} credentials on the instance`,
        );
      }
    }
  }
  return warnings;
}
