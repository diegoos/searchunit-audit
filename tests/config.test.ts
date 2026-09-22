import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import {
  applyConfig,
  canonicalConfigKey,
  configFilePath,
  loadConfig,
  mappingGet,
  mappingSet,
  mappingUnset,
  writeConfigMapping,
} from '../src/lib/config.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'searchunit-config-'));
}

describe('loadConfig', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('reads .searchunit.yaml from cwd', () => {
    const cwd = tempDir();

    dirs.push(cwd);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'crux_api_key: cwd-key\noutput: json\n');
    expect(loadConfig({ cwd, home: tempDir() })).toEqual({
      output: 'json',
    });
  });
  test('reads max_body_bytes from cwd as bytes or a suffix', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(home, '.searchunit.yaml'), 'max_body_bytes: 4096\n');
    writeFileSync(join(cwd, '.searchunit.yaml'), 'max_body_bytes: 4mb\n');
    expect(loadConfig({ cwd, home }).maxBodyBytes).toBe(4 * 1024 * 1024);
  });
  test('reads a numeric max_body_bytes', () => {
    const cwd = tempDir();

    dirs.push(cwd);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'max_body_bytes: 8192\n');
    expect(loadConfig({ cwd, home: tempDir() }).maxBodyBytes).toBe(8192);
  });
  test('ignores crux_api_key from cwd', () => {
    const cwd = tempDir();

    dirs.push(cwd);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'crux_api_key: cwd-key\n');
    expect(loadConfig({ cwd, home: tempDir() })).toEqual({});
  });
  test('applies crux_api_key from home', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(home, '.searchunit.yaml'), 'crux_api_key: home-key\n');
    expect(loadConfig({ cwd, home })).toEqual({ cruxApiKey: 'home-key' });
  });
  test('accepts CRUX_API_KEY as an alias of crux_api_key', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(home, '.searchunit.yaml'), 'CRUX_API_KEY: env-style\n');
    expect(loadConfig({ cwd, home })).toEqual({ cruxApiKey: 'env-style' });
  });
  test('falls back to $HOME/.searchunit.yaml when cwd has none', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(home, '.searchunit.yaml'), 'output: markdown\n');
    expect(loadConfig({ cwd, home })).toEqual({ output: 'markdown' });
  });
  test('local keys overlay home; missing local keys keep home values', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'output: html\n');
    writeFileSync(join(home, '.searchunit.yaml'), 'crux_api_key: home-key\noutput: json\n');
    expect(loadConfig({ cwd, home })).toEqual({
      cruxApiKey: 'home-key',
      output: 'html',
    });
  });
  test('empty local file does not hide home keys', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), '');
    writeFileSync(join(home, '.searchunit.yaml'), 'output: markdown\n');
    expect(loadConfig({ cwd, home })).toEqual({ output: 'markdown' });
  });
  test('returns empty config when neither file exists', () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    expect(loadConfig({ cwd, home })).toEqual({});
  });
  test('rejects invalid YAML', () => {
    const cwd = tempDir();

    dirs.push(cwd);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'output: [unterminated\n');
    expect(() => loadConfig({ cwd, home: tempDir() })).toThrow(/Invalid YAML/);
  });
  test('rejects invalid output', () => {
    const cwd = tempDir();

    dirs.push(cwd);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'output: pdf\n');
    expect(() => loadConfig({ cwd, home: tempDir() })).toThrow(/output/);
  });
});

describe('applyConfig', () => {
  const original = process.env.CRUX_API_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CRUX_API_KEY;
    } else {
      process.env.CRUX_API_KEY = original;
    }
  });
  test('sets CRUX_API_KEY when the env is unset', () => {
    process.env.CRUX_API_KEY = '';
    applyConfig({ cruxApiKey: 'from-file' });
    expect(process.env.CRUX_API_KEY).toBe('from-file');
  });
  test('does not override an existing CRUX_API_KEY', () => {
    process.env.CRUX_API_KEY = 'from-env';
    applyConfig({ cruxApiKey: 'from-file' });
    expect(process.env.CRUX_API_KEY).toBe('from-env');
  });
});

