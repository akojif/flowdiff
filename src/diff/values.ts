import { isDeepStrictEqual } from 'node:util';
import { diffText, isMultiLine } from './text.js';
import type { PathSegment, ValueChange } from './types.js';

export interface ValueDiff {
  path: PathSegment[];
  change: ValueChange;
}

/**
 * Recursively compares two JSON values and returns one entry per changed path.
 * `undefined` on either side means the value is absent there.
 */
export function diffValues(before: unknown, after: unknown, path: PathSegment[] = []): ValueDiff[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (before === undefined) return [{ path, change: { type: 'added', value: after } }];
  if (after === undefined) return [{ path, change: { type: 'removed', value: before } }];

  if (
    typeof before === 'string' &&
    typeof after === 'string' &&
    (isMultiLine(before) || isMultiLine(after))
  ) {
    return [{ path, change: diffText(before, after) }];
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diffValues(before[key], after[key], [...path, { key }]));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return canMatchById(before) && canMatchById(after)
      ? diffArraysById(before, after, path)
      : diffArraysByIndex(before, after, path);
  }
  return [{ path, change: { type: 'modified', from: before, to: after } }];
}

function diffArraysByIndex(before: unknown[], after: unknown[], path: PathSegment[]): ValueDiff[] {
  const length = Math.max(before.length, after.length);
  return Array.from({ length }, (_, index) =>
    diffValues(before[index], after[index], [...path, { index }]),
  ).flat();
}

type WithId = Record<string, unknown> & { id: string };

/**
 * n8n stores many lists (Set assignments, IF conditions, ...) as arrays of
 * objects with a unique `id`. Matching those by id means removing the first
 * element does not make every later element look changed.
 */
function diffArraysById(before: WithId[], after: WithId[], path: PathSegment[]): ValueDiff[] {
  const beforeById = new Map(before.map((element) => [element.id, element]));
  const afterById = new Map(after.map((element) => [element.id, element]));
  const labels = elementLabels([...before, ...after]);
  const segment = (id: string): PathSegment => ({ id, label: labels.get(id) ?? `#${id}` });

  const diffs: ValueDiff[] = [];
  for (const element of after) {
    const previous = beforeById.get(element.id);
    diffs.push(...diffValues(previous, element, [...path, segment(element.id)]));
  }
  for (const element of before) {
    if (!afterById.has(element.id)) {
      diffs.push({
        path: [...path, segment(element.id)],
        change: { type: 'removed', value: element },
      });
    }
  }

  // Elements present on both sides but in a different order.
  const commonBefore = before.filter((e) => afterById.has(e.id)).map((e) => e.id);
  const commonAfter = after.filter((e) => beforeById.has(e.id)).map((e) => e.id);
  if (!isDeepStrictEqual(commonBefore, commonAfter)) {
    const label = (id: string) => labels.get(id) ?? `#${id}`;
    diffs.push({
      path,
      change: { type: 'reordered', from: commonBefore.map(label), to: commonAfter.map(label) },
    });
  }
  return diffs;
}

/** Arrays can be matched by id only if every element has a string id, unique within the array. */
function canMatchById(array: unknown[]): array is WithId[] {
  if (array.length === 0) return true;
  const ids = array.map((element) =>
    isPlainObject(element) && typeof element.id === 'string' ? element.id : undefined,
  );
  return ids.every((id) => id !== undefined) && new Set(ids).size === ids.length;
}

/**
 * Picks a readable label per element id: its `name` if no other element uses
 * the same name, otherwise `#<id>`.
 */
function elementLabels(elements: WithId[]): Map<string, string> {
  const namesById = new Map<string, string>();
  for (const element of elements) {
    if (typeof element.name === 'string') namesById.set(element.id, element.name);
  }
  const idsByName = new Map<string, Set<string>>();
  for (const [id, name] of namesById) {
    idsByName.set(name, (idsByName.get(name) ?? new Set()).add(id));
  }

  const labels = new Map<string, string>();
  for (const element of elements) {
    const name = namesById.get(element.id);
    const unique = name !== undefined && idsByName.get(name)?.size === 1;
    labels.set(element.id, unique ? name : `#${element.id}`);
  }
  return labels;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
