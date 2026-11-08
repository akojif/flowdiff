import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import packageJson from '../package.json' with { type: 'json' };
import { runDiff, type DiffFlags } from './commands/diff.js';
import { runInit } from './commands/init.js';
import { runPull } from './commands/pull.js';
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
  .option('--tag <name>', 'only pull workflows with this tag')
  .option('--force', 'overwrite local edits even if the workflow changed on the instance')
  .action(async (flags: { tag?: string; force?: boolean }) => {
    await runPull(process.cwd(), flags);
  });

program
  .command('diff [target] [workflow]')
  .description(
    'show changes between the instance and local files (instance → local), or between two git refs',
  )
  .option('--json', 'machine-readable output (never truncated)')
  .option('--include-layout', 'also show node position changes')
  .option('--full', 'show long values in full instead of truncating them')
  .option('--exit-code', 'exit with 1 if there are changes (for CI)')
  .addHelpText(
    'after',
    `
Examples:
  flowdiff diff                       all workflows, instance → local
  flowdiff diff "Order Sync"          one workflow, by name, id or file name
  flowdiff diff main..feature         workflow files between two git refs
  flowdiff diff main..feature --json --exit-code`,
  )
  .action(async (target: string | undefined, workflow: string | undefined, flags: DiffFlags) => {
    await runDiff(process.cwd(), target, workflow, flags);
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
