import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { MECHANICAL_SLUGS } from '../scripts/audit-vocabulary.mjs';

const SCRIPT = new URL('../scripts/prefill-checks.mjs', import.meta.url).pathname;

interface Row {
  slug: string;
  result: string;
  evidence: string;
  note: string;
}

type Payload = Record<string, any>;

/** A payload where the CLI decides most mechanical slugs. Each test changes one part of it. */
function payload(): Payload {
  return {
    command: 'audit',
    url: 'https://www.test.com/post',
    findings: [
      { id: 'discovery:redirects', severity: 'pass' },
      { id: 'content:url-structure', severity: 'info' },
      { id: 'meta:charset', severity: 'pass' },
    ],
    blockers: [],
    cruxApiKeyAvailable: false,
    lighthouse: { status: 'skipped', reason: 'binary-missing' },
    discovery: {
      sitemap: {
        fetchStatus: 'present',
        audited_url_listed: true,
        coverage: 'complete',
        filesRead: 1,
      },
      mobilePage: null,
      mobileFetchError: 'timeout',
      auditedPage: {
        title: 'Widgets for teams',
        viewport: false,
        byteLength: 1000,
        hasSpeakable: false,
        pageKind: 'article',
        siteType: 'publisher',
        headings: { h1Count: 0, h1ElementCount: 1, h2: [], h3: [], outline: [] },
        contentSignals: { question_heading_count: 0 },
        structuredData: { types: ['Article'] },
        markupFormats: { microdata_types: [], rdfa_types: [], jsonld_blocks_missing_type: 0 },
        pagination: {},
        hreflangLinks: [],
        headerHreflang: [],
        social: {
          openGraph: {
            title: 'Widgets for teams',
            image: 'https://www.test.com/og.png',
            type: 'article',
          },
          twitter: { card: 'summary' },
        },
      },
    },
  };
}

/** Runs the script on the payload in a temp dir, with `files` next to it, and returns the rows. */
function prefill(
  cli: Record<string, unknown>,
  extraArgs: string[] = [],
  files: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'su-prefill-'));
  const cliPath = join(dir, 'cli-audit.json');

  writeFileSync(cliPath, JSON.stringify(cli));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }

  const result = spawnSync('node', [SCRIPT, '--cli', cliPath, ...extraArgs], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const outPath = join(dir, 'checks-prefill.json');
  const rows: Row[] | null = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;

  return { status: result.status, stderr: result.stderr, rows, dir };
}

function rowFor(rows: Row[] | null, slug: string): Row | undefined {
  return rows?.find((row) => row.slug === slug);
}

function withPage(change: Record<string, unknown>, cli = payload()): Payload {
  return {
    ...cli,
    discovery: { ...cli.discovery, auditedPage: { ...cli.discovery.auditedPage, ...change } },
  };
}

function withDiscovery(change: Record<string, unknown>): Payload {
  return { ...payload(), discovery: { ...payload().discovery, ...change } };
}

const { status: PAGE_STATUS, rows: PAGE_ROWS } = prefill(payload());

