/**
 * CLI entrypoint (composition root for manual/PoC runs). The `poc` subcommand
 * (T0.7) reviews a single MR end-to-end; see `./poc.ts`.
 */
import { applyEnvFileIfPresent } from '../../config/index.ts';
import { mainPoc, usage as pocUsage } from './poc.ts';

async function main(argv: string[]): Promise<void> {
  const envFile = process.env['MIRA_ENV_FILE'];
  applyEnvFileIfPresent(envFile === undefined ? '.env' : envFile.trim());
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case 'help':
      printUsage();
      return;
    case 'poc':
      await mainPoc(rest);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

function printUsage(): void {
  console.log(
    [
      'mira — code review CLI',
      '',
      'Commands:',
      '  mira help                              Show this help',
      '  mira poc --project <id> --mr <iid>     Review one MR (Phase-0 PoC)',
      '',
      pocUsage(),
    ].join('\n'),
  );
}

void main(process.argv.slice(2));
