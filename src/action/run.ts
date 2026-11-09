import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareGitRefs } from '../commands/diff.js';
import { readConfig } from '../config/config-file.js';
import { shouldFail, type FailOn } from '../diff/index.js';
import { FlowdiffError } from '../errors.js';
import { COMMENT_MAX_LENGTH, isListed, renderMarkdown } from '../render/index.js';
import { mergeBase } from '../workspace/git.js';
import { CommentPermissionError, createGitHubClient, type GitHubClient } from './github-api.js';
import { appendSummary, command, getInput, setOutput, type Env } from './github-env.js';

/** Hidden marker that identifies flowdiff's sticky comment. */
export const COMMENT_MARKER = '<!-- flowdiff-report -->';

/** The job summary allows 1 MiB per step; leave room for other steps' output. */
const SUMMARY_MAX_LENGTH = 900_000;

const FAIL_ON_VALUES: readonly FailOn[] = ['none', 'changes', 'behavior'];

export interface ActionDeps {
  env: Env;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  log: (line: string) => void;
}

interface PullRequestEvent {
  number: number;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}

/**
 * Runs the flowdiff GitHub Action: diffs the workflow files a pull request
 * changes (merge-base..head, git only, no n8n API key), writes the full report
 * to the job summary, keeps one sticky PR comment up to date, and fails the
 * check according to `fail-on`. Secrets are always redacted; there is no way to
 * show them. Returns the process exit code.
 */
export async function runAction(deps: ActionDeps): Promise<number> {
  const { env, log } = deps;

  const failOn = (getInput(env, 'fail-on') || 'none') as FailOn;
  if (!FAIL_ON_VALUES.includes(failOn)) {
    throw new FlowdiffError(`Invalid fail-on "${failOn}". Use none, changes or behavior.`);
  }
  const commentEnabled = (getInput(env, 'comment') || 'true') !== 'false';
  const event = await readPullRequestEvent(env);
  const cwd = resolve(
    env.GITHUB_WORKSPACE ?? process.cwd(),
    getInput(env, 'working-directory') || '.',
  );
  const config = await readConfig(cwd);

  const base = await mergeBase(cwd, event.base.sha, event.head.sha);
  if (base === undefined) {
    throw new FlowdiffError(
      `Could not find where this pull request branched off ${event.base.ref}. ` +
        'Check out the full history: actions/checkout with "fetch-depth: 0".',
    );
  }

  // compareGitRefs always redacts secrets; the Action has no way to turn that off.
  const comparisons = await compareGitRefs(cwd, config, base, event.head.sha);
  const labels = { beforeLabel: event.base.ref, afterLabel: event.head.ref };
  const title = `Changes from ${event.base.ref} to ${event.head.ref}`;
  const runUrl = workflowRunUrl(env);

  const full = renderMarkdown(comparisons, {
    ...labels,
    title,
    maxLength: SUMMARY_MAX_LENGTH,
    canShowSecrets: false,
  });
  if (full.omitted > 0)
    log(
      command(
        'warning',
        `The job summary omits details for ${String(full.omitted)} workflow(s); see report-path.`,
      ),
    );
  const wroteSummary = await appendSummary(env, full.markdown);

  // The full report (never truncated by count) as a file, for upload-artifact.
  const reportPath = join(env.RUNNER_TEMP ?? tmpdir(), 'flowdiff-report.md');
  await writeFile(
    reportPath,
    renderMarkdown(comparisons, { ...labels, title, canShowSecrets: false }).markdown,
    'utf8',
  );

  if (commentEnabled) {
    const report = renderMarkdown(comparisons, {
      ...labels,
      title,
      maxLength: COMMENT_MAX_LENGTH,
      canShowSecrets: false,
      ...(runUrl === undefined ? {} : { fullReportUrl: runUrl }),
    });
    const github = createGitHubClient({
      apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
      repository: requireEnv(env, 'GITHUB_REPOSITORY'),
      token: getInput(env, 'token'),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
    try {
      await upsertStickyComment(github, event.number, `${COMMENT_MARKER}\n${report.markdown}`);
    } catch (error) {
      if (!(error instanceof CommentPermissionError)) throw error;
      log(
        command(
          'notice',
          'Could not comment on this pull request (the token is read-only, as for pull requests from forks). ' +
            `The report is in the job summary${wroteSummary ? '' : ' (unavailable here)'}.`,
        ),
      );
    }
  }

  const listed = comparisons.filter(isListed);
  await setOutput(env, 'changed', String(listed.length));
  await setOutput(env, 'behavior', String(shouldFail(comparisons, 'behavior')));
  await setOutput(env, 'report-path', reportPath);

  if (shouldFail(comparisons, failOn)) {
    log(
      command(
        'error',
        `flowdiff: workflow ${failOn === 'behavior' ? 'behavior ' : ''}changes found (fail-on: ${failOn}).`,
      ),
    );
    return 1;
  }
  return 0;
}

/** Updates flowdiff's earlier comment (marker + posted by a bot), or creates one. */
export async function upsertStickyComment(
  github: GitHubClient,
  issueNumber: number,
  body: string,
): Promise<void> {
  const existing = (await github.listComments(issueNumber)).find(
    (comment) => comment.body.startsWith(COMMENT_MARKER) && comment.user?.type === 'Bot',
  );
  if (existing === undefined) await github.createComment(issueNumber, body);
  else await github.updateComment(existing.id, body);
}

async function readPullRequestEvent(env: Env): Promise<PullRequestEvent> {
  const name = env.GITHUB_EVENT_NAME;
  if (name === 'pull_request_target') {
    throw new FlowdiffError(
      'flowdiff refuses to run on pull_request_target: it would check out untrusted code with a write token. ' +
        'Use the pull_request event.',
    );
  }
  if (name !== 'pull_request') {
    throw new FlowdiffError(
      `flowdiff's Action runs on pull_request events (got "${name ?? 'none'}").`,
    );
  }
  const payload = JSON.parse(await readFile(requireEnv(env, 'GITHUB_EVENT_PATH'), 'utf8')) as {
    pull_request?: PullRequestEvent;
  };
  if (payload.pull_request === undefined) {
    throw new FlowdiffError('The event payload has no pull_request.');
  }
  return payload.pull_request;
}

function workflowRunUrl(env: Env): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env;
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
}

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '')
    throw new FlowdiffError(`${name} is not set; is this running in GitHub Actions?`);
  return value;
}
