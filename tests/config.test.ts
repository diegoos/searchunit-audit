import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import { applyConfig, canonicalConfigKey, loadConfig } from '../src/lib/config.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'searchunit-config-'));

  dirs.push(dir);

  return dir;
}

function makeDirs(): { cwd: string; home: string } {
  return { cwd: tempDir(), home: tempDir() };
}

function writeYaml(dir: string, body: string): void {
  writeFileSync(join(dir, '.searchunit.yaml'), body);
}

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

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  test('local YAML overlays home YAML; keys missing locally keep the home value', () => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'output: html\n');
    writeYaml(home, 'crux_api_key: home-key\noutput: json\n');
    expect(loadConfig({ cwd, home })).toEqual({ cruxApiKey: 'home-key', output: 'html' });
  });
  test.each([
    ['missing', null],
    ['empty', ''],
  ])('a %s local file does not hide the home values', (_state, body) => {
    const { cwd, home } = makeDirs();

    if (body !== null) {
      writeYaml(cwd, body);
    }

    writeYaml(home, 'output: markdown\n');
    expect(loadConfig({ cwd, home })).toEqual({ output: 'markdown' });
  });
  test('returns an empty config when neither file exists', () => {
    const { cwd, home } = makeDirs();

    expect(loadConfig({ cwd, home })).toEqual({});
  });
  test.each([
    ['8192', 8192],
    ['4mb', 4 * 1024 * 1024],
  ])('max_body_bytes %s from cwd overlays the home value', (value, bytes) => {
    const { cwd, home } = makeDirs();

    writeYaml(home, 'max_body_bytes: 4096\n');
    writeYaml(cwd, `max_body_bytes: ${value}\n`);
    expect(loadConfig({ cwd, home }).maxBodyBytes).toBe(bytes);
  });
  test.each([
    ['crux_api_key', 'cruxApiKey'],
    ['CRUX_API_KEY', 'cruxApiKey'],
    ['gsc_access_token', 'gscAccessToken'],
    ['gsc_quota_project', 'gscQuotaProject'],
    ['gsc_credentials', 'gscCredentials'],
  ])('%s is read from home and ignored in cwd', (key, prop) => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, `${key}: cwd-value\n`);
    writeYaml(home, `${key}: home-value\n`);
    expect(loadConfig({ cwd, home })).toEqual({ [prop]: 'home-value' });
  });
  test.each([
    ['invalid YAML', 'output: [unterminated\n', /Invalid YAML/],
    ['an invalid output', 'output: pdf\n', /output/],
  ])('rejects %s', (_label, body, error) => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, body);
    expect(() => loadConfig({ cwd, home })).toThrow(error);
  });
});

describe('applyConfig', () => {
  const envNames = ['CRUX_API_KEY', 'GSC_ACCESS_TOKEN', 'GSC_QUOTA_PROJECT'] as const;
  const saved = envNames.map((name) => [name, process.env[name]] as const);

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  test.each([
    ['CRUX_API_KEY', { cruxApiKey: 'from-file' }],
    ['GSC_ACCESS_TOKEN', { gscAccessToken: 'from-file' }],
    ['GSC_QUOTA_PROJECT', { gscQuotaProject: 'from-file' }],
  ])('fills an unset %s and never overrides an existing value', (name, values) => {
    process.env[name] = '';
    applyConfig(values);
    expect(process.env[name]).toBe('from-file');

    process.env[name] = 'from-env';
    applyConfig(values);
    expect(process.env[name]).toBe('from-env');
  });
});

describe('config keys', () => {
  test('canonicalConfigKey maps the CRUX_API_KEY alias and rejects unknown keys', () => {
    expect(canonicalConfigKey('CRUX_API_KEY')).toBe('crux_api_key');
    expect(canonicalConfigKey('nope')).toBeUndefined();
  });
});

