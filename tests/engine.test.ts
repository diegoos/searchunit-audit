import { describe, expect, test, beforeAll } from 'bun:test';
import chalk from 'chalk';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { classifyPage } from '../src/engine/pageClassification.ts';
import { parseRobotsTxt } from '../src/engine/robotsTxtParser.ts';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import { collectFindings } from '../src/engine/findings.ts';
import { parseRobots } from '../src/tools/robots/parseRobots.ts';
import { parseLlmsTxt } from '../src/tools/llmstxt/parseLlmsTxt.ts';
import { buildAuditReport } from '../src/engine/report.ts';
import { computeAuditScores, type CriticalBlocker } from '../src/engine/scoring.ts';
import { renderAudit } from '../src/render/audit.ts';
import type { DiscoveryBundle } from '../src/engine/discovery.ts';
import { PAGE_HTML, bundleFromHtml } from './engine-fixtures.ts';

beforeAll(() => {
  chalk.level = 0;
});

function blockerIds(bundle: DiscoveryBundle): string[] {
  const blockers: CriticalBlocker[] = [];

  computeAuditScores(bundle, blockers);

  return blockers.map((blocker) => blocker.id);
}

function technicalRow(bundle: DiscoveryBundle) {
  return computeAuditScores(bundle).breakdown.find(
    (row) => row.component === 'technical_foundations',
  );
}

function absentSitemap(): DiscoveryBundle['sitemap'] {
  return {
    present: false,
    fetchStatus: 'error',
    url_count: 0,
    audited_url_listed: false,
    audited_url_lastmod: null,
    urls: [],
    urlsTruncated: false,
    coverage: 'complete',
    filesRead: 0,
  };
}

