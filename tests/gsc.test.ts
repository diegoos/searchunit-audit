import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { renderGscTables, runGsc } from '../src/commands/gsc.ts';
import {
  GSC_SCOPE,
  GscRequestError,
  gscAuth,
  gscWindow,
  pickSite,
  redact,
  resolveQuotaProject,
  runGscQuery,
  safeAuditUrl,
  unexpectedScopes,
  type GscApi,
  type GscQueryBody,
} from '../src/gsc.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';

const TOKEN = 'ya29.test-token-value';
const MISSING_ADC = '/tmp/searchunit-missing-adc.json';
const ENV_NAMES = [
  'GSC_ACCESS_TOKEN',
  'GSC_CREDENTIALS',
  'GSC_QUOTA_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
] as const;

type EnvName = (typeof ENV_NAMES)[number];

/** Sets env vars for one call and restores every GSC-related var afterwards. */
async function withEnv<T>(
  overrides: Partial<Record<EnvName, string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = ENV_NAMES.map((name) => [name, process.env[name]] as const);

  for (const name of ENV_NAMES) {
    if (!(name in overrides)) {
      continue;
    }

    const value = overrides[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function captureLogs(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const original = console.log;

  console.log = (msg?: unknown) => {
    logs.push(String(msg ?? ''));
  };
  try {
    return { code: await fn(), out: logs.join('\n') };
  } finally {
    console.log = original;
  }
}

function flags(over: Partial<CliFlags> = {}): CliFlags {
  return {
    json: true,
    help: false,
    version: false,
    silent: true,
    outFormat: 'json',
    failOn: 'fail',
    rest: [],
    global: false,
    agent: false,
    outputPath: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    ...over,
  };
}

function api(over: Partial<GscApi> = {}): GscApi {
  return {
    async listSites() {
      return [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }];
    },
    async query() {
      return {
        rows: [{ keys: ['example'], clicks: 2, impressions: 10, ctr: 0.2, position: 3.456 }],
      };
    },
    async listSitemaps() {
      return [];
    },
    async inspect() {
      return {};
    },
    ...over,
  };
}

function tempFile(name: string, body: unknown): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'searchunit-gsc-'));
  const file = join(dir, name);

  writeFileSync(file, JSON.stringify(body));

  return { dir, file };
}

describe('gsc helpers', () => {
  test('redact removes access tokens and API keys', () => {
    const redacted = redact('Bearer ya29.secret AIzaSySecretkeyvalue123456');

    expect(redacted).not.toContain('ya29.');
    expect(redacted).not.toContain('AIza');
    expect(redacted).not.toContain('secret');
  });
  test('unexpectedScopes flags anything beyond the read-only Search Console scope', () => {
    expect(
      unexpectedScopes([
        'openid',
        'email',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/cloud-platform',
        GSC_SCOPE,
      ]),
    ).toEqual([]);
    expect(unexpectedScopes([GSC_SCOPE, 'https://www.googleapis.com/auth/webmasters'])).toEqual([
      'https://www.googleapis.com/auth/webmasters',
    ]);
    expect(
      unexpectedScopes([GSC_SCOPE, 'https://www.googleapis.com/auth/analytics.readonly']),
    ).toEqual(['https://www.googleapis.com/auth/analytics.readonly']);
  });
  test.each([
    ['https://example.com/', 'https://example.com/'],
    ['http://127.0.0.1/', ''],
    ['http://localhost:3000/', ''],
    ['http://169.254.169.254/', ''],
    ['https://user:pass@example.com/', ''],
  ])('safeAuditUrl(%s) is %j', (url, expected) => {
    expect(safeAuditUrl(url)).toBe(expected);
  });
  test('pickSite chooses the longest matching property and never a lookalike or unverified one', () => {
    expect(
      pickSite(
        [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://example.com/blog/', permissionLevel: 'siteOwner' },
        ],
        'https://example.com/blog/post',
      ),
    ).toBe('https://example.com/blog/');
    expect(
      pickSite(
        [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }],
        'https://www.example.com/',
      ),
    ).toBe('sc-domain:example.com');
    expect(
      pickSite(
        [{ siteUrl: 'https://example.com/', permissionLevel: 'siteUnverifiedUser' }],
        'https://example.com/',
      ),
    ).toBeNull();
    expect(
      pickSite(
        [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }],
        'https://example.com.evil/path',
      ),
    ).toBeNull();
  });
  test.each([
    ['defaults to 28 days ending three days before the PT date', {}, '2026-08-31', '2026-09-27'],
    ['initDate alone derives the end date', { initDate: '2026-01-01' }, '2026-01-01', '2026-01-31'],
    ['endDate alone derives the start date', { endDate: '2026-01-31' }, '2026-01-01', '2026-01-31'],
    [
      'both dates are used as given',
      { initDate: '2026-03-01', endDate: '2026-03-15' },
      '2026-03-01',
      '2026-03-15',
    ],
  ])('gscWindow %s', (_label, options, startDate, endDate) => {
    expect(gscWindow(new Date('2026-09-30T18:00:00Z'), options)).toEqual({ startDate, endDate });
  });
});

