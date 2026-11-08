/**
 * Workflow settings where a missing value behaves exactly like a specific value.
 * The n8n editor writes some of these on save, which would otherwise show up as
 * a change without any change in behaviour.
 *
 * Only add a setting here after confirming n8n's runtime behaviour. Not every
 * setting qualifies: a missing `executionOrder` means the legacy "v0", not "v1".
 */
const EQUIVALENT_WHEN_MISSING: Record<string, unknown> = {
  // n8n only checks `binaryMode === 'combined'`; anything else, including a
  // missing value, behaves as 'separate'.
  binaryMode: 'separate',
};

/** Fills in settings whose missing value is equivalent to a known value, for comparison only. */
export function settingsForComparison(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...EQUIVALENT_WHEN_MISSING, ...settings };
}