describe('prefill-checks decides the slugs the payload decides', () => {
  test('the payload writes a file', () => {
    expect(PAGE_STATUS).toBe(0);
    expect(PAGE_ROWS?.length).toBeGreaterThan(0);
  });

  test.each([
    ['viewport', { result: 'observed', evidence: 'direct' }],
    ['redirects', { result: 'not observed' }],
    ['sitemap-url', { result: 'not observed' }],
    ['html-bytes', { result: 'not observed' }],
    ['speakable', { result: 'observed' }],
    ['crux', { result: 'insufficient' }],
    ['lighthouse-lab', { result: 'insufficient', evidence: 'insufficient' }],
    ['mobile-parity', { result: 'insufficient' }],
    ['pagination', { result: 'not observed' }],
    ['hreflang', { result: 'not observed' }],
    ['h1-text', { result: 'observed', note: 'H1 element present with no text.' }],
    ['question-headings', { result: 'observed' }],
    ['schema-inventory', { result: 'not observed', note: 'JSON-LD types: "Article".' }],
    ['social-tags', { result: 'not observed' }],
    ['llms-txt', { result: 'not observed' }],
    ['url-structure', { result: 'observed' }],
    ['backlinks', { result: 'insufficient' }],
    ['crawl-logs', { result: 'insufficient' }],
    ['observed-citations', { result: 'insufficient' }],
    ['conversions', { result: 'insufficient' }],
    ['gbp-nap', { result: 'not observed' }],
  ])('%s has the expected row', (slug, expected) => {
    expect(rowFor(PAGE_ROWS, slug)).toMatchObject(expected);
  });

  test('only slugs from MECHANICAL_SLUGS are written', () => {
    const mechanical = new Set<string>(MECHANICAL_SLUGS);

    for (const row of PAGE_ROWS ?? []) {
      expect(mechanical.has(row.slug)).toBe(true);
    }
  });

  test('each row has the four fields the validator reads', () => {
    for (const row of PAGE_ROWS ?? []) {
      expect(Object.keys(row).sort()).toEqual(['evidence', 'note', 'result', 'slug']);
    }
  });
});

describe('prefill-checks leaves undecided slugs out', () => {
  test.each([
    [
      'html-bytes is undecided above 2 MiB with no blocker',
      withPage({ byteLength: 3 * 1024 * 1024 }),
      'html-bytes',
    ],
    [
      'a local-business site type leaves gbp-nap to the intake',
      withPage({ siteType: 'local-business' }),
      'gbp-nap',
    ],
    [
      'pagination is undecided when a next link is present',
      withPage({ pagination: { next: 'https://www.test.com/post/2' } }),
      'pagination',
    ],
    [
      'hreflang is undecided when the page has hreflang markup',
      withPage({ hreflangLinks: [{ lang: 'en', href: 'https://www.test.com/post' }] }),
      'hreflang',
    ],
  ])('%s', (_, cli, slug) => {
    expect(rowFor(prefill(cli).rows, slug)).toBeUndefined();
  });
});

type ObservedCase = [string, Payload, string, Partial<Row>];

const OBSERVED_CASES: ObservedCase[] = [
  [
    'crux is observed only with the poor_core_web_vitals blocker',
    { ...withPage({}), cruxApiKeyAvailable: true, blockers: [{ id: 'poor_core_web_vitals' }] },
    'crux',
    { result: 'observed', evidence: 'direct' },
  ],
  [
    'crux is insufficient when the CLI skipped CrUX with a key, as on a loopback URL',
    {
      ...withDiscovery({ crux: { status: 'skipped', results: [], errors: [] } }),
      cruxApiKeyAvailable: true,
    },
    'crux',
    { result: 'insufficient', evidence: 'insufficient' },
  ],
  [
    'meta:og_url belongs to canonical, so it does not flag social-tags',
    { ...payload(), findings: [{ id: 'meta:og_url', severity: 'warn' }] },
    'social-tags',
    { result: 'not observed' },
  ],
  [
    'a sitemap that is missing from the audited URL is observed',
    withDiscovery({
      sitemap: {
        fetchStatus: 'present',
        audited_url_listed: false,
        coverage: 'complete',
        filesRead: 1,
      },
    }),
    'sitemap-url',
    { result: 'observed', evidence: 'direct' },
  ],
  [
    'a partial sitemap read is insufficient',
    withDiscovery({
      sitemap: {
        fetchStatus: 'present',
        audited_url_listed: false,
        coverage: 'partial',
        filesRead: 25,
      },
    }),
    'sitemap-url',
    { result: 'insufficient', evidence: 'insufficient' },
  ],
  [
    'a warn on discovery:redirects is observed',
    { ...payload(), findings: [{ id: 'discovery:redirects', severity: 'warn' }] },
    'redirects',
    { result: 'observed' },
  ],
  [
    'a listing page with no pagination links is observed',
    withPage({ pageKind: 'listing', pagination: {} }),
    'pagination',
    { result: 'observed' },
  ],
  [
    'a failed Lighthouse run is insufficient with its reason',
    { ...payload(), lighthouse: { status: 'error', reason: 'timeout' } },
    'lighthouse-lab',
    { note: 'Lighthouse error: timeout.' },
  ],
  [
    'a Lighthouse run with failed audits lists their ids',
    {
      ...payload(),
      lighthouse: {
        status: 'ok',
        failedAudits: [{ id: 'unsized-images' }, { id: 'uses-webp-images' }],
      },
    },
    'lighthouse-lab',
    {
      result: 'observed',
      evidence: 'lab',
      note: 'Lighthouse failed audits: unsized-images, uses-webp-images.',
    },
  ],
  [
    'a heading-order finding makes heading-hierarchy observed',
    {
      ...payload(),
      findings: [...payload().findings, { id: 'content:heading-order', severity: 'warn' }],
    },
    'heading-hierarchy',
    { result: 'observed' },
  ],
  [
    'a null Open Graph field makes social-tags observed',
    withPage({
      social: {
        openGraph: { title: 'Widgets for teams', image: null, type: 'article' },
        twitter: { card: 'summary' },
      },
    }),
    'social-tags',
    { result: 'observed', note: 'Missing social tag: og:image.' },
  ],
  [
    'a JSON-LD block with no @type makes schema-inventory observed',
    withPage({
      markupFormats: { microdata_types: [], rdfa_types: [], jsonld_blocks_missing_type: 1 },
    }),
    'schema-inventory',
    { result: 'observed', note: '1 JSON-LD block(s) with no @type.' },
  ],
  [
    'a missing mobile snapshot is insufficient with its fetch error',
    payload(),
    'mobile-parity',
    { note: 'No mobile snapshot: timeout.' },
  ],
];