describe('config mapping helpers', () => {
  test('canonicalConfigKey maps aliases and rejects unknown keys', () => {
    expect(canonicalConfigKey('crux_api_key')).toBe('crux_api_key');
    expect(canonicalConfigKey('CRUX_API_KEY')).toBe('crux_api_key');
    expect(canonicalConfigKey('nope')).toBeUndefined();
  });
  test('configFilePath joins cwd or home with .searchunit.yaml', () => {
    expect(configFilePath({ cwd: '/tmp/proj' })).toBe('/tmp/proj/.searchunit.yaml');
    expect(configFilePath({ global: true, home: '/tmp/home' })).toBe('/tmp/home/.searchunit.yaml');
  });
  test('mappingGet returns trimmed strings and lowercases output keys', () => {
    expect(mappingGet({ output: ' JSON ' }, 'output')).toBe('json');
    expect(mappingGet({ CRUX_API_KEY: 'abc' }, 'crux_api_key')).toBe('abc');
    expect(mappingGet({ max_body_bytes: 8192 }, 'max_body_bytes')).toBe('8192');
    expect(mappingGet({}, 'output')).toBeUndefined();
  });
  test('mappingSet writes canonical keys and mappingUnset removes aliases', () => {
    const set = mappingSet({}, 'output', 'markdown');

    expect(set).toEqual({ output: 'markdown' });
    expect(() => mappingSet({}, 'output', '  ')).toThrow('non-empty string');
    expect(() => mappingSet({}, 'output', 'pdf')).toThrow('Invalid output');
    expect(mappingSet({}, 'max_body_bytes', '2mb')).toEqual({ max_body_bytes: '2097152' });
    expect(() => mappingSet({}, 'max_body_bytes', '1')).toThrow('max_body_bytes');
    const withAlias = mappingUnset({ CRUX_API_KEY: 'x', output: 'json' }, 'crux_api_key');

    expect(withAlias.removed).toBe(true);
    expect(withAlias.record).toEqual({ output: 'json' });
    expect(mappingUnset({ output: 'json' }, 'crux_api_key').removed).toBe(false);
  });
  test('writeConfigMapping keeps an empty file instead of deleting it', () => {
    const dir = tempDir();
    const path = join(dir, '.searchunit.yaml');

    try {
      writeConfigMapping(path, { output: 'json' });
      writeConfigMapping(path, {});
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8').trim()).toBe('');
      expect(statSync(path).mode.toString(8).slice(-3)).toBe('600');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function flags(over: Partial<CliFlags> = {}): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    silent: true,
    outFormat: 'table',
    failOn: undefined,
    rest: [],
    global: false,
    unset: false,
    agent: false,
    outputPath: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    ...over,
  };
}

async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  logs: string[];
  errs: string[];
}> {
  const logs: string[] = [];
  const errs: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;

  console.log = (msg?: unknown) => {
    logs.push(String(msg ?? ''));
  };
  console.error = (msg?: unknown) => {
    errs.push(String(msg ?? ''));
  };
  try {
    return { code: await fn(), logs, errs };
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
}

describe('config command', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('sets gets lists and unsets keys in the local file', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    const dirsOpt = { cwd, home };

    const set = await capture(() => runConfig('output', flags({ rest: ['json'] }), dirsOpt));

    expect(set.code).toBe(0);
    expect(set.logs.join('\n')).toMatch(/Config/);
    expect(set.logs.join('\n')).toMatch(/Local[\s\S]*json/);
    expect(set.logs.join('\n')).toMatch(/Default[\s\S]*table/);
    expect(loadConfig({ cwd, home }).output).toBe('json');
    expect(existsSync(join(home, '.searchunit.yaml'))).toBe(false);

    const get = await capture(() => runConfig('output', flags(), dirsOpt));

    expect(get.code).toBe(0);
    expect(get.logs.join('\n')).toMatch(/Local[\s\S]*json/);
    expect(get.logs.join('\n')).toMatch(/Default[\s\S]*table/);

    const list = await capture(() => runConfig(undefined, flags(), dirsOpt));

    expect(list.logs.join('\n')).toContain('output');
    expect(list.logs.join('\n')).toContain('json');

    const unset = await capture(() => runConfig('output', flags({ unset: true }), dirsOpt));

    expect(unset.code).toBe(0);
    expect(loadConfig({ cwd, home }).output).toBeUndefined();
    expect(existsSync(join(cwd, '.searchunit.yaml'))).toBe(true);
  });
  test('set announces Created then Updated on stderr', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    const dirsOpt = { cwd, home };
    const path = join(cwd, '.searchunit.yaml');
    const created = await capture(() =>
      runConfig('output', flags({ silent: false, rest: ['json'] }), dirsOpt),
    );
    expect(created.errs.join('\n')).toContain('Created');
    expect(created.errs.join('\n')).toContain(path);
    const updated = await capture(() =>
      runConfig('output', flags({ silent: false, rest: ['html'] }), dirsOpt),
    );
    expect(updated.errs.join('\n')).toContain('Updated');
    expect(updated.errs.join('\n')).toContain(path);
    expect(updated.logs.join('\n')).toMatch(/Local[\s\S]*html/);
  });
  test('set creates .searchunit.yaml when the file is missing', async () => {
    const cwd = tempDir();

    dirs.push(cwd);
    const path = join(cwd, '.searchunit.yaml');

    expect(existsSync(path)).toBe(false);
    const set = await capture(() =>
      runConfig('output', flags({ rest: ['json'] }), { cwd, home: tempDir() }),
    );
    expect(set.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('output: json');
  });
  test('writes -g to the home file', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);

    const set = await capture(() =>
      runConfig('output', flags({ global: true, rest: ['html'] }), { cwd, home }),
    );
    expect(set.code).toBe(0);
    expect(readFileSync(join(home, '.searchunit.yaml'), 'utf8')).toContain('output: html');
    expect(loadConfig({ cwd, home: tempDir() }).output).toBeUndefined();
  });
  test('rejects home-only keys without -g', async () => {
    const cwd = tempDir();
    const home = tempDir();
    const cwdPath = join(cwd, '.searchunit.yaml');

    dirs.push(cwd, home);
    await expect(
      runConfig('crux_api_key', flags({ rest: ['secret'] }), { cwd, home }),
    ).rejects.toThrow('project cwd YAML is not applied');
    expect(existsSync(cwdPath)).toBe(false);
  });
  test('rejects unset of home-only keys without -g', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    await expect(runConfig('crux_api_key', flags({ unset: true }), { cwd, home })).rejects.toThrow(
      'project cwd YAML is not applied',
    );
  });
  test('config get effective ignores cwd home-only keys', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'crux_api_key: cwd-secret\n');
    writeFileSync(join(home, '.searchunit.yaml'), 'crux_api_key: home-secret\n');
    const get = await capture(() =>
      runConfig('crux_api_key', flags({ json: true }), { cwd, home }),
    );

    expect(get.code).toBe(0);
    const payload = JSON.parse(get.logs.join('\n')) as { value: string; local: string | null };

    expect(payload.value).toBe('[redacted]');
    expect(payload.local).toBe('[redacted]');
    expect(get.logs.join('\n')).not.toContain('home-secret');
  });
  test('list table redacts crux_api_key', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(home, '.searchunit.yaml'), 'crux_api_key: home-secret\n');
    const list = await capture(() => runConfig(undefined, flags(), { cwd, home }));
    const out = list.logs.join('\n');

    expect(out).toContain('[redacted]');
    expect(out).not.toContain('home-secret');
  });
  test('rejects an unknown key', async () => {
    const cwd = tempDir();

    dirs.push(cwd);
    await expect(runConfig('nope', flags({ rest: ['x'] }), { cwd, home: cwd })).rejects.toThrow(
      /Unknown config key/,
    );
  });
  test('config list reads cwd YAML and ignores the home file', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'output: json\n');
    writeFileSync(join(home, '.searchunit.yaml'), 'output: html\n');
    const list = await capture(() => runConfig('list', flags(), { cwd, home }));
    const out = list.logs.join('\n');

    expect(list.code).toBe(0);
    expect(out).toContain('list local');
    expect(out).toContain(join(cwd, '.searchunit.yaml'));
    expect(out).not.toContain(join(home, '.searchunit.yaml'));
    expect(out).toMatch(/output[\s\S]*json/);
    expect(out).not.toContain('html');
  });
  test('config list -g reads home YAML and ignores the cwd file', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'output: json\n');
    writeFileSync(join(home, '.searchunit.yaml'), 'output: html\ncrux_api_key: home-secret\n');
    const list = await capture(() => runConfig('list', flags({ global: true }), { cwd, home }));
    const out = list.logs.join('\n');

    expect(list.code).toBe(0);
    expect(out).toContain('list global');
    expect(out).toContain(join(home, '.searchunit.yaml'));
    expect(out).not.toContain(join(cwd, '.searchunit.yaml'));
    expect(out).toMatch(/output[\s\S]*html/);
    expect(out).not.toContain('json');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('home-secret');
  });
  test('config list rejects extra arguments', async () => {
    await expect(
      runConfig('list', flags({ rest: ['output'] }), { cwd: tempDir() }),
    ).rejects.toThrow(/Too many arguments/);
  });
  test('lists local global and default layers when no file exists', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    const list = await capture(() => runConfig(undefined, flags(), { cwd, home }));

    expect(list.code).toBe(0);
    const out = list.logs.join('\n');

    expect(out).toContain('Local');
    expect(out).toContain('Global');
    expect(out).toContain('Default');
    expect(out).toContain('output');
    expect(out).toContain('table');
    expect(out).toContain('not set');
  });
  test('list json redacts crux_api_key in values and layers', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'crux_api_key: local-secret\n');
    writeFileSync(join(home, '.searchunit.yaml'), 'crux_api_key: home-secret\n');
    const list = await capture(() => runConfig(undefined, flags({ json: true }), { cwd, home }));

    expect(list.code).toBe(0);
    const payload = JSON.parse(list.logs.join('\n')) as {
      values: Record<string, unknown>;
      layers: Record<string, { local: string | null; global: string | null }>;
    };
    expect(payload.values.crux_api_key).toBe('[redacted]');
    expect(payload.layers.crux_api_key?.local).toBe('[redacted]');
    expect(payload.layers.crux_api_key?.global).toBe('[redacted]');
  });
  test('unset json redacts leftover local crux_api_key', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    writeFileSync(join(cwd, '.searchunit.yaml'), 'crux_api_key: local-secret\n');
    writeFileSync(join(home, '.searchunit.yaml'), 'crux_api_key: home-secret\n');
    const unset = await capture(() =>
      runConfig('crux_api_key', flags({ unset: true, json: true, global: true }), { cwd, home }),
    );

    expect(unset.code).toBe(0);
    const payload = JSON.parse(unset.logs.join('\n')) as { local: string | null };
    const dumped = unset.logs.join('\n');

    expect(payload.local).toBe('[redacted]');
    expect(dumped).not.toContain('local-secret');
    expect(dumped).not.toContain('home-secret');
  });
  test('prints local global and default when a key is unset', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    const get = await capture(() => runConfig('output', flags(), { cwd, home }));

    expect(get.code).toBe(0);
    const out = get.logs.join('\n');

    expect(out).toMatch(/Local[\s\S]*not set/);
    expect(out).toMatch(/Global[\s\S]*not set/);
    expect(out).toMatch(/Default[\s\S]*table/);
  });
  test('get json includes local global and default layers', async () => {
    const cwd = tempDir();
    const home = tempDir();

    dirs.push(cwd, home);
    const get = await capture(() => runConfig('output', flags({ json: true }), { cwd, home }));

    expect(get.code).toBe(0);
    const payload = JSON.parse(get.logs.join('\n')) as {
      local: string | null;
      global: string | null;
      default: string | null;
      value: string | null;
    };
    expect(payload).toMatchObject({
      local: null,
      global: null,
      default: 'table',
      value: 'table',
    });
  });
});
