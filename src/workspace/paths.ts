import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

const MAX_SLUG_LENGTH = 60;

// <slug>.<id>.json — slugs never contain dots, so the id is always the second part.
const WORKFLOW_FILE_PATTERN = /^[a-z0-9-]+\.([A-Za-z0-9_-]+)\.json$/;

/** Turns a workflow name into a lowercase, ASCII, dash-separated file name part. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop accents left over from NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? 'workflow' : slug;
}

export function workflowFileName(workflow: { id: string; name: string }): string {
  return `${slugify(workflow.name)}.${workflow.id}.json`;
}

export function workflowIdFromFileName(fileName: string): string | undefined {
  return WORKFLOW_FILE_PATTERN.exec(fileName)?.[1];
}

/**
 * Maps workflow id to the file names in `dir` that belong to it. Normally one
 * file per id; more than one means a stale file was left behind.
 */
export async function indexWorkflowFiles(dir: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  if (!existsSync(dir)) return index;

  for (const fileName of (await readdir(dir)).sort()) {
    const id = workflowIdFromFileName(fileName);
    if (id === undefined) continue;
    index.set(id, [...(index.get(id) ?? []), fileName]);
  }
  return index;
}