describe('prefill-checks reads the findings and the page', () => {
  test.each(OBSERVED_CASES)('%s', (_, cli, slug, expected) => {
    expect(rowFor(prefill(cli).rows, slug)).toMatchObject(expected);
  });

  test('a url-structure finding of warn is observed, and pass is not', () => {
    const cli = payload();

    cli.findings[1].severity = 'warn';
    expect(rowFor(prefill(cli).rows, 'url-structure')).toMatchObject({ result: 'observed' });

    cli.findings[1].severity = 'pass';
    expect(rowFor(prefill(cli).rows, 'url-structure')).toMatchObject({ result: 'not observed' });
  });
});

describe('prefill-checks command line', () => {
  test('a missing --cli exits 1 with usage', () => {
    const result = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 10_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: prefill-checks.mjs --cli');
  });

  test('--out writes the rows to the given path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'su-prefill-out-'));
    const cliPath = join(dir, 'cli-audit.json');
    const outPath = join(dir, 'custom.json');

    writeFileSync(cliPath, JSON.stringify(payload()));

    const result = spawnSync('node', [SCRIPT, '--cli', cliPath, '--out', outPath], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });
});

const ALLOWED_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'Bingbot', 'Googlebot'].map((bot) => ({
  bot,
  status: 'allowed',
}));
const SECURITY_PASS = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
].map((id) => ({ id: `security:${id}`, severity: 'pass' }));

/** A public https page that every new rule can decide, with one part changed. */
function runPayload(change: { page?: Payload; discovery?: Payload; root?: Payload } = {}): Payload {
  const base = withPage({
    url: 'https://www.test.com/post',
    title: 'Widgets for small teams that ship new product every week',
    metaDescription:
      'Widgets for small teams: pricing, setup, and support for the tools that ship every week, with guides, answers, and a free plan to try first.',
    contentSignals: { question_heading_count: 1, hasTopSummary: false },
    trustPages: { about: 'https://www.test.com/about' },
    structuredData: {
      types: ['Organization'],
      blocks: [{ type: 'Organization', sameAs: ['https://www.linkedin.com/company/test'] }],
    },
    ...change.page,
  });

  return {
    ...base,
    findings: [...SECURITY_PASS, { id: 'content:mixed-content', severity: 'pass' }],
    ...change.root,
    discovery: {
      ...base.discovery,
      crawlerAccess: { crawlers: ALLOWED_BOTS },
      platform_signals: { faq_pattern: false },
      ...change.discovery,
    },
  };
}