describe('runGscQuery', () => {
  test('skips when no token is set and never calls Google', async () => {
    let called = false;

    const result = await withEnv(
      {
        GSC_ACCESS_TOKEN: undefined,
        GSC_CREDENTIALS: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: undefined,
      },
      () =>
        runGscQuery({
          mode: 'check',
          api: api({
            async listSites() {
              called = true;

              return [];
            },
          }),
        }),
    );

    expect(result).toEqual({ status: 'skipped', reason: 'token-missing' });
    expect(called).toBe(false);
  });
  test('refuses a token whose scopes are not read-only', async () => {
    let called = false;
    const result = await runGscQuery({
      mode: 'performance',
      url: 'https://example.com/',
      token: TOKEN,
      api: api({
        async scopes() {
          return [GSC_SCOPE, 'https://www.googleapis.com/auth/webmasters'];
        },
        async listSites() {
          called = true;

          return [];
        },
      }),
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'scopes-not-readonly' });
    expect(called).toBe(false);
  });
  test('queries each sampled URL on the matching property, one equals filter each', async () => {
    const queries: { siteUrl: string; body: GscQueryBody }[] = [];
    const result = await runGscQuery({
      mode: 'performance',
      url: 'https://example.com/blog/post',
      sample: ['https://example.com/blog/other', 'https://other.example.net/nope'],
      token: TOKEN,
      now: new Date('2026-09-30T18:00:00Z'),
      api: api({
        async listSites() {
          return [
            { siteUrl: 'https://example.com/blog/', permissionLevel: 'siteOwner' },
            { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
          ];
        },
        async query(siteUrl, body) {
          queries.push({ siteUrl, body });

          return {
            rows: [{ keys: ['example'], clicks: 2, impressions: 10, ctr: 0.2, position: 3.456 }],
          };
        },
      }),
    });
    const sampled = queries.filter(
      (call) => call.body.dimensions[0] === 'page' && call.body.dimensionFilterGroups,
    );

    expect(result).toMatchObject({
      status: 'ok',
      siteUrl: 'https://example.com/blog/',
      urls: ['https://example.com/blog/post', 'https://example.com/blog/other'],
      window: { startDate: '2026-08-31', endDate: '2026-09-27' },
    });
    expect(sampled).toHaveLength(2);

    for (const call of sampled) {
      expect(call.siteUrl).toBe('https://example.com/blog/');
      expect(call.body.dimensionFilterGroups?.[0]?.filters).toHaveLength(1);
    }

    expect(JSON.stringify(result)).not.toContain('ya29.');
  });
  test('query-pages runs only the query and page slice', async () => {
    const queries: GscQueryBody[] = [];
    let sitemaps = 0;
    const result = await runGscQuery({
      mode: 'performance',
      slice: 'query-pages',
      url: 'https://example.com/',
      token: TOKEN,
      initDate: '2026-01-01',
      api: api({
        async query(_site, body) {
          queries.push(body);

          return { rows: [] };
        },
        async listSitemaps() {
          sitemaps += 1;

          return [];
        },
      }),
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      dimensions: ['query', 'page'],
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(sitemaps).toBe(0);
    expect(result.queryPages).toEqual({ rows: [] });
    expect(result.pageQueries).toBeUndefined();
    expect(result.sitemaps).toBeUndefined();
  });
  test('sitemaps slice lists submitted sitemaps without Search Analytics queries', async () => {
    let queries = 0;
    const result = await runGscQuery({
      mode: 'performance',
      slice: 'sitemaps',
      url: 'https://example.com/',
      token: TOKEN,
      api: api({
        async query() {
          queries += 1;

          return { rows: [] };
        },
        async listSitemaps() {
          return [{ path: 'https://example.com/sitemap.xml', errors: '1', warnings: '0' }];
        },
      }),
    });
    expect(queries).toBe(0);
    expect(result.window).toBeUndefined();
    expect(result.sitemaps).toMatchObject({
      entries: [{ path: 'https://example.com/sitemap.xml', errors: '1', warnings: '0' }],
    });
  });
  test('the googleapis auth client carries the GSC_QUOTA_PROJECT quota project', async () => {
    await withEnv(
      {
        GSC_QUOTA_PROJECT: 'searchunit-quota',
        GOOGLE_CLOUD_QUOTA_PROJECT: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: MISSING_ADC,
      },
      async () => {
        const auth = await gscAuth(TOKEN);

        expect('client' in auth).toBe(true);

        if (!('client' in auth)) {
          return;
        }

        expect(auth.client).toBeInstanceOf(google.auth.OAuth2);
        expect(auth.client.quotaProjectId).toBe('searchunit-quota');
        expect(auth.quotaProject).toBe('searchunit-quota');
      },
    );
  });
  test('quota project order: GSC_QUOTA_PROJECT, then GOOGLE_CLOUD_QUOTA_PROJECT, then the service account project', async () => {
    expect(
      await withEnv(
        { GSC_QUOTA_PROJECT: 'gsc-proj', GOOGLE_CLOUD_QUOTA_PROJECT: 'cloud-proj' },
        () => resolveQuotaProject('sa-proj'),
      ),
    ).toEqual({ id: 'gsc-proj', invalid: false });
    expect(
      await withEnv(
        { GSC_QUOTA_PROJECT: undefined, GOOGLE_CLOUD_QUOTA_PROJECT: 'cloud-proj' },
        () => resolveQuotaProject('sa-proj'),
      ),
    ).toEqual({ id: 'cloud-proj', invalid: false });
    expect(
      await withEnv({ GSC_QUOTA_PROJECT: undefined, GOOGLE_CLOUD_QUOTA_PROJECT: undefined }, () =>
        resolveQuotaProject('sa-proj'),
      ),
    ).toEqual({ id: 'sa-proj', invalid: false });
  });
  test('an invalid quota project is skipped, and a 403 names the missing quota project', async () => {
    await withEnv({ GSC_QUOTA_PROJECT: 'Not A Project' }, async () => {
      const invalid = await runGscQuery({ mode: 'check', token: TOKEN, api: api() });

      expect(invalid).toEqual({ status: 'skipped', reason: 'quota-project-invalid' });
    });
    await withEnv({ GSC_QUOTA_PROJECT: undefined }, async () => {
      const missing = await runGscQuery({
        mode: 'performance',
        url: 'https://example.com/',
        token: TOKEN,
        api: api({
          async listSites() {
            throw new GscRequestError(
              403,
              'The searchconsole.googleapis.com API requires a quota project, which is not set by default.',
            );
          },
        }),
      });
      expect(missing).toMatchObject({
        status: 'skipped',
        reason: 'quota-project-missing',
        http: 403,
      });
    });
  });
  test('reads quota_project_id from Application Default Credentials', async () => {
    const { dir, file } = tempFile('adc.json', {
      type: 'authorized_user',
      quota_project_id: 'adc-quota-proj',
      client_secret: 'do-not-print',
    });
    try {
      const quota = await withEnv(
        {
          GSC_QUOTA_PROJECT: undefined,
          GOOGLE_CLOUD_QUOTA_PROJECT: undefined,
          GOOGLE_APPLICATION_CREDENTIALS: file,
        },
        () => resolveQuotaProject(),
      );

      expect(quota).toEqual({ id: 'adc-quota-proj', invalid: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('GSC_CREDENTIALS loads a read-only service account, not the ADC file', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const email = 'search-console-sa@example.iam.gserviceaccount.com';
    const { dir, file } = tempFile('credentials.json', {
      type: 'service_account',
      project_id: 'search-console-api',
      private_key_id: 'abc123',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: email,
    });
    try {
      const auth = await withEnv(
        {
          GSC_ACCESS_TOKEN: undefined,
          GSC_QUOTA_PROJECT: undefined,
          GOOGLE_CLOUD_QUOTA_PROJECT: undefined,
          GSC_CREDENTIALS: file,
          GOOGLE_APPLICATION_CREDENTIALS: MISSING_ADC,
        },
        () => gscAuth(),
      );

      expect('client' in auth).toBe(true);

      if (!('client' in auth)) {
        return;
      }

      const jwt = auth.client as InstanceType<typeof google.auth.JWT>;

      expect(jwt).toBeInstanceOf(google.auth.JWT);
      expect(jwt.email).toBe(email);
      expect(jwt.scopes).toEqual([GSC_SCOPE]);
      expect(jwt.quotaProjectId).toBe('search-console-api');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('stops URL inspection after a quota response', async () => {
    let inspects = 0;
    const result = await runGscQuery({
      mode: 'inspect',
      url: 'https://example.com/a',
      sample: ['https://example.com/b'],
      token: TOKEN,
      api: api({
        async listSites() {
          return [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
        },
        async inspect() {
          inspects += 1;

          throw new GscRequestError(429, 'quota');
        },
      }),
    });
    const inspections = result.inspections as { url: string; error: number; message: string }[];

    expect(inspects).toBe(1);
    expect(inspections).toEqual([{ url: 'https://example.com/a', error: 429, message: 'quota' }]);
    expect(result.indexedVersion).toBe(true);
  });
});

describe('gsc command', () => {
  test('check without a token skips and ignores --fail-on', async () => {
    const { code, out } = await withEnv(
      {
        GSC_ACCESS_TOKEN: undefined,
        GSC_CREDENTIALS: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: undefined,
      },
      () => captureLogs(() => runGsc('check', flags({ failOn: 'fail' }))),
    );

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      command: 'gsc',
      action: 'check',
      status: 'skipped',
      reason: 'token-missing',
    });
  });
  test.each([[undefined], ['inspect'], ['query-pages'], ['sitemaps']])(
    'action %s requires a URL',
    async (action) => {
      await expect(runGsc(action, flags())).rejects.toThrow('A URL is required');
    },
  );
  test('rejects extra check arguments and unknown actions with a suggestion', async () => {
    await expect(runGsc('check', flags({ rest: ['https://example.com'] }))).rejects.toThrow(
      'Too many arguments',
    );
    await expect(runGsc('inpect', flags({ rest: ['https://example.com/'] }))).rejects.toThrow(
      'Unknown command "inpect". Did you mean "inspect"?',
    );
    await expect(
      runGsc('sample-pages', flags({ rest: ['https://www.fogaonet.com/'] })),
    ).rejects.toThrow('Unknown command "sample-pages". Did you mean "sampled-pages"?');
  });
  test('a non-URL target reports bad-url and exits 0', async () => {
    const { code, out } = await captureLogs(() => runGsc('example.com', flags()));

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ reason: 'bad-url' });
  });
});

describe('renderGscTables', () => {
  test('drops control characters from Search Console text before the TTY', () => {
    const esc = String.fromCharCode(0x1b);
    const csi = String.fromCharCode(0x9b);
    const table = renderGscTables({
      status: 'ok',
      queries: { rows: [{ keys: [`shoes${esc}[2J${csi}now`], clicks: 1, impressions: 2 }] },
    });
    expect(table).toContain('shoes[2Jnow');
    expect(table).not.toContain(`${esc}[2J`);
    expect(table).not.toContain(csi);
  });
});