describe('config command', () => {
  test('set, get, list, and remove act on the local file only', async () => {
    const { cwd, home } = makeDirs();
    const opts = { cwd, home };

    const set = await capture(() => runConfig('set', flags({ rest: ['output', 'json'] }), opts));

    expect(set.code).toBe(0);
    expect(set.logs.join('\n')).toMatch(/Local[\s\S]*json/);
    expect(loadConfig(opts).output).toBe('json');
    expect(existsSync(join(home, '.searchunit.yaml'))).toBe(false);

    const get = await capture(() => runConfig('output', flags(), opts));

    expect(get.logs.join('\n')).toMatch(/Local[\s\S]*json/);
    expect(get.logs.join('\n')).toMatch(/Default[\s\S]*table/);

    const list = await capture(() => runConfig(undefined, flags(), opts));

    expect(list.logs.join('\n')).toMatch(/output[\s\S]*json/);

    const removed = await capture(() => runConfig('remove', flags({ rest: ['output'] }), opts));

    expect(removed.code).toBe(0);
    expect(loadConfig(opts).output).toBeUndefined();
    expect(existsSync(join(cwd, '.searchunit.yaml'))).toBe(true);
  });
  test('set creates the local file with mode 600', async () => {
    const { cwd, home } = makeDirs();
    const path = join(cwd, '.searchunit.yaml');

    await capture(() => runConfig('set', flags({ rest: ['output', 'json'] }), { cwd, home }));

    expect(readFileSync(path, 'utf8')).toContain('output: json');
    expect(statSync(path).mode.toString(8).slice(-3)).toBe('600');
  });
  test('set reports Created, then Updated, with the file path on stderr', async () => {
    const { cwd, home } = makeDirs();
    const path = join(cwd, '.searchunit.yaml');
    const opts = { cwd, home };

    const created = await capture(() =>
      runConfig('set', flags({ silent: false, rest: ['output', 'json'] }), opts),
    );

    expect(created.errs.join('\n')).toContain('Created');
    expect(created.errs.join('\n')).toContain(path);

    const updated = await capture(() =>
      runConfig('set', flags({ silent: false, rest: ['output', 'html'] }), opts),
    );

    expect(updated.errs.join('\n')).toContain('Updated');
    expect(updated.errs.join('\n')).toContain(path);
    expect(updated.logs.join('\n')).toMatch(/Local[\s\S]*html/);
  });
  test('set -g writes the home file and leaves the cwd file alone', async () => {
    const { cwd, home } = makeDirs();

    await capture(() =>
      runConfig('set', flags({ global: true, rest: ['output', 'html'] }), { cwd, home }),
    );

    expect(readFileSync(join(home, '.searchunit.yaml'), 'utf8')).toContain('output: html');
    expect(existsSync(join(cwd, '.searchunit.yaml'))).toBe(false);
  });
  test.each([
    ['an invalid output', ['output', 'pdf'], /Invalid output/],
    ['an empty value', ['output', '  '], /non-empty string/],
    ['a max_body_bytes below 1 KiB', ['max_body_bytes', '1'], /max_body_bytes/],
  ])('set rejects %s', async (_label, rest, error) => {
    const { cwd, home } = makeDirs();

    await expect(runConfig('set', flags({ rest }), { cwd, home })).rejects.toThrow(error);
  });
  test.each([
    ['set', ['crux_api_key', 'secret']],
    ['set', ['gsc_access_token', 'ya29.secret']],
    ['set', ['gsc_quota_project', 'my-project']],
    ['set', ['gsc_credentials', '/tmp/credentials.json']],
    ['remove', ['crux_api_key']],
  ])('%s of a home-only key without -g is refused and writes nothing', async (action, rest) => {
    const { cwd, home } = makeDirs();

    await expect(runConfig(action, flags({ rest }), { cwd, home })).rejects.toThrow(
      'project cwd YAML is not applied',
    );
    expect(existsSync(join(cwd, '.searchunit.yaml'))).toBe(false);
  });
  test('get redacts crux_api_key in every layer', async () => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'crux_api_key: cwd-secret\n');
    writeYaml(home, 'crux_api_key: home-secret\n');

    const get = await capture(() =>
      runConfig('crux_api_key', flags({ json: true }), { cwd, home }),
    );
    const payload = JSON.parse(get.logs.join('\n')) as { value: string; local: string | null };

    expect(get.code).toBe(0);
    expect(payload).toMatchObject({ value: '[redacted]', local: '[redacted]' });
    expect(get.logs.join('\n')).not.toMatch(/home-secret|cwd-secret/);
  });
  test.each([false, true])('list redacts secrets (json: %s)', async (json) => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'crux_api_key: local-secret\n');
    writeYaml(home, 'crux_api_key: home-secret\ngsc_access_token: ya29.home-token\n');

    const list = await capture(() => runConfig(undefined, flags({ json }), { cwd, home }));
    const out = list.logs.join('\n');

    expect(out).toContain('[redacted]');
    expect(out).not.toMatch(/local-secret|home-secret|ya29\.home-token/);
  });
  test('list json reports values and per-layer values with secrets redacted', async () => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'crux_api_key: local-secret\n');
    writeYaml(home, 'crux_api_key: home-secret\ngsc_access_token: ya29.home-token\n');

    const list = await capture(() => runConfig(undefined, flags({ json: true }), { cwd, home }));
    const payload = JSON.parse(list.logs.join('\n')) as {
      values: Record<string, unknown>;
      layers: Record<string, { local: string | null; global: string | null }>;
    };
    expect(payload.values.crux_api_key).toBe('[redacted]');
    expect(payload.layers.crux_api_key).toMatchObject({
      local: '[redacted]',
      global: '[redacted]',
    });
    expect(payload.layers.gsc_access_token?.global).toBe('[redacted]');
  });
  test('list reads only the cwd file', async () => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'output: json\n');
    writeYaml(home, 'output: html\n');

    const list = await capture(() => runConfig('list', flags(), { cwd, home }));
    const out = list.logs.join('\n');

    expect(list.code).toBe(0);
    expect(out).toContain('list local');
    expect(out).toContain(join(cwd, '.searchunit.yaml'));
    expect(out).toMatch(/output[\s\S]*json/);
    expect(out).not.toContain('html');
  });
  test('list -g reads only the home file and redacts its secrets', async () => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'output: json\n');
    writeYaml(home, 'output: html\ncrux_api_key: home-secret\n');

    const list = await capture(() => runConfig('list', flags({ global: true }), { cwd, home }));
    const out = list.logs.join('\n');

    expect(list.code).toBe(0);
    expect(out).toContain('list global');
    expect(out).toContain(join(home, '.searchunit.yaml'));
    expect(out).toMatch(/output[\s\S]*html/);
    expect(out).not.toContain('json');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('home-secret');
  });
  test('list rejects extra arguments', async () => {
    await expect(
      runConfig('list', flags({ rest: ['output'] }), { cwd: tempDir() }),
    ).rejects.toThrow(/Too many arguments/);
  });
  test('rejects an unknown key, and tells a get-style call to use config set', async () => {
    const { cwd } = makeDirs();

    await expect(
      runConfig('set', flags({ rest: ['nope', 'x'] }), { cwd, home: cwd }),
    ).rejects.toThrow(/Unknown config key/);
    await expect(
      runConfig('output', flags({ rest: ['json'] }), { cwd, home: cwd }),
    ).rejects.toThrow(/config set/);
  });
  test('remove -g json redacts a leftover local crux_api_key', async () => {
    const { cwd, home } = makeDirs();

    writeYaml(cwd, 'crux_api_key: local-secret\n');
    writeYaml(home, 'crux_api_key: home-secret\n');

    const removed = await capture(() =>
      runConfig('remove', flags({ rest: ['crux_api_key'], json: true, global: true }), {
        cwd,
        home,
      }),
    );
    const dumped = removed.logs.join('\n');
    const payload = JSON.parse(dumped) as { action: string; local: string | null };

    expect(removed.code).toBe(0);
    expect(payload).toMatchObject({ action: 'remove', local: '[redacted]' });
    expect(dumped).not.toMatch(/local-secret|home-secret/);
  });
  test('prints local, global, and default when the key is unset', async () => {
    const { cwd, home } = makeDirs();

    const get = await capture(() => runConfig('output', flags(), { cwd, home }));
    const out = get.logs.join('\n');

    expect(get.code).toBe(0);
    expect(out).toMatch(/Local[\s\S]*not set/);
    expect(out).toMatch(/Global[\s\S]*not set/);
    expect(out).toMatch(/Default[\s\S]*table/);
  });
  test('get json includes the local, global, and default layers', async () => {
    const { cwd, home } = makeDirs();

    const get = await capture(() => runConfig('output', flags({ json: true }), { cwd, home }));
    const payload = JSON.parse(get.logs.join('\n')) as Record<string, unknown>;

    expect(payload).toMatchObject({ local: null, global: null, default: 'table', value: 'table' });
  });
});
