import type { createColors } from 'picocolors';

type Colors = ReturnType<typeof createColors>;

/**
 * Workflows on the instance that are not tracked locally: one dim line by
 * default, listed individually with `showAll`. They are never shown as removals,
 * because push never deletes.
 */
export function untrackedLines(
  untracked: { id: string; name: string }[],
  c: Colors,
  showAll: boolean,
): string[] {
  if (untracked.length === 0) return [];
  const count = untracked.length;
  const noun = count === 1 ? 'workflow' : 'workflows';
  const verb = count === 1 ? "isn't" : "aren't";
  const headline = `${String(count)} ${noun} on the instance ${verb} tracked locally (run flowdiff pull to add them)`;
  if (!showAll) return [c.dim(headline)];
  return [c.dim(`${headline}:`), ...untracked.map((w) => c.dim(`  ? ${w.name} (${w.id})`))];
}
