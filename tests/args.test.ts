import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { fileOutputFormat, parseCli, parseOutFormat, resolveCommand } from '../src/lib/args.ts';

const URL_ARG = 'https://example.com';

describe('resolveCommand', () => {
  test.each([
    ['schema-markup-check', 'schema-check'],
    ['robots-txt-validator', 'robots-check'],
    ['meta-tags-test', 'meta-check'],
    ['llms-txt-validator', 'llms-txt-check'],
    ['security-headers-scan', 'security-headers'],
    ['ai-visibility-check', 'geo-check'],
    ['ai-visibility', 'geo-check'],
    ['google-profile-finder', 'google-profile'],
    ['search-console', 'gsc'],
    ['audit', 'audit'],
  ])('maps %s to %s', (token, canonical) => {
    expect(resolveCommand(token)).toBe(canonical);
  });
});

describe('parseCli', () => {
  test('parses command, target, and flags, resolving aliases', () => {
    const parsed = parseCli(['schema-check', URL_ARG, '--json', '--fail-on', 'fail']);

    expect(parsed).toMatchObject({ command: 'schema-check', target: URL_ARG });
    expect(parsed.flags).toMatchObject({ json: true, failOn: 'fail' });
    expect(parseCli(['schema-markup-check', 'example.com']).command).toBe('schema-check');
  });
  test('reads --format=value and -f value', () => {
    expect(parseCli(['audit', URL_ARG, '--format=json']).flags.outFormat).toBe('json');
    expect(parseCli(['audit', URL_ARG, '-f', 'markdown']).flags.outFormat).toBe('markdown');
  });
  test('throws on unknown flags', () => {
    expect(() => parseCli(['schema-check', '--nope'])).toThrow('Unknown option');
  });
  test('--no-color turns chalk colors off', () => {
    const previous = chalk.level;

    chalk.level = 1;

    try {
      parseCli(['audit', URL_ARG, '--silent', '--no-color']);
      expect(Number(chalk.level)).toBe(0);
    } finally {
      chalk.level = previous;
    }
  });
  test('throws on an invalid --fail-on value', () => {
    expect(() => parseCli(['schema-check', '--fail-on', 'ok'])).toThrow('--fail-on');
  });
  test('throws when a valued flag has no value', () => {
    expect(() => parseCli(['audit', URL_ARG, '--fail-on'])).toThrow('Missing value');
  });
  test('config output applies unless --format or --json is given', () => {
    expect(parseCli(['audit', URL_ARG], { outFormat: 'markdown' }).flags).toMatchObject({
      outFormat: 'markdown',
      json: false,
    });
    expect(
      parseCli(['audit', URL_ARG, '--format=html'], { outFormat: 'json' }).flags.outFormat,
    ).toBe('html');
    expect(parseCli(['audit', URL_ARG, '--json'], { outFormat: 'html' }).flags.outFormat).toBe(
      'json',
    );
  });
  test('the config command ignores the config output default', () => {
    expect(parseCli(['config'], { outFormat: 'json' }).flags.outFormat).toBe('table');
  });
  test('parses config set, remove, list, and bare config', () => {
    expect(parseCli(['config', 'set', '-g', 'crux_api_key', 'YOUR_KEY'])).toMatchObject({
      command: 'config',
      target: 'set',
      flags: { global: true, rest: ['crux_api_key', 'YOUR_KEY'] },
    });
    expect(parseCli(['config', 'remove', '-g', 'crux_api_key'])).toMatchObject({
      target: 'remove',
      flags: { global: true, rest: ['crux_api_key'] },
    });
    expect(parseCli(['config', 'list', '--global'])).toMatchObject({
      target: 'list',
      flags: { global: true, rest: [] },
    });
    expect(parseCli(['config']).target).toBeUndefined();
    expect(() => parseCli(['config', '--unset', 'output'])).toThrow('Unknown option');
  });
  test('-o and --output take a file path and keep the table format', () => {
    expect(parseCli(['audit', URL_ARG, '-o', './reports/audit.json']).flags).toMatchObject({
      outputPath: './reports/audit.json',
      outFormat: 'table',
    });
    expect(parseCli(['audit', URL_ARG, '--output=./reports/audit.md']).flags.outputPath).toBe(
      './reports/audit.md',
    );
  });
  test('rejects an output file that is not .json or .md, and -o on config', () => {
    expect(() => parseCli(['audit', URL_ARG, '-o', 'html'])).toThrow('.json or .md');
    expect(() => parseCli(['audit', URL_ARG, '--output-dir=./out'])).toThrow('Unknown option');
    expect(() => parseCli(['config', '-o', 'report.json'])).toThrow('not valid with config');
  });
  test('html format is limited to audit, geo-check, and seo-check', () => {
    expect(() => parseCli(['schema-check', URL_ARG, '--format=html'])).toThrow(
      'audit, geo-check, and seo-check',
    );
    expect(parseCli(['seo-check', URL_ARG, '--format=html']).flags.outFormat).toBe('html');
    expect(parseCli(['geo-check', URL_ARG, '-f', 'markdown']).flags.outFormat).toBe('markdown');
  });
  test.each(['--version', '-V'])('%s sets the version flag', (token) => {
    expect(parseCli([token]).flags.version).toBe(true);
  });
  test.each([
    ['1kb', 1024],
    ['8kb', 8 * 1024],
    ['4mb', 4 * 1024 * 1024],
    ['32mb', 32 * 1024 * 1024],
  ])('--max-bytes %s is %d bytes', (value, bytes) => {
    expect(parseCli(['audit', URL_ARG, '--max-bytes', value]).flags.maxBytes).toBe(bytes);
  });
  test('--max-bytes defaults to 2 MiB, takes the config value, and rejects out-of-range sizes', () => {
    expect(parseCli(['audit', URL_ARG]).flags.maxBytes).toBe(2 * 1024 * 1024);
    expect(parseCli(['audit', URL_ARG], { maxBytes: 4096 }).flags.maxBytes).toBe(4096);
    expect(() => parseCli(['audit', URL_ARG, '--max-bytes', '10'])).toThrow('max_body_bytes');
    expect(() => parseCli(['audit', URL_ARG, '--max-bytes', '33mb'])).toThrow('max_body_bytes');
  });
  test('gsc parses --init-date and --end-date, and rejects bad dates', () => {
    expect(
      parseCli(['gsc', URL_ARG, '--init-date=2026-01-01', '--end-date', '2026-01-31']).flags,
    ).toMatchObject({ initDate: '2026-01-01', endDate: '2026-01-31' });
    expect(() => parseCli(['gsc', URL_ARG, '--init-date=2026-02-31'])).toThrow('YYYY-MM-DD');
    expect(() =>
      parseCli(['gsc', URL_ARG, '--init-date=2026-02-01', '--end-date=2026-01-01']),
    ).toThrow('on or before');
    expect(() => parseCli(['audit', URL_ARG, '--init-date=2026-01-01'])).toThrow(
      'only valid with gsc',
    );
  });
});

describe('parseOutFormat', () => {
  test('defaults to table, uses json for --json, and falls back to the config value', () => {
    expect(parseOutFormat(undefined, false)).toBe('table');
    expect(parseOutFormat(undefined, true)).toBe('json');
    expect(parseOutFormat(undefined, false, 'markdown')).toBe('markdown');
  });
  test('accepts a known format in any case and rejects others', () => {
    expect(parseOutFormat('JSON', false)).toBe('json');
    expect(() => parseOutFormat('pdf', false)).toThrow(
      '--format must be json, html, markdown, or table',
    );
  });
});

describe('fileOutputFormat', () => {
  test('maps .json and .md extensions, case-insensitive', () => {
    expect(fileOutputFormat('report.JSON')).toBe('json');
    expect(fileOutputFormat('./reports/audit.md')).toBe('markdown');
  });
  test('rejects html and a bare format name', () => {
    expect(() => fileOutputFormat('report.html')).toThrow('.json or .md');
    expect(() => fileOutputFormat('json')).toThrow('.json or .md');
  });
});
