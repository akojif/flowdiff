import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import packageJson from '../package.json' with { type: 'json' };
import { runDiff, type DiffFlags } from './commands/diff.js';
import { runAction } from './action/run.js';
import { runInit } from './commands/init.js';
import { runPull } from './commands/pull.js';
import { runPush, type PushFlags } from './commands/push.js';
import { runStatus, type StatusFlags } from './commands/status.js';
import { FlowdiffError } from './errors.js';

const program = new Command()
  .name('flowdiff')
  .description(packageJson.description)
  .version(packageJson.version)
  // Throw instead of exiting, so usage errors get exit code 2 like every other error.
  .exitOverride();

program
  .command('init')
  .description(`create flowdiff.config.json`)
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command('pull')
  .description('download workflows as normalized JSON, one file per workflow')
  .option('--tag <name>', 'only pull workflows with this tag (overrides the saved tag)')
  .option('--no-tag', 'ignore the tag saved in flowdiff.config.json for this run')
  .option('--force', 'overwrite local edits even if the workflow changed on the instance')
  .action(async (flags: { tag?: string | false; force?: boolean }) => {
    await runPull(process.cwd(), flags);
  });

program
  .command('status')
  .description('show which workflows changed locally, on the instance, or both')
  .option('--tag <name>', 'only consider workflows with this tag (overrides the saved tag)')
  .option('--no-tag', 'ignore the tag saved in flowdiff.config.json for this run')
  .option('--all', 'list untracked instance workflows individually')
  .option('--json', 'machine-readable output')
  .action(async (flags: StatusFlags) => {
    await runStatus(process.cwd(), flags);
  });

program
  .command('diff [target] [workflow]')
  .description(
    'show changes between the instance and local files (instance → local), or between two git refs',
  )
  .option('--tag <name>', 'only compare workflows with this tag (overrides the saved tag)')
  .option('--no-tag', 'ignore the tag saved in flowdiff.config.json for this run')
  .option('--all', 'list untracked instance workflows individually')
  .option('--stat', 'one summary line per workflow (default when more than 5 changed)')
  .option('--no-stat', 'always show every change')
  .option('--format <format>', 'output format: text, json or markdown', 'text')
  .option('--json', 'shorthand for --format json (never truncated)')
  .option('--show-secrets', 'show values that look like secrets instead of redacting them')
  .option('--include-layout', 'also show node position changes')
  .option('--quiet', 'leave out the explanatory hints under the summary')
  .option('--full', 'show long values in full instead of truncating them')
  .option(
    '--exit-code [mode]',
    'exit with 1 on changes (default) or only on behavior changes ("behavior"), for CI',
  )
  .addHelpText(
    'after',
    `
Examples:
  flowdiff diff                       all workflows, instance → local
  flowdiff diff "Order Sync"          one workflow, by name, id or file name
  flowdiff diff main..feature         workflow files between two git refs
  flowdiff diff main..feature --json --exit-code
  flowdiff diff main..feature --format markdown --exit-code behavior`,
  )
  .action(async (target: string | undefined, workflow: string | undefined, flags: DiffFlags) => {
    await runDiff(process.cwd(), target, workflow, flags);
  });

program
  .command('push [workflow]')
  .description('upload local changes to the instance (shows the diff and asks first)')
  .option('--dry-run', 'show what would be pushed and change nothing')
  .option('--force', 'overwrite even if the workflow changed on the instance since the last pull')
  .option('--apply-active', 'also switch workflows on/off to match the local files')
  .option('--show-secrets', 'show values that look like secrets instead of redacting them')
  .option('--tag <name>', 'only consider workflows with this tag (overrides the saved tag)')
  .option('--no-tag', 'ignore the tag saved in flowdiff.config.json for this run')
  .action(async (workflow: string | undefined, flags: PushFlags) => {
    await runPush(process.cwd(), workflow, flags);
  });

// Used by the GitHub Action (action.yml); reads its inputs from the environment.
program
  .command('github-action', { hidden: true })
  .description('run as the flowdiff GitHub Action')
  .action(async () => {
    process.exitCode = await runAction({
      env: process.env,
      log: (line) => {
        console.log(line);
      },
    });
  });

// Exit codes: 0 = success / no changes, 1 = changes or conflicts found, 2 = error.
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander has already printed the message. --help and --version exit with 0.
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else if (error instanceof FlowdiffError) {
    console.error(pc.red(`Error: ${error.message}`));
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 2;
  }
}
