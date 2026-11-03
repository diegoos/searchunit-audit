import { describe, expect, test } from 'bun:test';
import { formatConfigHelp, formatHelp, VERSION } from '../src/lib/help.ts';
import { dispatch } from '../src/cli.ts';
import { CANONICAL_COMMANDS, parseCli } from '../src/lib/args.ts';

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const original = console.log;

  console.log = (msg?: unknown) => {
    logs.push(String(msg ?? ''));
  };
  try {
    const parsed = parseCli(argv);
    const code = await dispatch(parsed.command, parsed.target, parsed.flags);

    return { code, out: logs.join('\n') };
  } finally {
    console.log = original;
  }
}

describe('CLI help', () => {
  test('formatHelp lists every canonical command and public option', () => {
    const help = formatHelp();

    for (const command of CANONICAL_COMMANDS) {
      expect(help).toContain(command);
    }

    for (const option of [
      '-f, --format',
      'table|json|html|markdown',
      '-o, --output',
      '<file>',
      '--fail-on',
      '--max-bytes',
      '-g, --global',
      '--silent',
      '--agent',
    ]) {
      expect(help).toContain(option);
    }
  });
  test('formatConfigHelp lists the operations, the keys, and -g', () => {
    const help = formatConfigHelp();

    for (const text of [
      'list -g',
      'set <key> <value>',
      'remove <key>',
      'crux_api_key',
      'max_body_bytes',
      '-g, --global',
    ]) {
      expect(help).toContain(text);
    }

    expect(help).not.toContain('--unset');
  });
  test('--help and config --help print help and exit 0', async () => {
    const usage = await run(['--help']);
    const config = await run(['config', '--help']);

    expect(usage.code).toBe(0);
    expect(usage.out).toContain('Usage');
    expect(config.code).toBe(0);
    expect(config.out).toContain('set <key> <value>');
  });
  test('--version prints VERSION and exits 0', async () => {
    expect(await run(['--version'])).toEqual({ code: 0, out: VERSION });
  });
  test('an unknown command throws', async () => {
    await expect(run(['not-a-command'])).rejects.toThrow('Unknown command');
  });
  test('every URL command is wired and requires a URL', async () => {
    const urlCommands = CANONICAL_COMMANDS.filter(
      (command) => command !== 'config' && command !== 'google-profile',
    );

    for (const command of urlCommands) {
      await expect(run([command])).rejects.toThrow('A URL is required');
    }
  });
  test('google-profile is wired and requires a domain', async () => {
    await expect(run(['google-profile'])).rejects.toThrow('A domain is required');
  });
});