type RunCase = [string, Payload, Record<string, unknown>, string, Partial<Row>];

const RUN_CASES: RunCase[] = [
  ['every catalog crawler allowed', runPayload(), {}, 'crawler-access', { result: 'not observed' }],
  [
    'a restricted crawler',
    runPayload({
      discovery: {
        crawlerAccess: { crawlers: [...ALLOWED_BOTS, { bot: 'GPTBot', status: 'restricted' }] },
      },
    }),
    {},
    'crawler-access',
    { result: 'observed', note: 'Not allowed: GPTBot restricted.' },
  ],
  ['an https page with no mixed content', runPayload(), {}, 'https', { result: 'not observed' }],
  [
    'an http final URL',
    runPayload({ page: { url: 'http://www.test.com/post' } }),
    {},
    'https',
    { result: 'observed' },
  ],
  [
    'mixed content on the https page',
    runPayload({
      root: { findings: [...SECURITY_PASS, { id: 'content:mixed-content', severity: 'fail' }] },
    }),
    {},
    'https',
    { result: 'observed' },
  ],
  [
    'a loopback URL whose discovery:https warns',
    runPayload({
      page: { url: 'http://localhost:3000/' },
      root: { findings: [...SECURITY_PASS, { id: 'discovery:https', severity: 'warn' }] },
    }),
    {},
    'https',
    { result: 'observed' },
  ],
  ['five security headers pass', runPayload(), {}, 'iframe-header', { result: 'not observed' }],
  [
    'a missing X-Frame-Options header',
    runPayload({
      root: {
        findings: [
          ...SECURITY_PASS.filter((item) => item.id !== 'security:x-frame-options'),
          { id: 'security:x-frame-options', severity: 'fail' },
        ],
      },
    }),
    {},
    'iframe-header',
    { result: 'observed', note: 'Missing or weak: x-frame-options.' },
  ],
  [
    'a title inside the band',
    runPayload(),
    {},
    'title-length-uniqueness',
    { result: 'not observed' },
  ],
  [
    'a short title',
    runPayload({ page: { title: 'Widgets' } }),
    {},
    'title-length-uniqueness',
    { result: 'observed', note: 'Title is 7 characters, outside 50-60.' },
  ],
  [
    'a title a context URL repeats',
    runPayload(),
    {
      'cli-seo-1.json': {
        discovery: {
          auditedPage: {
            url: 'https://www.test.com/other',
            title: 'Widgets for small teams that ship new product every week',
          },
        },
      },
    },
    'title-length-uniqueness',
    { result: 'observed', note: 'Title repeats on a context URL: https://www.test.com/other.' },
  ],
  [
    'an empty meta description',
    runPayload({ page: { metaDescription: '' } }),
    {},
    'meta-length-uniqueness',
    { result: 'observed' },
  ],
  [
    'a meta description inside the band',
    runPayload(),
    {},
    'meta-length-uniqueness',
    { result: 'not observed' },
  ],
  [
    'no answer format at all',
    runPayload({ page: { contentSignals: { question_heading_count: 0, hasTopSummary: false } } }),
    {},
    'platform-aio',
    { result: 'observed' },
  ],
  ['a question heading', runPayload(), {}, 'platform-aio', { result: 'not observed' }],
  [
    'allowed bots and a named entity',
    runPayload(),
    {},
    'platform-chatgpt',
    { result: 'not observed' },
  ],
  [
    'no entity type and no about page',
    runPayload({
      page: { structuredData: { types: [], blocks: [] }, trustPages: { about: null } },
    }),
    {},
    'platform-chatgpt',
    { result: 'observed' },
  ],
  [
    'an entity with a LinkedIn sameAs',
    runPayload(),
    {},
    'platform-copilot',
    { result: 'not observed' },
  ],
  [
    'an entity with no LinkedIn or GitHub sameAs',
    runPayload({
      page: {
        structuredData: { types: ['Organization'], blocks: [{ type: 'Organization', sameAs: [] }] },
      },
    }),
    {},
    'platform-copilot',
    { result: 'observed' },
  ],
  [
    'a public https sameAs',
    runPayload(),
    {},
    'same-as',
    { result: 'not observed', evidence: 'proxy' },
  ],
  [
    'a sameAs on a private host',
    runPayload({
      page: {
        structuredData: {
          types: ['Organization'],
          blocks: [
            { type: 'Organization', sameAs: ['https://192.168.0.10/profile', 'http://x.com/a'] },
          ],
        },
      },
    }),
    {},
    'same-as',
    { result: 'observed', evidence: 'direct' },
  ],
  [
    'a sameAs on a link-local IPv6 host',
    runPayload({
      page: {
        structuredData: {
          types: ['Organization'],
          blocks: [{ type: 'Organization', sameAs: ['https://[fe90::1]/profile'] }],
        },
      },
    }),
    {},
    'same-as',
    { result: 'observed', evidence: 'direct' },
  ],
  [
    'a sameAs on a ULA IPv6 host',
    runPayload({
      page: {
        structuredData: {
          types: ['Organization'],
          blocks: [{ type: 'Organization', sameAs: ['https://[fc00::1]/profile'] }],
        },
      },
    }),
    {},
    'same-as',
    { result: 'observed', evidence: 'direct' },
  ],
  ...['https://[::7f00:1]/p', 'https://[ff02::1]/p', 'https://240.1.2.3/p'].map((url): RunCase => [
    `a sameAs on ${url}`,
    runPayload({
      page: {
        structuredData: {
          types: ['Organization'],
          blocks: [{ type: 'Organization', sameAs: [url] }],
        },
      },
    }),
    {},
    'same-as',
    { result: 'observed', evidence: 'direct' },
  ]),
  [
    'a sameAs on a carrier-grade NAT host',
    runPayload({
      page: {
        structuredData: {
          types: ['Organization'],
          blocks: [{ type: 'Organization', sameAs: ['https://100.100.0.1/profile'] }],
        },
      },
    }),
    {},
    'same-as',
    { result: 'observed', evidence: 'direct' },
  ],
  [
    'no Search Console file',
    runPayload(),
    {},
    'cannibalization',
    { result: 'insufficient', evidence: 'insufficient' },
  ],
  [
    'one query with impressions on two pages',
    runPayload(),
    {
      'gsc-performance.json': {
        queryPages: {
          rows: [
            { keys: ['widgets', 'https://www.test.com/a'], impressions: 10 },
            { keys: ['widgets', 'https://www.test.com/b'], impressions: 4 },
          ],
        },
      },
    },
    'cannibalization',
    { result: 'observed', note: 'Queries with impressions on more than one page: "widgets".' },
  ],
  [
    'no inspection file',
    runPayload(),
    {},
    'url-inspection',
    { result: 'insufficient', evidence: 'insufficient' },
  ],
];

describe('prefill-checks decides the anchored slugs from the run files', () => {
  test.each(RUN_CASES)('%s', (_name, cli, files, slug, expected) => {
    expect(rowFor(prefill(cli, [], files).rows, slug)).toMatchObject(expected);
  });

  test.each([
    [
      'iframe-header with no security finding',
      withPage({ url: 'https://www.test.com/' }),
      'iframe-header',
    ],
    [
      'https on a loopback URL with an info discovery:https',
      runPayload({
        page: { url: 'http://localhost:3000/' },
        root: { findings: [...SECURITY_PASS, { id: 'discovery:https', severity: 'info' }] },
      }),
      'https',
    ],
    ['url-inspection with an inspection file', runPayload(), 'url-inspection'],
  ])('%s stays with the worker', (_name, cli, slug) => {
    const files = slug === 'url-inspection' ? { 'gsc-inspect.json': { inspections: [] } } : {};

    expect(rowFor(prefill(cli, [], files).rows, slug)).toBeUndefined();
  });
});
