import { z } from 'zod';
import type { Connection } from '../config/connection.js';
import {
  ApiError,
  ApiNotFoundError,
  ForbiddenError,
  InvalidApiKeyError,
  UnexpectedResponseError,
  UnreachableError,
} from './errors.js';
import {
  credentialListSchema,
  workflowListSchema,
  workflowSchema,
  type ApiCredential,
  type ApiWorkflow,
} from './schemas.js';

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

export interface GetWorkflowOptions {
  /** Include pin data (used for backups). Default: false. */
  includePinData?: boolean;
}

/** The fields push sends. Built by `buildUpdateBody`; n8n rejects anything else. */
export type WorkflowUpdateBody = Record<string, unknown> & {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
};

export interface N8nClient {
  listWorkflows(options?: ListWorkflowsOptions): Promise<ApiWorkflow[]>;
  getWorkflow(id: string, options?: GetWorkflowOptions): Promise<ApiWorkflow>;
  /**
   * Updates a workflow. Always sends `publishIfActive=false`, so an active
   * workflow's live version is never replaced by an update.
   */
  updateWorkflow(id: string, body: WorkflowUpdateBody): Promise<void>;
  activateWorkflow(id: string): Promise<void>;
  deactivateWorkflow(id: string): Promise<void>;
  /** Needs the `credential:list` API key scope. */
  listCredentials(): Promise<ApiCredential[]>;
}

interface RequestOptions<T> {
  operation: string;
  schema: z.ZodType<T>;
  method?: 'GET' | 'PUT' | 'POST';
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** API key scope to mention when n8n answers 403. */
  scope?: string;
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

  async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const { operation, schema, method = 'GET', query = {}, body, scope } = options;
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          'X-N8N-API-KEY': connection.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      const needs = scope === undefined ? 'workflow read access' : `the "${scope}" scope`;
      throw new ForbiddenError(
        `The API key does not have permission to ${operation} (403). ` +
          `It needs ${needs}; edit the key in n8n under Settings > n8n API.`,
      );
    }
    // A 404 on a list endpoint, or a successful response that isn't JSON (e.g. an
    // HTML login page), means the URL points somewhere that isn't the n8n public API.
    const notTheApi =
      (response.status === 404 && method === 'GET' && !path.includes('/workflows/')) ||
      (response.ok && !isJson(response));
    if (notTheApi) {
      throw new ApiNotFoundError(
        `${where} responded, but no n8n API was found at ${API_PATH}. ` +
          'Check the URL and that the public API is enabled on the instance.',
      );
    }
    if (!response.ok) {
      const detail = await errorMessage(response);
      throw new ApiError(
        `n8n at ${where} returned ${String(response.status)} when trying to ${operation}${detail}.`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new UnexpectedResponseError(`n8n returned invalid JSON when trying to ${operation}.`);
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      const location = issue === undefined ? '' : ` at "${issue.path.join('.')}": ${issue.message}`;
      throw new UnexpectedResponseError(
        `Unexpected response from n8n when trying to ${operation}${location}.`,
      );
    }
    return result.data;
  }

  const workflowPath = (id: string) => `/workflows/${encodeURIComponent(id)}`;
  const anything = z.unknown();

  return {
    async listWorkflows({ tag } = {}) {
      const workflows: ApiWorkflow[] = [];
      let cursor: string | undefined;
      do {
        const page = await request('/workflows', {
          operation: 'list workflows',
          schema: workflowListSchema,
          query: { limit: String(PAGE_SIZE), cursor, tags: tag, excludePinnedData: 'true' },
        });
        workflows.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return workflows;
    },

    getWorkflow(id, { includePinData = false } = {}) {
      return request(workflowPath(id), {
        operation: `read workflow ${id}`,
        schema: workflowSchema,
        query: { excludePinnedData: includePinData ? 'false' : 'true' },
      });
    },

    async updateWorkflow(id, body) {
      await request(workflowPath(id), {
        operation: `update workflow ${id}`,
        schema: anything,
        method: 'PUT',
        query: { publishIfActive: 'false' },
        body,
        scope: 'workflow:update',
      });
    },

    async activateWorkflow(id) {
      await request(`${workflowPath(id)}/activate`, {
        operation: `activate workflow ${id}`,
        schema: anything,
        method: 'POST',
        scope: 'workflow:activate',
      });
    },

    async deactivateWorkflow(id) {
      await request(`${workflowPath(id)}/deactivate`, {
        operation: `deactivate workflow ${id}`,
        schema: anything,
        method: 'POST',
        scope: 'workflow:deactivate',
      });
    },

    async listCredentials() {
      const credentials: ApiCredential[] = [];
      let cursor: string | undefined;
      do {
        const page = await request('/credentials', {
          operation: 'list credentials',
          schema: credentialListSchema,
          query: { limit: String(PAGE_SIZE), cursor },
          scope: 'credential:list',
        });
        credentials.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return credentials;
    },
  };
}

/** n8n error responses carry a `message`; include it so validation errors are actionable. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? `: ${body.message}` : '';
  } catch {
    return '';
  }
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
