/** The few GitHub REST calls the Action needs: listing, creating and updating PR comments. */

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
}

export interface GitHubClient {
  listComments(issueNumber: number): Promise<IssueComment[]>;
  createComment(issueNumber: number, body: string): Promise<void>;
  updateComment(commentId: number, body: string): Promise<void>;
}

/** Commenting isn't allowed, e.g. the read-only token GitHub gives fork pull requests. */
export class CommentPermissionError extends Error {
  override name = 'CommentPermissionError';
}

export interface GitHubClientOptions {
  apiUrl: string;
  /** `owner/repo`. */
  repository: string;
  token: string;
  fetch?: typeof fetch;
}

const PER_PAGE = 100;

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const { apiUrl, repository, token, fetch: fetchFn = fetch } = options;
  const base = `${apiUrl.replace(/\/+$/, '')}/repos/${repository}`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 403 || response.status === 404) {
      throw new CommentPermissionError(
        `GitHub returned ${String(response.status)} for ${method} ${path}`,
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub returned ${String(response.status)} for ${method} ${path}`);
    }
    return response.status === 204 ? undefined : response.json();
  }

  return {
    async listComments(issueNumber) {
      const comments: IssueComment[] = [];
      for (let page = 1; ; page++) {
        const batch = (await call(
          'GET',
          `/issues/${String(issueNumber)}/comments?per_page=${String(PER_PAGE)}&page=${String(page)}`,
        )) as IssueComment[];
        comments.push(...batch);
        if (batch.length < PER_PAGE) return comments;
      }
    },
    async createComment(issueNumber, body) {
      await call('POST', `/issues/${String(issueNumber)}/comments`, { body });
    },
    async updateComment(commentId, body) {
      await call('PATCH', `/issues/comments/${String(commentId)}`, { body });
    },
  };
}
