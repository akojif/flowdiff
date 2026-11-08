import { Command } from 'commander';
import pc from 'picocolors';
import packageJson from '../package.json' with { type: 'json' };
import { runInit } from './commands/init.js';
import { runPull } from './commands/pull.js';
import { FlowdiffError } from './errors.js';

const program = new Command()
  .name('flowdiff')
  .description(packageJson.description)
  .version(packageJson.version);

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

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof FlowdiffError) {
    console.error(pc.red(`Error: ${error.message}`));
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
