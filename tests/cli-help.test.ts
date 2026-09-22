import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { formatConfigHelp, formatHelp, VERSION } from '../src/lib/help.ts';
import { dispatch } from '../src/cli.ts';
import { CANONICAL_COMMANDS, parseCli } from '../src/lib/args.ts';

describe('CLI help and version', () => {
  test('help lists every canonical command and public flag', () => {
    const help = formatHelp();

    for (const command of CANONICAL_COMMANDS) {
      expect(help).toContain(command);
    }

    expect(help).toContain('-f, --format');
    expect(help).toContain('table|json|html|markdown');
    expect(help).toContain('-o, --output');
    expect(help).toContain('<file>');
    expect(help).toContain('--fail-on');
    expect(help).toContain('--max-bytes');
    expect(help).toContain('-g, --global');
    expect(help).toContain('--silent');
    expect(help).toContain('--agent');
    expect(help).toContain('Wrote');
  });
  test('formatHelp keeps the usage body', () => {
    expect(formatHelp()).toContain('Usage');
    expect(formatHelp()).toContain('SearchUnit CLI');
    expect(formatHelp()).toContain('Commands');
    expect(formatHelp()).toContain('Options');
    expect(formatHelp()).not.toContain('╔');
  });
  test('commands and options use different colors', () => {
    const previous = chalk.level;

    chalk.level = 1;

    try {
      const help = formatHelp();
      const commandOpen = chalk.cyan('x').slice(0, chalk.cyan('x').indexOf('x'));
      const optionOpen = chalk.magenta('x').slice(0, chalk.magenta('x').indexOf('x'));

      expect(help).toContain(`${commandOpen}audit`);
      expect(help).toContain(`${optionOpen}--agent`);
      expect(commandOpen).not.toBe(optionOpen);
    } finally {
      chalk.level = previous;
    }
  });
  test('formatConfigHelp lists operations, keys, and config options', () => {
    const help = formatConfigHelp();

    expect(help).toContain('searchunit config');
    expect(help).toContain('Operations');
    expect(help).toContain('list -g');
    expect(help).toContain('<key> <value>');
    expect(help).toContain('--unset <key>');
    expect(help).toContain('crux_api_key');
    expect(help).toContain('max_body_bytes');
    expect(help).toContain('merge');
    expect(help).toContain('-g, --global');
    expect(help).not.toContain('schema-check');
    expect(help).not.toContain('╔');
  });
  test('dispatch config --help prints config help and exits 0', async () => {
    const logs: string[] = [];
    const original = console.log;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    try {
      const parsed = parseCli(['config', '--help']);
      const code = await dispatch(parsed.command, parsed.target, parsed.flags);
      const text = logs.join('\n');

      expect(code).toBe(0);
      expect(text).toContain('Operations');
      expect(text).toContain('--unset');
      expect(text).not.toContain('schema-check');
    } finally {
      console.log = original;
    }
  });
  test('dispatch --help prints usage and exits 0', async () => {
    const logs: string[] = [];
    const original = console.log;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    try {
      const parsed = parseCli(['--help']);
      const code = await dispatch(parsed.command, parsed.target, parsed.flags);

      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('Usage');
    } finally {
      console.log = original;
    }
  });
  test('dispatch --version prints VERSION and exits 0', async () => {
    const logs: string[] = [];
    const original = console.log;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    try {
      const parsed = parseCli(['--version']);
      const code = await dispatch(parsed.command, parsed.target, parsed.flags);

      expect(code).toBe(0);
      expect(logs.join('\n')).toBe(VERSION);
    } finally {
      console.log = original;
    }
  });
  test('unknown command throws', async () => {
    const parsed = parseCli(['not-a-command']);

    await expect(dispatch(parsed.command, parsed.target, parsed.flags)).rejects.toThrow(
      'Unknown command',
    );
  });
  test('every fetch command is wired and requires a URL', async () => {
    const fetchCommands = CANONICAL_COMMANDS.filter(
      (command) => command !== 'config' && command !== 'google-profile',
    );

    for (const command of fetchCommands) {
      const parsed = parseCli([command]);

      await expect(dispatch(parsed.command, parsed.target, parsed.flags)).rejects.toThrow(
        'A URL is required',
      );
    }
  });
  test('google-profile is wired and requires a domain', async () => {
    const parsed = parseCli(['google-profile']);

    await expect(dispatch(parsed.command, parsed.target, parsed.flags)).rejects.toThrow(
      'A domain is required',
    );
  });
});
