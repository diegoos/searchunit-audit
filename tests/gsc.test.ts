import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { runGsc, renderGscTables } from '../src/commands/gsc.ts';
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];

    return;
  }

  process.env[name] = value;
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

describe('gsc helpers', () => {
  test('redacts access tokens and API keys', () => {
    const redacted = redact('Bearer ya29.secret AIzaSySecretkeyvalue123456');

    expect(redacted).not.toContain('ya29.');
    expect(redacted).not.toContain('AIza');
    expect(redacted).not.toContain('secret');
  });
  test('allows only the read-only scope set', () => {
    expect(
      unexpectedScopes([
        'openid',
        'email',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/cloud-platform',
        GSC_SCOPE,
      ]),
    ).toEqual([]);
    expect(unexpectedScopes([GSC_SCOPE, 'https://www.googleapis.com/auth/webmasters'])).toContain(
      'https://www.googleapis.com/auth/webmasters',
    );
    expect(unexpectedScopes([GSC_SCOPE, 'https://www.googleapis.com/auth/cloud-platform'])).toEqual(
      [],
    );
    expect(
      unexpectedScopes([GSC_SCOPE, 'https://www.googleapis.com/auth/analytics.readonly']),
    ).toContain('https://www.googleapis.com/auth/analytics.readonly');
  });
  test('rejects loopback, link-local, and userinfo URLs', () => {
    expect(safeAuditUrl('https://example.com/')).toBe('https://example.com/');
    expect(safeAuditUrl('http://127.0.0.1/')).toBe('');
    expect(safeAuditUrl('http://localhost:3000/')).toBe('');
    expect(safeAuditUrl('http://169.254.169.254/')).toBe('');
    expect(safeAuditUrl('https://user:pass@example.com/')).toBe('');
  });
  test('picks the longest URL-prefix, else the longest domain property', () => {
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
    expect(
      pickSite(
        [{ siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' }],
        'https://example.com/blog/post',
      ),
    ).toBe('https://www.example.com/');
  });
  test('builds a 28-day window ending three days before the PT date', () => {
    expect(gscWindow(new Date('2026-09-30T18:00:00Z'))).toEqual({
      startDate: '2026-08-31',
      endDate: '2026-09-27',
    });
    expect(gscWindow(new Date('2026-09-30T18:00:00Z'), { initDate: '2026-01-01' })).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(gscWindow(new Date('2026-09-30T18:00:00Z'), { endDate: '2026-01-31' })).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(
      gscWindow(new Date('2026-09-30T18:00:00Z'), {
        initDate: '2026-03-01',
        endDate: '2026-03-15',
      }),
    ).toEqual({
      startDate: '2026-03-01',
      endDate: '2026-03-15',
    });
  });
});

describe('runGscQuery', () => {
  test('skips when the token is missing and does not call Google', async () => {
    const previous = {
      token: process.env.GSC_ACCESS_TOKEN,
      credentials: process.env.GSC_CREDENTIALS,
      google: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    };
    delete process.env.GSC_ACCESS_TOKEN;
    delete process.env.GSC_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    let called = false;

    try {
      const result = await runGscQuery({
        mode: 'check',
        api: api({
          async listSites() {
            called = true;

            return [];
          },
        }),
      });
      expect(result).toEqual({ status: 'skipped', reason: 'token-missing' });
      expect(called).toBe(false);
    } finally {
      restoreEnv('GSC_ACCESS_TOKEN', previous.token);
      restoreEnv('GSC_CREDENTIALS', previous.credentials);
      restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', previous.google);
    }
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
  test('queries each sampled URL with one equals filter', async () => {
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
    const pageQueries = queries.filter(
      (call) => call.body.dimensions[0] === 'query' && call.body.dimensionFilterGroups,
    );

    expect(result).toMatchObject({
      status: 'ok',
      siteUrl: 'https://example.com/blog/',
      urls: ['https://example.com/blog/post', 'https://example.com/blog/other'],
      window: { startDate: '2026-08-31', endDate: '2026-09-27' },
    });
    expect(sampled).toHaveLength(2);
    expect(pageQueries).toHaveLength(2);
    expect(queries.some((call) => call.body.dimensions.join(',') === 'query,page')).toBe(true);
    expect(queries.some((call) => call.body.searchType === 'discover')).toBe(true);
    expect(queries.some((call) => call.body.searchType === 'googleNews')).toBe(true);

    for (const call of [...sampled, ...pageQueries]) {
      expect(call.body.dimensionFilterGroups).toHaveLength(1);
      expect(call.body.dimensionFilterGroups?.[0]?.filters).toHaveLength(1);
      expect(call.siteUrl).toBe('https://example.com/blog/');
    }

    const pageQueryPayload = result.pageQueries as { pages: { url: string; rows: unknown[] }[] };

    expect(pageQueryPayload.pages.map((page) => page.url)).toEqual([
      'https://example.com/blog/post',
      'https://example.com/blog/other',
    ]);
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
    expect(queries[0]?.dimensions).toEqual(['query', 'page']);
    expect(queries[0]?.startDate).toBe('2026-01-01');
    expect(queries[0]?.endDate).toBe('2026-01-31');
    expect(sitemaps).toBe(0);
    expect(result.queryPages).toEqual({ rows: [] });
    expect(result.pageQueries).toBeUndefined();
    expect(result.sitemaps).toBeUndefined();
  });
  test('sitemaps lists submitted sitemaps and skips Search Analytics', async () => {
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
  test('sets the quota project on the googleapis auth client', async () => {
    const previous = process.env.GSC_QUOTA_PROJECT;
    const googleQuota = process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    process.env.GSC_QUOTA_PROJECT = 'searchunit-quota';
    delete process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/searchunit-missing-adc.json';

    try {
      const auth = await gscAuth(TOKEN);

      expect('client' in auth).toBe(true);

      if (!('client' in auth)) {
        return;
      }

      expect(auth.client).toBeInstanceOf(google.auth.OAuth2);
      expect(auth.client).not.toBeInstanceOf(google.auth.JWT);
      expect(auth.client.quotaProjectId).toBe('searchunit-quota');
      expect(auth.quotaProject).toBe('searchunit-quota');
    } finally {
      restoreEnv('GSC_QUOTA_PROJECT', previous);
      restoreEnv('GOOGLE_CLOUD_QUOTA_PROJECT', googleQuota);
      restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', credentials);
    }
  });
  test('skips an invalid quota project and names a missing one on HTTP 403', async () => {
    const previous = process.env.GSC_QUOTA_PROJECT;

    process.env.GSC_QUOTA_PROJECT = 'Not A Project';

    try {
      const invalid = await runGscQuery({
        mode: 'check',
        token: TOKEN,
        api: api(),
      });
      expect(invalid).toEqual({ status: 'skipped', reason: 'quota-project-invalid' });
      delete process.env.GSC_QUOTA_PROJECT;
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
    } finally {
      restoreEnv('GSC_QUOTA_PROJECT', previous);
    }
  });
  test('reads quota_project_id from Application Default Credentials', () => {
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const quota = process.env.GSC_QUOTA_PROJECT;
    const googleQuota = process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    const dir = mkdtempSync(join(tmpdir(), 'searchunit-adc-'));
    const file = join(dir, 'adc.json');

    writeFileSync(
      file,
      JSON.stringify({
        type: 'authorized_user',
        quota_project_id: 'adc-quota-proj',
        client_secret: 'do-not-print',
      }),
    );

    try {
      delete process.env.GSC_QUOTA_PROJECT;
      delete process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
      expect(resolveQuotaProject()).toEqual({ id: 'adc-quota-proj', invalid: false });
    } finally {
      restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', credentials);
      restoreEnv('GSC_QUOTA_PROJECT', quota);
      restoreEnv('GOOGLE_CLOUD_QUOTA_PROJECT', googleQuota);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('loads a read-only service account through googleapis', async () => {
    const previous = {
      token: process.env.GSC_ACCESS_TOKEN,
      credentials: process.env.GSC_CREDENTIALS,
      google: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      quota: process.env.GSC_QUOTA_PROJECT,
      googleQuota: process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
    };
    const dir = mkdtempSync(join(tmpdir(), 'searchunit-sa-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const email = 'search-console-sa@example.iam.gserviceaccount.com';
    const file = join(dir, 'credentials.json');

    writeFileSync(
      file,
      JSON.stringify({
        type: 'service_account',
        project_id: 'search-console-api',
        private_key_id: 'abc123',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        client_email: email,
      }),
    );
    delete process.env.GSC_ACCESS_TOKEN;
    delete process.env.GSC_QUOTA_PROJECT;
    delete process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GSC_CREDENTIALS = file;

    try {
      const auth = await gscAuth();

      expect('client' in auth).toBe(true);

      if (!('client' in auth)) {
        return;
      }

      const jwt = auth.client as InstanceType<typeof google.auth.JWT>;

      expect(jwt).toBeInstanceOf(google.auth.JWT);
      expect(jwt.email).toBe(email);
      expect(jwt.keyId).toBe('abc123');
      expect(jwt.scopes).toEqual([GSC_SCOPE]);
      expect(jwt.quotaProjectId).toBe('search-console-api');
      expect(JSON.stringify({ email: jwt.email, scopes: jwt.scopes })).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(jwt.scopes)).not.toContain('indexing');
    } finally {
      restoreEnv('GSC_ACCESS_TOKEN', previous.token);
      restoreEnv('GSC_CREDENTIALS', previous.credentials);
      restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', previous.google);
      restoreEnv('GSC_QUOTA_PROJECT', previous.quota);
      restoreEnv('GOOGLE_CLOUD_QUOTA_PROJECT', previous.googleQuota);
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
  test('prints page rows in the table', () => {
    const table = renderGscTables({
      status: 'ok',
      siteUrl: 'sc-domain:example.com',
      pages: {
        rows: [
          {
            keys: ['https://example.com/a'],
            clicks: 2,
            impressions: 10,
            ctr: 0.2,
            position: 3.46,
          },
        ],
      },
    });
    expect(table).toContain('https://example.com/a');
    expect(table).toContain('Pages');
  });
  const previous = process.env.GSC_ACCESS_TOKEN;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.GSC_ACCESS_TOKEN;
    } else {
      process.env.GSC_ACCESS_TOKEN = previous;
    }
  });
  test('check without a token skips and ignores --fail-on', async () => {
    const credentials = process.env.GSC_CREDENTIALS;
    const google = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    delete process.env.GSC_ACCESS_TOKEN;
    delete process.env.GSC_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const logs: string[] = [];
    const original = console.log;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    try {
      const code = await runGsc('check', flags());
      const payload = JSON.parse(logs.join('\n')) as { status: string; reason: string };

      expect(code).toBe(0);
      expect(payload).toMatchObject({
        command: 'gsc',
        action: 'check',
        status: 'skipped',
        reason: 'token-missing',
      });
    } finally {
      console.log = original;
      restoreEnv('GSC_CREDENTIALS', credentials);
      restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', google);
    }
  });
  test('requires a URL and rejects extra check arguments', async () => {
    await expect(runGsc(undefined, flags())).rejects.toThrow('A URL is required');
    await expect(runGsc('check', flags({ rest: ['https://example.com'] }))).rejects.toThrow(
      'Too many arguments',
    );
    await expect(runGsc('inspect', flags())).rejects.toThrow('A URL is required');
    await expect(runGsc('query-pages', flags())).rejects.toThrow('A URL is required');
    await expect(runGsc('sitemaps', flags())).rejects.toThrow('A URL is required');
    await expect(runGsc('inpect', flags({ rest: ['https://example.com/'] }))).rejects.toThrow(
      'Unknown command "inpect". Did you mean "inspect"?',
    );
    await expect(
      runGsc('sample-pages', flags({ rest: ['https://www.fogaonet.com/'] })),
    ).rejects.toThrow('Unknown command "sample-pages". Did you mean "sampled-pages"?');

    const logs: string[] = [];
    const original = console.log;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    try {
      const code = await runGsc('example.com', flags());
      const payload = JSON.parse(logs.join('\n')) as { reason: string };

      expect(code).toBe(0);
      expect(payload.reason).toBe('bad-url');
    } finally {
      console.log = original;
    }
  });
});
