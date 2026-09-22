import { describe, expect, test, beforeAll } from 'bun:test';
import chalk from 'chalk';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { classifyPage } from '../src/engine/pageClassification.ts';
import { parseRobotsTxt } from '../src/engine/robotsTxtParser.ts';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import { collectFindings, auditThresholdStatus } from '../src/engine/findings.ts';
import { parseRobots } from '../src/tools/robots/parseRobots.ts';
import { parseLlmsTxt } from '../src/tools/llmstxt/parseLlmsTxt.ts';
import { buildAuditReport } from '../src/engine/report.ts';
import { computeAuditScores } from '../src/engine/scoring.ts';
import { renderAudit } from '../src/render/audit.ts';
import { PAGE_HTML, bundleFromHtml, collectCriticalBlockers } from './engine-fixtures.ts';

beforeAll(() => {
  chalk.level = 0;
});

describe('deterministic audit engine', () => {
  test('scores a fixture page and lists findings', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const scores = computeAuditScores(bundle);

    expect(scores.overall).toBe(67);
    expect(scores.label).toBe('Moderate');
    expect(scores.confidence).toBe('low');
    expect(scores.evidence_quality).toBeDefined();
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

    expect(report.ok).toBe(true);
    expect(report.command).toBe('audit');
    expect(report.url).toBe('https://example.com/');
    expect(report.fetchedAt).toBeDefined();
    expect(report.kindScores.overview.breakdown).toHaveLength(5);
    expect(report.kindScores.geo.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'platform_optimization',
    ]);
    expect(report.kindScores.seo.breakdown.map((row) => row.component)).toEqual([
      'content_quality',
      'technical_foundations',
      'structured_data',
    ]);
    expect(report.kindScores).not.toHaveProperty('semantic');
    const blockers = collectCriticalBlockers(bundle);
    const findings = collectFindings(bundle, blockers);

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
  test('caps structured_data when JSON-LD scripts parse to no typed blocks', () => {
    const html = `<!doctype html><html><head><title>Empty schema</title>
      <script type="application/ld+json"></script></head>
      <body><h1>Hi</h1><p>${'word '.repeat(130)}</p></body></html>`;
    const bundle = bundleFromHtml(html);

    expect(bundle.auditedPage.structuredData.jsonld_blocks).toBeGreaterThan(0);
    expect(bundle.auditedPage.structuredData.blocks).toHaveLength(0);
    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'no_structured_data')).toBe(true);
  });
  test('poor CLS emits poor_core_web_vitals', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const metrics = {
      largest_contentful_paint: { p75: 2000, rating: 'good' },
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
          url_data: { cwv_pass: false, metrics },
          origin_data: null,
          errors: [],
        },
      ],
    };
    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'poor_core_web_vitals')).toBe(true);
  });
  test('technical evidence is insufficient when CrUX is absent', () => {
    const scores = computeAuditScores(bundleFromHtml(PAGE_HTML));
    const tech = scores.breakdown.find((row) => row.component === 'technical_foundations');

    expect(tech?.evidence_type).toBe('insufficient');
  });
  test('does not credit a robots Sitemap that failed to fetch', () => {
    const fetched = bundleFromHtml(PAGE_HTML);
    const failed = bundleFromHtml(PAGE_HTML);

    failed.sitemap = {
      present: false,
      fetchStatus: 'error',
      url_count: 0,
      audited_url_listed: false,
      audited_url_lastmod: null,
    };
    failed.auditedPage.sitemapStatus = 'error';
    const fetchedTech = computeAuditScores(fetched).breakdown.find(
      (row) => row.component === 'technical_foundations',
    );
    const failedTech = computeAuditScores(failed).breakdown.find(
      (row) => row.component === 'technical_foundations',
    );

    expect(fetched.crawlerAccess.sitemaps.length).toBeGreaterThan(0);
    expect(failed.crawlerAccess.sitemaps.length).toBeGreaterThan(0);
    expect(failedTech?.score).toBeLessThan(fetchedTech?.score ?? 0);
  });
  test('googlebot meta noindex emits noindex_or_error', () => {
    const html = PAGE_HTML.replace('</head>', '<meta name="googlebot" content="noindex"/></head>');
    const bundle = bundleFromHtml(html);

    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'noindex_or_error')).toBe(true);
  });
  test('table Indexable is no when the page status is 404', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.auditedPage.statusCode = 404;
    const table = renderAudit(buildAuditReport(bundle), 'table');

    expect(table).toMatch(/Indexable[^\n]*no/);
    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'noindex_or_error')).toBe(true);
  });
  test('HTTP 302 emits noindex_or_error and Indexable no', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.auditedPage.statusCode = 302;
    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'noindex_or_error')).toBe(true);
    expect(renderAudit(buildAuditReport(bundle), 'table')).toMatch(/Indexable[^\n]*no/);
  });
  test('poor CLS at origin is ignored when URL-level vitals exist', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const urlMetrics = {
      largest_contentful_paint: { p75: 2000, rating: 'good' },
      interaction_to_next_paint: { p75: 150, rating: 'good' },
      cumulative_layout_shift: { p75: null, rating: 'unknown' },
    };
    const originMetrics = {
      largest_contentful_paint: { p75: 2000, rating: 'good' },
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
    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'poor_core_web_vitals')).toBe(
      false,
    );
    const tech = computeAuditScores(bundle).breakdown.find(
      (row) => row.component === 'technical_foundations',
    );

    expect(tech?.score).not.toBeNull();
    expect((tech?.score ?? 0) > 50).toBe(true);
  });
  test('robots tool findings use fetch_error when discovery robotsStatus is error', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.auditedPage.robotsStatus = 'error';
    bundle.parsedRobots = null;
    const findings = collectFindings(bundle, []);
    const presence = findings.find((f) => f.id === 'robots:presence');

    expect(presence?.detail).toBe('fetch_error');
    expect(presence?.severity).toBe('warn');
  });
  test('empty robots.txt body is present, not not_found', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.auditedPage.robotsStatus = 'present';
    bundle.parsedRobots = parseRobots('');
    const findings = collectFindings(bundle, []);
    const presence = findings.find((f) => f.id === 'robots:presence');

    expect(presence).toBeUndefined();
    expect(findings.some((f) => f.id === 'robots:syntax')).toBe(true);
  });
  test('empty llms.txt body is present, not absent', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.llmsTxt.exists = true;
    bundle.llmsTxt.fetchStatus = 'present';
    bundle.llmsTxt.content = '';
    const findings = collectFindings(bundle, []);
    const presence = findings.find((f) => f.id === 'llms:presence');

    expect(presence?.detail).not.toBe('not_found');
    expect(presence?.severity).not.toBe('fail');
  });
  test('emits llms-full findings when only llms-full.txt is present', () => {
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
  test('llms tool findings use fetch_error when llms.txt HTTP is error', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.llmsTxt.exists = false;
    bundle.llmsTxt.fetchStatus = 'error';
    bundle.llmsTxt.issues = ['llms.txt returned status 403'];
    bundle.llms_txt_status = deriveLlmsTxtStatus(bundle.llmsTxt);
    const findings = collectFindings(bundle, []);
    const presence = findings.find((f) => f.id === 'llms:presence');
    const discoveryLlms = findings.find((f) => f.id === 'discovery:llms');

    expect(presence?.detail).toBe('fetch_error');
    expect(presence?.severity).toBe('warn');
    expect(discoveryLlms?.detail).toBe('error');
    expect(discoveryLlms?.severity).toBe('warn');
  });
  test('discovery sitemap finding uses error when fetchStatus is error', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.sitemap = {
      present: false,
      fetchStatus: 'error',
      url_count: 0,
      audited_url_listed: false,
      audited_url_lastmod: null,
    };
    bundle.auditedPage.sitemapStatus = 'error';
    const findings = collectFindings(bundle, []);
    const sitemap = findings.find((f) => f.id === 'discovery:sitemap');

    expect(sitemap?.detail).toBe('error');
    expect(sitemap?.severity).toBe('warn');
  });
  test('renders table json html and markdown', () => {
    const report = buildAuditReport(bundleFromHtml(PAGE_HTML));
    const table = renderAudit(report, 'table');

    expect(table).toContain('Site Audit');
    expect(table).toMatch(/Site Audit[^\n]*\n\nhttps:\/\/example.com\//);
    expect(table).toContain('Component');
    expect(table).toContain('Score');
    expect(table).toContain(String(report.scores.overall));
    expect(table).toContain('Title');
    expect(table).toContain('chars');
    expect(table).toContain('Indexable');
    expect(table).toContain('ok pass');
    expect(table).toContain('Discovery');
    expect(table).toContain('Schema');
    expect(table).toContain('valid JSON');
    expect(table).toContain('http→https=no');
    expect(table).toContain('SEO Check');
    expect(table).toContain('GEO Check');
    expect(table).toContain('Google Profile');
    expect(table).toContain('ChatGPT-User');
    expect(table).toContain('PerplexityBot');
    expect(table).toContain('Google-Extended');
    expect(table).toContain('AI citability');
    expect(table).not.toContain('Brand authority');
    expect(table).toContain('H1');
    expect(table).toContain('Page citability');
    expect(table).not.toContain('AI visibility');
    expect(table).not.toContain('Citabilidade');
    expect(table).not.toContain('Cited');
    expect(table).not.toContain('Missing');
    expect(table).not.toContain('generative');

    const json = JSON.parse(renderAudit(report, 'json')) as {
      scores: { overall: number };
      findings: unknown[];
      seo: { scores: { overall: number }; findings: unknown[] };
      geo: { scores: { overall: number }; findings: unknown[] };
      googleProfile: { domain: string; profileUrl: string };
      kindScores: Record<string, { value: number | null }>;
      discovery: Record<string, unknown>;
    };
    expect(json.scores.overall).toBe(report.scores.overall);
    expect(json.findings.length).toBe(report.findings.length);
    expect(json.seo.scores.overall).toBe(report.seo.scores.overall);
    expect(json.geo.scores.overall).toBe(report.geo.scores.overall);
    expect(json.googleProfile.domain).toBe('example.com');
    expect(json.googleProfile.profileUrl).toContain('profile.google.com');
    expect(json.discovery.pageHeaders).toBeUndefined();
    expect(json.discovery.parsedRobots).toBeUndefined();
    expect(json.discovery.auditedUrl).toBe('https://example.com/');

    const html = renderAudit(report, 'html');

    expect(html).toContain('<table>');
    expect(html).toContain('Site Audit');

    const md = renderAudit(report, 'markdown');

    expect(md).toContain('| Component |');
    expect(md).toContain('## SEO Check');
    expect(md).toContain('## GEO Check');
    expect(md).toContain('## Crawlers');
    expect(md).toContain('## Google Profile');
    expect(md).toContain('| ChatGPT-User |');
    expect(md).not.toContain('Brand authority');
    expect(md).not.toContain('| semantic |');
    expect(md).toContain('### Discovery');
    expect(md).toContain('- **');
    expect(md).not.toContain('| Status | Title | Detail |');
    expect(html).toContain('<h2>SEO Check</h2>');
    expect(html).toContain('<h2>GEO Check</h2>');
    expect(html).toContain('<h2>Crawlers</h2>');
    expect(html).toContain('<h3>Discovery</h3>');
    expect(table).not.toContain('semantic');
    expect(json.kindScores).not.toHaveProperty('semantic');
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
    expect(renderAudit(report, 'html')).toContain('<h2>Kind scores</h2>');
  });
  test('classifies a news URL with listing chrome as an article', () => {
    const cards = '<article class="card"><a href="/n">x</a></article>'.repeat(8);
    const html = `<html><head>
      <title>News</title>
      <meta property="og:type" content="article"/>

    </head><body><main>${cards}<p>${'word '.repeat(80)}</p></main></body></html>`;
    const url = 'https://g1.globo.com/politica/noticia/2026/09/10/pf-caso.ghtml';
    const parsed = parseHtmlPage(html, url);

    expect(parsed.contentSignals.listingPattern).toBe(true);
    expect(classifyPage(parsed).pageKind).toBe('article');
  });
  test('title KPI follows the meta-check length status', () => {
    const html = PAGE_HTML.replace(
      'Example Company widgets for operations teams worldwide',
      'A'.repeat(95),
    );
    const table = renderAudit(buildAuditReport(bundleFromHtml(html)), 'table');

    expect(table).toContain('95 chars');
    expect(table).toContain('ideal 50–60');
  });
  test('audit --fail-on ignores advisory tool fails when there are no blockers', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const report = buildAuditReport(bundle);
    const withoutBlockers = report.findings.filter((f) => f.source !== 'critical-blocker');

    expect(withoutBlockers.some((f) => f.severity === 'fail')).toBe(true);
    expect(auditThresholdStatus([], withoutBlockers)).not.toBe('fail');
    expect(
      auditThresholdStatus(
        [{ id: 'no_https', component: 'technical_foundations', cap: 40 }],
        withoutBlockers,
      ),
    ).toBe('fail');
  });
  test('grouped User-agent lines share rules; crawler rows stay off the tool findings list', () => {
    const grouped = `User-agent: Googlebot\nUser-agent: *\nDisallow: /\n`;
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.parsedRobots = parseRobots(grouped);
    bundle.crawlerAccess = parseRobotsTxt(grouped, '/');
    const google = bundle.crawlerAccess.crawlers.find((crawler) => crawler.bot === 'Googlebot');

    expect(google?.status).toBe('blocked');
    const findings = collectFindings(bundle, []);

    expect(findings.some((f) => f.id.startsWith('robots:crawler:'))).toBe(false);
    expect(findings.some((f) => f.source === 'robots')).toBe(true);
  });
  test('markdown and table strip control characters from findings', () => {
    const report = buildAuditReport(bundleFromHtml(PAGE_HTML));

    report.seo.findings.push({
      id: 'test:csi',
      source: 'meta',
      severity: 'info',
      title: `evil\u001b[31m`,
      detail: 'pipe|break',
    });
    const table = renderAudit(report, 'table');

    expect(table).not.toContain('\u001b');
    const md = renderAudit(report, 'markdown');

    expect(md).not.toContain('\u001b');
    expect(md).toContain('pipe\\|break');
  });
  test('markdown lists findings and clips long details', () => {
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
    expect(md).toContain('- **warn** content-security-policy —');
    expect(md).toContain('…');
    expect(md).not.toContain('https: '.repeat(80));
  });
});
