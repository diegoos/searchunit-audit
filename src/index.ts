import { parseCli, type ParsedCli } from './lib/args.ts';
import { dispatch } from './cli.ts';
import { applyConfig, loadConfig } from './lib/config.ts';
import { CliError } from './lib/errors.ts';
import { setActiveMaxBodyBytes } from './lib/fetch.ts';
import { printError } from './lib/output.ts';

/**

 * SearchUnit CLI entry. Parses argv, runs the selected command, and maps

 * errors to process exit codes (0 ok, 1 analysis threshold, 2 runtime).

 */

async function main(): Promise<void> {
  try {
    const parsed = parseInvocation(process.argv.slice(2));

    setActiveMaxBodyBytes(parsed.flags.maxBytes);
    process.exitCode = await dispatch(parsed.command, parsed.target, parsed.flags);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = err instanceof CliError ? err.exitCode : 2;
  }
}

/**
 * Parses argv, then re-parses with YAML defaults. `config` / help / version skip
 * the file so a broken YAML cannot block `searchunit config`.
 */

function parseInvocation(argv: string[]): ParsedCli {
  const parsed = parseCli(argv);

  if (parsed.command === 'config' || parsed.flags.help || parsed.flags.version) {
    return parsed;
  }

  const config = loadConfig();

  applyConfig(config);

  return parseCli(argv, {
    outFormat: config.output,
    maxBytes: config.maxBodyBytes,
  });
}

await main();