describe('deterministic audit engine', () => {
  test('a fixture page has a breakdown per component and a findings list with schema, meta and robots', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const scores = computeAuditScores(bundle);

    expect(scores.breakdown).toHaveLength(5);

    for (const row of scores.breakdown) {
      expect(row.component).toBeTruthy();
      expect(row.display_name).toBeTruthy();
      expect(typeof row.weight).toBe('number');
      expect(['direct', 'mixed', 'indirect', 'lab', 'inferred', 'insufficient']).toContain(
        row.evidence_type,
      );
    }

    const report = buildAuditReport(bundle);

    expect(report).toMatchObject({ ok: true, command: 'audit', url: 'https://example.com/' });

    expect(report.fetchedAt).toBeDefined();
    expect(report.kindScores.overview.breakdown).toHaveLength(5);
    expect(report.kindScores).not.toHaveProperty('semantic');

    const findings = collectFindings(bundle, []);

    expect(findings.length).toBeGreaterThan(5);
    expect(findings[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        source: expect.any(String),
        severity: expect.any(String),
        title: expect.any(String),
        detail: expect.any(String),
      }),
    );
    expect(findings.some((f) => f.source === 'schema' || f.id.startsWith('schema'))).toBe(true);
    expect(findings.some((f) => f.source === 'meta')).toBe(true);
    expect(findings.some((f) => f.source === 'robots')).toBe(true);
  });
  test('JSON-LD that parses to no typed blocks blocks with no_structured_data', () => {
    const html = `<!doctype html><html><head><title>Empty schema</title>
      <script type="application/ld+json"></script></head>
      <body><h1>Hi</h1><p>${'word '.repeat(130)}</p></body></html>`;
    const bundle = bundleFromHtml(html);

    expect(bundle.auditedPage.structuredData.jsonld_blocks).toBeGreaterThan(0);
    expect(bundle.auditedPage.structuredData.blocks).toHaveLength(0);
    expect(blockerIds(bundle)).toContain('no_structured_data');
  });
  test('technical foundations is N/A without field CWV, so neither a missing CrUX nor a failed sitemap moves it', () => {
    const fetched = bundleFromHtml(PAGE_HTML);
    const failed = bundleFromHtml(PAGE_HTML);

    failed.sitemap = absentSitemap();
    failed.auditedPage.sitemapStatus = 'error';

    expect(technicalRow(fetched)?.evidence_type).toBe('insufficient');
    expect(technicalRow(fetched)?.score).toBeNull();
    expect(technicalRow(failed)?.score).toBeNull();
  });
  test.each([
    ['a googlebot meta noindex', 200],
    ['HTTP 404', 404],
    ['HTTP 302', 302],
  ])('%s blocks with noindex_or_error', (_name, status) => {
    const bundle = bundleFromHtml(
      status === 200
        ? PAGE_HTML.replace('</head>', '<meta name="googlebot" content="noindex"/></head>')
        : PAGE_HTML,
    );

    bundle.auditedPage.statusCode = status;
    expect(blockerIds(bundle)).toContain('noindex_or_error');

    if (status !== 200) {
      expect(renderAudit(buildAuditReport(bundle), 'table')).toMatch(/Indexable[^\n]*no/);
    }
  });
  test('origin-only poor CLS is ignored when URL-level vitals exist', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const good = { p75: 2000, rating: 'good' };
    const urlMetrics = {
      largest_contentful_paint: good,
      interaction_to_next_paint: { p75: 150, rating: 'good' },
      cumulative_layout_shift: { p75: null, rating: 'unknown' },
    };
    const originMetrics = {
      largest_contentful_paint: good,
      interaction_to_next_paint: { p75: 150, rating: 'good' },
      cumulative_layout_shift: { p75: 0.4, rating: 'poor' },
    };
    bundle.crux = {
      status: 'completed',
      errors: [],
      results: [
        {
          url: bundle.auditedUrl,
          origin: 'https://example.com',
          status: 'ok',
          url_data: { cwv_pass: true, metrics: urlMetrics },
          origin_data: { cwv_pass: false, metrics: originMetrics },
          errors: [],
        },
      ],
    };
    expect(blockerIds(bundle)).not.toContain('poor_core_web_vitals');
    expect(technicalRow(bundle)?.score).toBeGreaterThan(50);
  });
  test.each([
    [
      'robots',
      'robots:presence',
      (b: DiscoveryBundle) => {
        b.auditedPage.robotsStatus = 'error';
        b.parsedRobots = null;
      },
      'fetch_error',
      'warn',
    ],
    [
      'sitemap',
      'discovery:sitemap',
      (b: DiscoveryBundle) => {
        b.sitemap = absentSitemap();
        b.auditedPage.sitemapStatus = 'error';
      },
      'error',
      'warn',
    ],
  ])('%s fetch error is reported as a warn finding', (_name, id, mutate, detail, severity) => {
    const bundle = bundleFromHtml(PAGE_HTML);

    mutate(bundle);

    const finding = collectFindings(bundle, []).find((f) => f.id === id);

    expect(finding).toMatchObject({ detail, severity });
  });
  test('an empty robots.txt body is present, with a syntax check and no presence finding', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.auditedPage.robotsStatus = 'present';
    bundle.parsedRobots = parseRobots('');

    const findings = collectFindings(bundle, []);

    expect(findings.find((f) => f.id === 'robots:presence')).toBeUndefined();
    expect(findings.some((f) => f.id === 'robots:syntax')).toBe(true);
  });
  test('an empty llms.txt body is present, not absent', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.llmsTxt.exists = true;
    bundle.llmsTxt.fetchStatus = 'present';
    bundle.llmsTxt.content = '';

    const presence = collectFindings(bundle, []).find((f) => f.id === 'llms:presence');

    expect(presence?.detail).not.toBe('not_found');
    expect(presence?.severity).not.toBe('fail');
  });
  test('llms-full.txt alone emits llms-full findings while llms.txt stays not_found', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const fullBody = '# Site\n\n> Summary\n\n## Docs\n\n- [A](https://example.com/a.md)\n';

    bundle.llmsTxt.full_version = {
      url: 'https://example.com/llms-full.txt',
      exists: true,
      contentType: 'text/plain',
    };
    bundle.llmsTxt.full_content = fullBody;
    bundle.parsedLlmsFull = parseLlmsTxt(fullBody);
    bundle.llms_txt_status = deriveLlmsTxtStatus(bundle.llmsTxt);

    const findings = collectFindings(bundle, []);

    expect(findings.some((f) => f.source === 'llms-full')).toBe(true);
    expect(findings.find((f) => f.id === 'llms:presence')?.detail).toBe('not_found');
  });
  test('an llms.txt HTTP error reports fetch_error on the tool and error on discovery', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.llmsTxt.fetchStatus = 'error';
    bundle.llmsTxt.issues = [{ code: 'http_status', line: null, text: '403' }];
    bundle.llms_txt_status = deriveLlmsTxtStatus(bundle.llmsTxt);

    const findings = collectFindings(bundle, []);

    expect(findings.find((f) => f.id === 'llms:presence')).toMatchObject({
      detail: 'fetch_error',
      severity: 'warn',
    });
    expect(findings.find((f) => f.id === 'discovery:llms')).toMatchObject({
      detail: 'error',
      severity: 'warn',
    });
  });
  test('renders the table, json, html and markdown audit reports with the contract fields', () => {
    const report = buildAuditReport(bundleFromHtml(PAGE_HTML));
    const table = renderAudit(report, 'table');

    expect(table).toContain('Page Audit');
    expect(table).toContain('SEO Check');
    expect(table).toContain('GEO Check');
    expect(table).toContain('Google Profile');
    expect(table).toContain('Crawlers');
    expect(table).not.toContain('Brand authority');
    expect(table).not.toContain('semantic');

    const json = JSON.parse(renderAudit(report, 'json')) as {
      scores: { overall: number };
      findings: unknown[];
      seo: { scores: { overall: number } };
      geo: { scores: { overall: number } };
      googleProfile: { domain: string; profileUrl: string };
      kindScores: Record<string, unknown>;
      discovery: Record<string, unknown>;
    };
    expect(json.scores.overall).toBe(report.scores.overall);
    expect(json.findings.length).toBe(report.findings.length);
    expect(json.seo.scores.overall).toBe(report.seo.scores.overall);
    expect(json.geo.scores.overall).toBe(report.geo.scores.overall);
    expect(json.googleProfile).toMatchObject({ domain: 'example.com' });
    expect(json.googleProfile.profileUrl).toContain('profile.google.com');
    expect(json.discovery).toMatchObject({ auditedUrl: 'https://example.com/' });
    expect(json.discovery).not.toHaveProperty('pageHeaders');
    expect(json.discovery).not.toHaveProperty('parsedRobots');
    expect(json.kindScores).not.toHaveProperty('semantic');

    const html = renderAudit(report, 'html');

    expect(html).toContain('<table>');
    expect(html).toContain('<h2>SEO Check</h2>');
    expect(html).toContain('<h2>GEO Check</h2>');
    expect(html).toContain('<h2>Crawlers</h2>');
    expect(html).toContain('<h3>Discovery</h3>');

    const md = renderAudit(report, 'markdown');

    expect(md).toContain('| Component |');
    expect(md).toContain('## SEO Check');
    expect(md).toContain('## GEO Check');
    expect(md).toContain('## Crawlers');
    expect(md).toContain('## Google Profile');
    expect(md).toContain('### Discovery');
    expect(md).not.toContain('Brand authority');
    expect(md).not.toContain('| semantic |');
  });
  test('markdown export escapes remote heading and link syntax', () => {
    const report = buildAuditReport(bundleFromHtml(PAGE_HTML));

    report.seo.findings = [
      {
        id: 'x',
        source: 'schema',
        severity: 'fail',
        title: '# not a heading *star*',
        detail: '[link](https://evil.example) <img onerror=x>',
      },
    ];
    const md = renderAudit(report, 'markdown');

    expect(md).not.toMatch(/\n# not a heading/);
    expect(md).toContain('\\# not a heading \\*star\\*');
    expect(md).toContain('\\[link\\](https://evil.example)');
    expect(md).toContain('&lt;img');
    expect(md).toContain('## Kind scores');
  });
  test('a news URL with listing chrome is an article', () => {
    const cards = '<article class="card"><a href="/n">x</a></article>'.repeat(8);
    const html = `<html><head>
      <title>News</title>
      <meta property="og:type" content="article"/>
    </head><body><main>${cards}<p>${'word '.repeat(80)}</p></main></body></html>`;
    const parsed = parseHtmlPage(
      html,
      'https://g1.globo.com/politica/noticia/2026/09/10/pf-caso.ghtml',
    );

    expect(parsed.contentSignals.listingPattern).toBe(true);
    expect(classifyPage(parsed, 'https://example.com/page').pageKind).toBe('article');
  });
  test('control characters are stripped from table and markdown output, and pipes are escaped', () => {
    const report = buildAuditReport(bundleFromHtml(PAGE_HTML));

    report.seo.findings.push({
      id: 'test:csi',
      source: 'meta',
      severity: 'info',
      title: 'evil\u001b[31m',
      detail: 'pipe|break',
    });
    expect(renderAudit(report, 'table')).not.toContain('\u001b');

    const md = renderAudit(report, 'markdown');

    expect(md).not.toContain('\u001b');
    expect(md).toContain('pipe\\|break');
  });
  test('markdown groups findings by heading and clips long details', () => {
    const report = buildAuditReport(bundleFromHtml(PAGE_HTML));

    report.seo.findings = [
      {
        id: 'schema:0:type',
        source: 'schema:0',
        severity: 'pass',
        title: 'type',
        detail: 'CollectionPage',
      },
      {
        id: 'security:csp',
        source: 'security-headers',
        severity: 'warn',
        title: 'content-security-policy',
        detail: `default-src ${'https: '.repeat(80)}`,
      },
    ];
    const md = renderAudit(report, 'markdown');

    expect(md).toContain('### Schema: CollectionPage');
    expect(md).toContain('- **pass** type — CollectionPage');
    expect(md).toContain('### Security headers');
    expect(md).toContain('…');
    expect(md).not.toContain('https: '.repeat(80));
  });
  test('a grouped User-agent line blocks Googlebot and robots crawler rows stay off the tool findings', () => {
    const grouped = `User-agent: Googlebot\nUser-agent: *\nDisallow: /\n`;
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.parsedRobots = parseRobots(grouped);
    bundle.crawlerAccess = parseRobotsTxt(grouped, '/');

    expect(
      bundle.crawlerAccess.crawlers.find((crawler) => crawler.bot === 'Googlebot')?.status,
    ).toBe('blocked');

    const findings = collectFindings(bundle, []);

    expect(findings.some((f) => f.id.startsWith('robots:crawler:'))).toBe(false);
    expect(findings.some((f) => f.source === 'robots')).toBe(true);
  });
});
