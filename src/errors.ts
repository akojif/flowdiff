/**
 * An error whose message is written for the person running the CLI.
 * The CLI prints these without a stack trace; anything else is a bug.
 */
export class FlowdiffError extends Error {
  override name = 'FlowdiffError';
}
