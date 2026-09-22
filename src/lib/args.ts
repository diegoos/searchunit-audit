import chalk, { chalkStderr } from 'chalk';
import { DEFAULT_MAX_BODY_BYTES, parseMaxBodyBytes } from './maxBodyBytes.ts';

/** Shared CLI flags parsed from argv after the subcommand. */
export interface CliFlags {
  json: boolean;
  help: boolean;
  version: boolean;
  silent: boolean;
  global: boolean;
  unset: boolean;
  /** Stdout is plain markdown of the command payload. */
  agent: boolean;
  outFormat: OutputFormat;
  /** Path from `-o` / `--output`. Extension `.json` or `.md` picks the file body. */
  outputPath: string | undefined;
  failOn: 'fail' | 'warn' | undefined;
  /** Response body cap in bytes. Default 2 MiB. */
  maxBytes: number;
  rest: string[];
}

export type OutputFormat = 'table' | 'json' | 'html' | 'markdown';

export type FileOutputFormat = 'json' | 'markdown';

/** Defaults from `.searchunit.yaml` when the matching flag is omitted. */
export interface ParseCliDefaults {
  outFormat?: OutputFormat;
  maxBytes?: number;
}

export interface ParsedCli {
  command: string | undefined;
  target: string | undefined;
  flags: CliFlags;
}

const COMMAND_ALIASES: Record<string, string> = {
  'schema-markup-check': 'schema-check',
  'robots-txt-validator': 'robots-check',
  'meta-tags-test': 'meta-check',
  'llms-txt-validator': 'llms-txt-check',
  'security-headers-scan': 'security-headers',
  'ai-visibility': 'geo-check',
  'ai-visibility-check': 'geo-check',
  'google-profile-finder': 'google-profile',
};

export const REPORT_COMMANDS = ['audit', 'geo-check', 'seo-check'] as const;

export const CANONICAL_COMMANDS = [
  'audit',
  'config',
  'schema-check',
  'robots-check',
  'meta-check',
  'llms-txt-check',
  'security-headers',
  'geo-check',
  'seo-check',
  'google-profile',
] as const;

export type CanonicalCommand = (typeof CANONICAL_COMMANDS)[number];

/**
 * Maps a user-facing subcommand (including public aliases) to the canonical
 * command name.
 */
export function resolveCommand(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  return COMMAND_ALIASES[raw] ?? raw;
}

