import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { N8nClient } from '../src/api/client.js';
import { workflowSchema, type ApiWorkflow } from '../src/api/schemas.js';

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
