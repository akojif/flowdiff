import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { connectionsSchema, nodeSchema } from '../api/schemas.js';
import { FlowdiffError } from '../errors.js';
import type { NormalizedWorkflow } from '../normalize/normalize.js';
import { indexWorkflowFiles } from './paths.js';

/** Schema for workflow files on disk. Loose, like the API schemas, so unknown fields survive. */
const workflowFileSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  nodes: z.array(nodeSchema),
  connections: connectionsSchema,
  settings: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()),
});

export interface WorkflowFile {
  /** Path relative to the project, for messages. */
  file: string;
  /** Raw file content, for comparing with the hash recorded at the last pull. */
  content: string;
  workflow: NormalizedWorkflow;
}

/** Parses and validates a workflow file. `label` names the file in error messages. */
export function parseWorkflowFile(content: string, label: string): NormalizedWorkflow {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new FlowdiffError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
  const result = workflowFileSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? '' : `: ${issue.path.join('.') || '(root)'}: ${issue.message}`;
    throw new FlowdiffError(`${label} is not a valid workflow file${where}`);
  }
  return result.data;
}

/** Reads every workflow file in `dir`, keyed by workflow id. */
export async function readLocalWorkflows(
  cwd: string,
  workflowsDir: string,
): Promise<Map<string, WorkflowFile>> {
  const index = await indexWorkflowFiles(join(cwd, workflowsDir));
  const result = new Map<string, WorkflowFile>();
  for (const [id, [fileName]] of index) {
    if (fileName === undefined) continue;
    const file = join(workflowsDir, fileName);
    const content = await readFile(join(cwd, file), 'utf8');
    const workflow = parseWorkflowFile(content, file);
    if (workflow.id !== id) {
      throw new FlowdiffError(
        `${file} contains workflow id "${workflow.id}", but its file name says "${id}".`,
      );
    }
    result.set(id, { file, content, workflow });
  }
  return result;
}
