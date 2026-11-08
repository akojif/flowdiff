import type { z } from 'zod';
import type { Connection } from '../config/connection.js';
import {
  ApiError,
  ApiNotFoundError,
  ForbiddenError,
  InvalidApiKeyError,
  UnexpectedResponseError,
  UnreachableError,
} from './errors.js';
import { workflowListSchema, workflowSchema, type ApiWorkflow } from './schemas.js';

const API_PATH = '/api/v1';
const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ClientOptions {
  connection: Connection;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ListWorkflowsOptions {
  /** Only return workflows with this tag name. */
  tag?: string;
}

export interface N8nClient {
  listWorkflows(options?: ListWorkflowsOptions): Promise<ApiWorkflow[]>;
  getWorkflow(id: string): Promise<ApiWorkflow>;
}

/**
 * Turns the instance URL into the API base URL. Accepts the URL with or without
 * a trailing slash or `/api/v1`, since both are easy to paste by accident.
 */
export function apiBaseUrl(instanceUrl: string): string {
  const url = new URL(instanceUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${url.origin}${path}${API_PATH}`;
}

export function createClient(options: ClientOptions): N8nClient {
  const { connection, fetch: fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const baseUrl = apiBaseUrl(connection.instanceUrl);
  const where = `${connection.instanceUrl} (from ${connection.urlSource})`;

  async function request<T>(
    path: string,
    operation: string,
    schema: z.ZodType<T>,
    query: Record<string, string | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { 'X-N8N-API-KEY': connection.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UnreachableError(
        `Could not reach n8n at ${where}: ${describeNetworkError(error)}.`,
      );
    }

    if (response.status === 401) {
      throw new InvalidApiKeyError(
        `n8n at ${where} rejected the API key (401). Check FLOWDIFF_API_KEY.`,
      );
    }
    if (response.status === 403) {
      throw new ForbiddenError(
        `The API key does not have permission to ${operation} (403). ` +
          'Create a key with workflow read access in n8n under Settings > n8n API.',
      );
    }
    // A 404, or a successful response that isn't JSON (e.g. an HTML login page),
    // means the URL points somewhere that isn't the n8n public API.
    const notTheApi = response.status === 404 || (response.ok && !isJson(response));
    if (notTheApi) {
      throw new ApiNotFoundError(
        `${where} responded, but no n8n API was found at ${API_PATH}. ` +
          'Check the URL and that the public API is enabled on the instance.',
      );
    }
    if (!response.ok) {
      throw new ApiError(
        `n8n at ${where} returned ${String(response.status)} when trying to ${operation}.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UnexpectedResponseError(`n8n returned invalid JSON when trying to ${operation}.`);
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      const issue = result.error.issues[0];
      const location = issue === undefined ? '' : ` at "${issue.path.join('.')}": ${issue.message}`;
      throw new UnexpectedResponseError(
        `Unexpected response from n8n when trying to ${operation}${location}.`,
      );
    }
    return result.data;
  }

  return {
    async listWorkflows({ tag } = {}) {
      const workflows: ApiWorkflow[] = [];
      let cursor: string | undefined;
      do {
        const page = await request('/workflows', 'list workflows', workflowListSchema, {
          limit: String(PAGE_SIZE),
          cursor,
          tags: tag,
          excludePinnedData: 'true',
        });
        workflows.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return workflows;
    },

    getWorkflow(id) {
      return request(
        `/workflows/${encodeURIComponent(id)}`,
        `read workflow ${id}`,
        workflowSchema,
        { excludePinnedData: 'true' },
      );
    },
  };
}

function isJson(response: Response): boolean {
  return response.headers.get('content-type')?.includes('application/json') ?? false;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'the request timed out';
  }
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  switch (cause?.code) {
    case 'ENOTFOUND':
      return 'the host name could not be resolved';
    case 'ECONNREFUSED':
      return 'the connection was refused';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `TLS certificate problem (${cause.code})`;
    default:
      return cause?.code ?? (error instanceof Error ? error.message : String(error));
  }
}
