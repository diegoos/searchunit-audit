import type { CliFlags } from './lib/args.ts';
import { CANONICAL_COMMANDS, type CanonicalCommand } from './lib/args.ts';
import { formatConfigHelp, formatHelp, VERSION } from './lib/help.ts';
import { CliError } from './lib/errors.ts';
import { runAudit } from './commands/audit.ts';
import { runConfig } from './commands/config.ts';
import { runSchemaCheck } from './commands/schema-check.ts';
import { runRobotsCheck } from './commands/robots-check.ts';
import { runMetaCheck } from './commands/meta-check.ts';
import { runLlmsTxtCheck } from './commands/llms-txt-check.ts';
import { runSecurityHeaders } from './commands/security-headers.ts';
import { runGeoCheck } from './commands/geo-check.ts';
import { runSeoCheck } from './commands/seo-check.ts';
import { runGoogleProfile } from './commands/google-profile.ts';

type CommandHandler = (target: string | undefined, flags: CliFlags) => Promise<number>;

const HANDLERS: Record<CanonicalCommand, CommandHandler> = {
  audit: runAudit,
  config: runConfig,
  'schema-check': runSchemaCheck,
  'robots-check': runRobotsCheck,
  'meta-check': runMetaCheck,
  'llms-txt-check': runLlmsTxtCheck,
  'security-headers': runSecurityHeaders,
  'geo-check': runGeoCheck,
  'seo-check': runSeoCheck,
  'google-profile': runGoogleProfile,
};

/**
 * Dispatches a parsed command to its handler.
 */
export async function dispatch(
  command: string | undefined,
  target: string | undefined,
  flags: CliFlags,
): Promise<number> {
  if (flags.version) {
    console.log(VERSION);

    return 0;
  }

  if (flags.help || !command) {
    console.log(command === 'config' ? formatConfigHelp() : formatHelp());

    return 0;
  }

  const handler = HANDLERS[command as CanonicalCommand];

  if (!handler) {
    throw new CliError(
      `Unknown command "${command}". Expected one of: ${CANONICAL_COMMANDS.join(', ')}`,
    );
  }

  return handler(target, flags);
}
