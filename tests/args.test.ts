import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { fileOutputFormat, parseCli, parseOutFormat, resolveCommand } from '../src/lib/args.ts';

describe('resolveCommand', () => {
  test('returns undefined when the token is missing', () => {
    expect(resolveCommand(undefined)).toBeUndefined();
  });
  test('maps public aliases to canonical names', () => {
    expect(resolveCommand('schema-markup-check')).toBe('schema-check');
    expect(resolveCommand('robots-txt-validator')).toBe('robots-check');
    expect(resolveCommand('meta-tags-test')).toBe('meta-check');
    expect(resolveCommand('llms-txt-validator')).toBe('llms-txt-check');
    expect(resolveCommand('security-headers-scan')).toBe('security-headers');
    expect(resolveCommand('ai-visibility-check')).toBe('geo-check');
    expect(resolveCommand('ai-visibility')).toBe('geo-check');
    expect(resolveCommand('google-profile-finder')).toBe('google-profile');
  });
  test('leaves canonical names unchanged', () => {
    expect(resolveCommand('audit')).toBe('audit');
    expect(resolveCommand('schema-check')).toBe('schema-check');
  });
});

describe('parseCli', () => {
  test('parses command, target, and flags', () => {
    const parsed = parseCli(['schema-check', 'https://example.com', '--json', '--fail-on', 'fail']);
    expect(parsed.command).toBe('schema-check');
    expect(parsed.target).toBe('https://example.com');
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.failOn).toBe('fail');
  });
  test('resolves aliases before storing the command', () => {
    const parsed = parseCli(['schema-markup-check', 'example.com']);

    expect(parsed.command).toBe('schema-check');
    expect(parsed.target).toBe('example.com');
  });
  test('reads --format=value and -f value', () => {
    const parsed = parseCli(['audit', 'https://example.com', '--format=json']);
    expect(parsed.flags.outFormat).toBe('json');
    expect(parseCli(['audit', 'https://example.com', '-f', 'markdown']).flags.outFormat).toBe(
      'markdown',
    );
  });
  test('throws on unknown flags', () => {
    expect(() => parseCli(['schema-check', '--nope'])).toThrow('Unknown option');
  });
  test('applies --no-color to chalk', () => {
    const previous = chalk.level;

    chalk.level = 1;
    parseCli(['audit', 'https://example.com', '--silent', '--no-color']);
    expect(Number(chalk.level)).toBe(0);
    chalk.level = previous;
  });
  test('throws when --fail-on is invalid', () => {
    expect(() => parseCli(['schema-check', '--fail-on', 'ok'])).toThrow('--fail-on');
  });
  test('uses config output when --format and --json are omitted', () => {
    const parsed = parseCli(['audit', 'https://example.com'], { outFormat: 'markdown' });
    expect(parsed.flags.outFormat).toBe('markdown');
    expect(parsed.flags.json).toBe(false);
  });
  test('keeps --format over the config default', () => {
    const parsed = parseCli(['audit', 'https://example.com', '--format=html'], {
      outFormat: 'json',
    });
    expect(parsed.flags.outFormat).toBe('html');
  });
  test('keeps --json over the config default', () => {
    const parsed = parseCli(['audit', 'https://example.com', '--json'], { outFormat: 'html' });
    expect(parsed.flags.outFormat).toBe('json');
  });
  test('parses -g, --global, and --unset', () => {
    const globalShort = parseCli(['config', '-g', 'output']);

    expect(globalShort.command).toBe('config');
    expect(globalShort.flags.global).toBe(true);
    expect(globalShort.target).toBe('output');

    const globalLong = parseCli(['--global', 'config', 'output', 'json']);

    expect(globalLong.flags.global).toBe(true);
    expect(globalLong.target).toBe('output');
    expect(globalLong.flags.rest).toEqual(['json']);

    const unset = parseCli(['config', '--unset', 'output']);

    expect(unset.flags.unset).toBe(true);
    expect(unset.target).toBe('output');
  });
  test('does not apply config output default to the config command', () => {
    const parsed = parseCli(['config'], { outFormat: 'json' });

    expect(parsed.command).toBe('config');
    expect(parsed.flags.outFormat).toBe('table');
    expect(parsed.flags.json).toBe(false);
  });
  test('parses -o and --output as a file path', () => {
    const short = parseCli(['audit', 'https://example.com', '-o', './reports/audit.json']);
    expect(short.flags.outputPath).toBe('./reports/audit.json');
    expect(short.flags.outFormat).toBe('table');

    const long = parseCli(['audit', 'https://example.com', '--output=./reports/audit.md']);
    expect(long.flags.outputPath).toBe('./reports/audit.md');
    expect(long.flags.outFormat).toBe('table');
  });
  test('rejects a file path that is not .json or .md', () => {
    expect(() => parseCli(['audit', 'https://example.com', '-o', 'html'])).toThrow('.json or .md');
    expect(() => parseCli(['audit', 'https://example.com', '--output-dir=./out'])).toThrow(
      'Unknown option',
    );
    expect(() => parseCli(['schema-check', 'https://example.com', '--format=html'])).toThrow(
      'audit, geo-check, and seo-check',
    );
    expect(parseCli(['geo-check', 'https://example.com', '-f', 'markdown']).flags.outFormat).toBe(
      'markdown',
    );
    expect(parseCli(['seo-check', 'https://example.com', '--format=html']).flags.outFormat).toBe(
      'html',
    );
    expect(
      parseCli(['schema-check', 'https://example.com'], { outFormat: 'markdown' }).flags.outFormat,
    ).toBe('table');
    expect(parseCli(['schema-check', 'https://example.com', '-f', 'json']).flags.outFormat).toBe(
      'json',
    );
    expect(() => parseCli(['config', '-o', 'report.json'])).toThrow('not valid with config');
  });
  test('parses --version and -V', () => {
    expect(parseCli(['--version']).flags.version).toBe(true);
    expect(parseCli(['-V']).flags.version).toBe(true);
  });
  test('throws when a valued flag is missing its value', () => {
    expect(() => parseCli(['audit', 'https://example.com', '--fail-on'])).toThrow('Missing value');
  });
  test('parses --max-bytes and falls back to config', () => {
    expect(parseCli(['audit', 'https://example.com']).flags.maxBytes).toBe(2 * 1024 * 1024);
    expect(parseCli(['audit', 'https://example.com', '--max-bytes', '4mb']).flags.maxBytes).toBe(
      4 * 1024 * 1024,
    );
    expect(parseCli(['audit', 'https://example.com'], { maxBytes: 4096 }).flags.maxBytes).toBe(
      4096,
    );
    expect(parseCli(['audit', 'https://example.com', '--max-bytes=8kb']).flags.maxBytes).toBe(8192);
    expect(() => parseCli(['audit', 'https://example.com', '--max-bytes', '10'])).toThrow(
      'max_body_bytes',
    );
  });
});

describe('parseOutFormat', () => {
  test('returns table when omitted and json when --json is set', () => {
    expect(parseOutFormat(undefined, false)).toBe('table');
    expect(parseOutFormat(undefined, true)).toBe('json');
    expect(parseOutFormat(undefined, false, 'markdown')).toBe('markdown');
  });
  test('accepts json html markdown and table', () => {
    expect(parseOutFormat('table', false)).toBe('table');
    expect(parseOutFormat('JSON', false)).toBe('json');
  });
  test('throws on an unknown format', () => {
    expect(() => parseOutFormat('pdf', false)).toThrow(
      '--format must be json, html, markdown, or table',
    );
  });
});

describe('fileOutputFormat', () => {
  test('reads the extension', () => {
    expect(fileOutputFormat('report.JSON')).toBe('json');
    expect(fileOutputFormat('./reports/audit.md')).toBe('markdown');
  });
  test('rejects html and a bare format name', () => {
    expect(() => fileOutputFormat('report.html')).toThrow('.json or .md');
    expect(() => fileOutputFormat('json')).toThrow('.json or .md');
  });
});
