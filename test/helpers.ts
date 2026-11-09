import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { N8nClient, WorkflowUpdateBody } from '../src/api/client.js';
import { ForbiddenError } from '../src/api/errors.js';
import { workflowSchema, type ApiCredential, type ApiWorkflow } from '../src/api/schemas.js';
import { normalizeWorkflow, type NormalizedWorkflow } from '../src/normalize/normalize.js';

export function loadFixture(name: string): ApiWorkflow {
  const raw: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'),
  );
  return workflowSchema.parse(raw);
}

export function loadAllFixtures(): ApiWorkflow[] {
  return ['linear.json', 'if-branch.json', 'credential-ref.json'].map(loadFixture);
}

export interface FakeCall {
  method: 'list' | 'get' | 'update' | 'activate' | 'deactivate' | 'listCredentials';
  id?: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

export interface FakeClientOptions {
  /** Credentials on the fake instance, or 'forbidden' to simulate a key without credential:list. */
  credentials?: ApiCredential[] | 'forbidden';
}

/**
 * Fields the real single-workflow GET returns but the list endpoint leaves out
 * (checked against n8n 2.46). Mimicking this keeps tests honest about which
 * endpoint a hash came from.
 */
const SINGLE_GET_ONLY_FIELDS = ['description', 'sourceWorkflowId', 'versionCounter'] as const;

/**
 * An in-memory stand-in for the n8n API. Mutate `workflows` to simulate instance
 * edits; `calls` records every request in order. Like n8n: the list endpoint
 * omits pin data and the single-GET-only fields, the single GET adds them, and
 * updates only change the fields that were sent (pinData/staticData are kept).
 */
export function fakeClient(workflows: ApiWorkflow[], options: FakeClientOptions = {}) {
  const calls: FakeCall[] = [];
  let version = 0;
  const find = (id: string) => {
    const workflow = client.workflows.find((w) => w.id === id);
    if (workflow === undefined) throw new Error(`no workflow ${id}`);
    return workflow;
  };
  const client = {
    workflows,
    calls,
    credentials: options.credentials ?? [],
    listWorkflows({ tag }: { tag?: string } = {}): Promise<ApiWorkflow[]> {
      calls.push({ method: 'list', query: tag === undefined ? {} : { tag } });
      const omitted = new Set<string>([...SINGLE_GET_ONLY_FIELDS, 'pinData']);
      const all = structuredClone(client.workflows).map(
        (workflow) =>
          Object.fromEntries(
            Object.entries(workflow).filter(([key]) => !omitted.has(key)),
          ) as ApiWorkflow,
      );
      return Promise.resolve(
        tag === undefined ? all : all.filter((w) => w.tags?.some((t) => t.name === tag)),
      );
    },
    getWorkflow(id: string, opts: { includePinData?: boolean } = {}): Promise<ApiWorkflow> {
      calls.push({ method: 'get', id, query: { includePinData: opts.includePinData ?? false } });
      return Promise.resolve().then(() => {
        const workflow: Record<string, unknown> = {
          description: '',
          sourceWorkflowId: null,
          versionCounter: version + 1,
          ...structuredClone(find(id)),
        };
        if (opts.includePinData !== true) delete workflow.pinData;
        return workflow as ApiWorkflow;
      });
    },
    updateWorkflow(id: string, body: WorkflowUpdateBody): Promise<void> {
      calls.push({ method: 'update', id, body: structuredClone(body) });
      const workflow = find(id);
      const structural = ['nodes', 'connections', 'nodeGroups'].some(
        (key) => key in body && JSON.stringify(body[key]) !== JSON.stringify(workflow[key]),
      );
      Object.assign(workflow, structuredClone(body), {
        settings: { ...workflow.settings, ...body.settings },
        updatedAt: `2027-01-01T00:00:${String(++version).padStart(2, '0')}.000Z`,
        ...(structural ? { versionId: `fake-version-${String(version)}` } : {}),
      });
      return Promise.resolve();
    },
    activateWorkflow(id: string): Promise<void> {
      calls.push({ method: 'activate', id });
      find(id).active = true;
      return Promise.resolve();
    },
    deactivateWorkflow(id: string): Promise<void> {
      calls.push({ method: 'deactivate', id });
      find(id).active = false;
      return Promise.resolve();
    },
    listCredentials(): Promise<ApiCredential[]> {
      calls.push({ method: 'listCredentials' });
      if (client.credentials === 'forbidden') {
        return Promise.reject(
          new ForbiddenError('The API key does not have permission to list credentials (403).'),
        );
      }
      return Promise.resolve(structuredClone(client.credentials));
    },
  } satisfies N8nClient & Record<string, unknown>;
  return client;
}

/** A normalized fixture, freshly cloned so tests can modify it. */
export function normalizedFixture(name: string): NormalizedWorkflow {
  return normalizeWorkflow(loadFixture(name));
}

/** Finds a node by name, failing the test if it does not exist. */
export function nodeNamed(
  workflow: NormalizedWorkflow,
  name: string,
): NormalizedWorkflow['nodes'][number] {
  const node = workflow.nodes.find((n) => n.name === name);
  if (node === undefined) throw new Error(`no node named ${name}`);
  return node;
}

/** `items[index]`, failing the test instead of returning undefined. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}