function takeValue(argv: string[], i: number, flag: string): { value: string; next: number } {
  const current = argv[i];

  if (current?.startsWith(`${flag}=`)) {
    return { value: current.slice(flag.length + 1), next: i };
  }

  const next = argv[i + 1];

  if (!next || next.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`);
  }

  return { value: next, next: i + 1 };
}

/** Consumes `--flag value` or `--flag=value` when `argv[i]` matches. */

function takeNamed(
  argv: string[],
  i: number,
  flag: string,
): { value: string; next: number } | undefined {
  const arg = argv[i];

  if (arg === flag || arg?.startsWith(`${flag}=`)) {
    return takeValue(argv, i, flag);
  }

  return undefined;
}

/** File body for `-o` / `--output`. The path extension decides it. */
export function fileOutputFormat(path: string): FileOutputFormat {
  const lower = path.toLowerCase();

  if (lower.endsWith('.json')) {
    return 'json';
  }

  if (lower.endsWith('.md')) {
    return 'markdown';
  }

  throw new Error('-o/--output must be a .json or .md file');
}

/**
 * Parses `--format=json|html|markdown|table`. `fallback` is the config/default when
 * the flag is omitted (`--json` still wins).
 */
export function parseOutFormat(
  raw: string | undefined,
  jsonFlag: boolean,
  fallback: OutputFormat = 'table',
): OutputFormat {
  if (!raw) {
    return jsonFlag ? 'json' : fallback;
  }

  const value = raw.toLowerCase();

  if (value === 'json' || value === 'html' || value === 'markdown' || value === 'table') {
    return value;
  }

  throw new Error('--format must be json, html, markdown, or table');
}

/**
 * Splits `bun src/index.ts <command> [target] [flags…]` into a structured
 * command, optional URL/domain, and flags.
 */

// Flag parsers are a linear switch of options; splitting hides the argv contract.
// eslint-disable-next-line complexity
export function parseCli(argv: string[], defaults?: ParseCliDefaults): ParsedCli {
  const flags: CliFlags = {
    json: false,
    help: false,
    version: false,
    silent: false,
    global: false,
    unset: false,
    agent: false,
    outFormat: 'table',
    outputPath: undefined,
    failOn: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    rest: [],
  };
  let command: string | undefined;
  let target: string | undefined;
  let formatRaw: string | undefined;
  let maxBytesRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }

    if (arg === '-V' || arg === '--version') {
      flags.version = true;
      continue;
    }

    if (arg === '--json') {
      flags.json = true;
      continue;
    }

    if (arg === '--silent') {
      flags.silent = true;
      continue;
    }

    if (arg === '--agent') {
      flags.agent = true;
      continue;
    }

    if (arg === '-g' || arg === '--global') {
      flags.global = true;
      continue;
    }

    if (arg === '--unset') {
      flags.unset = true;
      continue;
    }

    if (arg === '--color' || arg === '--no-color' || arg.startsWith('--color=')) {
      applyColorFlag(arg);
      continue;
    }

    const outputPath = takeNamed(argv, i, '--output') ?? takeNamed(argv, i, '-o');

    if (outputPath) {
      flags.outputPath = outputPath.value.trim();
      i = outputPath.next;
      continue;
    }

    const format = takeNamed(argv, i, '--format') ?? takeNamed(argv, i, '-f');

    if (format) {
      formatRaw = format.value;
      i = format.next;
      continue;
    }

    const failOn = takeNamed(argv, i, '--fail-on');

    if (failOn) {
      if (failOn.value !== 'fail' && failOn.value !== 'warn') {
        throw new Error('--fail-on must be "fail" or "warn"');
      }

      flags.failOn = failOn.value;
      i = failOn.next;
      continue;
    }

    const maxBytes = takeNamed(argv, i, '--max-bytes');

    if (maxBytes) {
      maxBytesRaw = maxBytes.value;
      i = maxBytes.next;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!command) {
      command = resolveCommand(arg);
      continue;
    }

    if (!target) {
      target = arg;
      continue;
    }

    flags.rest.push(arg);
  }

  applyStdoutFormat(command, flags, formatRaw, defaults);
  applyOutputPath(command, flags);
  flags.maxBytes = maxBytesRaw
    ? parseMaxBodyBytes(maxBytesRaw)
    : (defaults?.maxBytes ?? flags.maxBytes);

  return { command, target, flags };
}

/** Applies `--format` / `-f` / `--json`, then drops html and markdown outside report commands. */
function applyStdoutFormat(
  command: string | undefined,
  flags: CliFlags,
  formatRaw: string | undefined,
  defaults: ParseCliDefaults | undefined,
): void {
  flags.outFormat = parseOutFormat(
    formatRaw,
    flags.json,
    command === 'config' ? 'table' : defaults?.outFormat,
  );
  flags.json = flags.outFormat === 'json';

  const rich = flags.outFormat === 'html' || flags.outFormat === 'markdown';

  if (!command || !rich || isReportCommand(command)) {
    return;
  }

  if (formatRaw) {
    throw new Error(
      '--format html and markdown are for audit, geo-check, and seo-check; use --format=json or --json',
    );
  }

  flags.outFormat = 'table';
  flags.json = false;
}

function isReportCommand(command: string): boolean {
  return (REPORT_COMMANDS as readonly string[]).includes(command);
}

/** Rejects `-o` on `config` and requires a `.json` or `.md` path. */
function applyOutputPath(command: string | undefined, flags: CliFlags): void {
  if (flags.outputPath === undefined) {
    return;
  }

  if (command === 'config') {
    throw new Error('-o/--output is not valid with config');
  }

  if (!flags.outputPath) {
    throw new Error('Missing value for -o/--output');
  }

  fileOutputFormat(flags.outputPath);
}

/** Forces chalk on stdout and stderr (`--color=never` matches `--no-color`). */
function applyColorFlag(arg: string): void {
  const off = arg === '--no-color' || arg === '--color=never' || arg === '--color=0';

  chalk.level = off ? 0 : 3;
  chalkStderr.level = off ? 0 : 3;
}
