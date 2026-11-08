import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { N8nClient } from '../src/api/client.js';
import { workflowSchema, type ApiWorkflow } from '../src/api/schemas.js';
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

/** An in-memory stand-in for the n8n API. Mutate `workflows` to simulate instance edits. */
export function fakeClient(workflows: ApiWorkflow[]): N8nClient & { workflows: ApiWorkflow[] } {
  return {
    workflows,
    listWorkflows({ tag } = {}) {
      const all = structuredClone(this.workflows);
      return Promise.resolve(
        tag === undefined ? all : all.filter((w) => w.tags?.some((t) => t.name === tag)),
      );
    },
    getWorkflow(id) {
      const workflow = this.workflows.find((w) => w.id === id);
      return workflow === undefined
        ? Promise.reject(new Error(`no workflow ${id}`))
        : Promise.resolve(structuredClone(workflow));
    },
  };
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
