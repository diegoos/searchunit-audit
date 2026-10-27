import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { collectFindings, kindExtras, kindThresholdStatus } from '../src/engine/findings.ts';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { checkPageLinks } from '../src/engine/linkStatus.ts';
import { parseRobotsTxt } from '../src/engine/robotsTxtParser.ts';
import { computeAuditScores, type CriticalBlocker } from '../src/engine/scoring.ts';
import type { DiscoveryBundle } from '../src/engine/discovery.ts';
import type { Finding } from '../src/engine/types.ts';
import * as fetchModule from '../src/lib/fetch.ts';
import type { FetchOutcome } from '../src/lib/fetch.ts';
import { PAGE_HTML, bundleFromHtml } from './engine-fixtures.ts';

function allFindings(bundle: DiscoveryBundle): Finding[] {
  const blockers: CriticalBlocker[] = [];

  computeAuditScores(bundle, blockers);

  return [...collectFindings(bundle, blockers), ...kindExtras('seo', bundle)];
}

function findingById(bundle: DiscoveryBundle, id: string): Finding | undefined {
  return allFindings(bundle).find((item) => item.id === id);
}

function page(head: string, body: string): string {
  return `<html lang="en"><head><meta charset="utf-8"/>${head}</head><body>${body}</body></html>`;
}

const link = (href: string, text: string) => ({ href, text, ariaLabel: null, imgAlt: null });

describe('canonical and og:url', () => {
  test('a canonical to another page on the same host is a warning', () => {
    const bundle = bundleFromHtml(page('<link rel="canonical" href="/other"/>', '<h1>T</h1>'));

    expect(findingById(bundle, 'meta:canonical')).toMatchObject({ severity: 'warn' });
  });
  test('og:url that names another page is a warning', () => {
    const html = page(
      '<link rel="canonical" href="https://example.com/"/><meta property="og:url" content="https://example.com/x"/>',
      '<h1>T</h1>',
    );

    expect(findingById(bundleFromHtml(html), 'meta:og_url')).toMatchObject({ severity: 'warn' });
  });
});

describe('page content checks', () => {
  test('heading outline keeps document order and flags a skipped level', () => {
    const bundle = bundleFromHtml(page('', '<h1>Top</h1><h3>Deep</h3><h2>Mid</h2>'));

    expect(bundle.auditedPage.headings.outline).toEqual([
      { level: 1, text: 'Top' },
      { level: 3, text: 'Deep' },
      { level: 2, text: 'Mid' },
    ]);
    expect(findingById(bundle, 'content:heading-order')).toMatchObject({
      severity: 'warn',
      detail: 'H1 then H3: "Deep"',
    });
  });
  test('a future datePublished fails; a future visible date alone is info', () => {
    const published = page(
      '<meta property="article:published_time" content="2999-01-01"/>',
      '<h1>T</h1>',
    );
    const event = page(
      '<meta property="article:published_time" content="2026-01-01"/>',
      '<h1>T</h1><p>Next match</p><time datetime="2999-01-01">soon</time>',
    );

    expect(findingById(bundleFromHtml(published), 'content:date-sanity')?.severity).toBe('fail');
    expect(findingById(bundleFromHtml(event), 'content:date-sanity')?.severity).toBe('info');
  });
  test('active mixed content fails and passive mixed content warns', () => {
    const active = bundleFromHtml(page('<script src="http://cdn.example/a.js"></script>', ''));
    const passive = bundleFromHtml(page('', '<img src="http://cdn.example/a.png" alt="a"/>'));

    expect(findingById(active, 'content:mixed-content')?.severity).toBe('fail');
    expect(findingById(passive, 'content:mixed-content')?.severity).toBe('warn');
  });
  test('hidden text outside nav is counted once, nav menus are not', () => {
    const text = 'A long hidden paragraph that should be visible to readers and crawlers.';
    const bundle = bundleFromHtml(
      page(
        '',
        `<nav><div style="display:none">${text}</div></nav><div hidden><p style="display: none">${text}</p></div>`,
      ),
    );

    expect(bundle.auditedPage.hiddenText.elementCount).toBe(1);
    expect(findingById(bundle, 'content:hidden-text')?.severity).toBe('warn');
  });
  test('trust pages are found past the 50-link display cap', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
    const bundle = bundleFromHtml(
      page(
        '',
        `${filler}<footer><a href="/sobre">Sobre</a><a href="/contato">Fale</a><a href="/privacy">P</a><a href="/termos-de-uso">T</a></footer>`,
      ),
    );

    expect(bundle.auditedPage.internalLinksTruncated).toBe(true);
    expect(bundle.auditedPage.trustPages).toEqual({
      about: 'https://example.com/sobre',
      contact: 'https://example.com/contato',
      privacy: 'https://example.com/privacy',
      terms: 'https://example.com/termos-de-uso',
    });
    expect(findingById(bundle, 'content:trust-pages')?.severity).toBe('pass');
  });
  test('word count reads main content, not nav and footer', () => {
    const nav = `<nav>${'menu '.repeat(200)}</nav>`;
    const parsed = parseHtmlPage(
      page(
        '',
        `${nav}<div><p>${'word '.repeat(30)}</p></div><footer>${'foot '.repeat(50)}</footer>`,
      ),
      'https://example.com/a',
    );

    expect(parsed.wordCount).toBe(30);
    expect(parsed.bodyWordCount).toBe(280);
    expect(parsed.citabilityTexts).toHaveLength(1);
  });
  test('main text keeps table cells apart and tables come back as rows', () => {
    const parsed = parseHtmlPage(
      page(
        '',
        '<nav>Menu</nav><main><h1>W</h1><table><tr><th>Weight</th><td>2 kg</td></tr><tr><th>Material</th><td>Steel</td></tr></table></main>',
      ),
      'https://example.com/a',
    );

    expect(parsed.mainText).toBe('W Weight 2 kg Material Steel');
    expect(parsed.tables).toEqual([
      [
        ['Weight', '2 kg'],
        ['Material', 'Steel'],
      ],
    ]);
  });
  test('a header logo is not the hero and a lazy data-src image counts', () => {
    const parsed = parseHtmlPage(
      page(
        '',
        '<header><img src="/logo.svg" alt="Brand"/></header><main><img data-src="/hero.jpg" src="data:image/gif;base64,R0" alt="Hero"/></main>',
      ),
      'https://example.com/a',
    );

    expect(parsed.images.total).toBe(2);
    expect(parsed.images.items.map((item) => [item.src, item.hero])).toEqual([
      ['/logo.svg', false],
      ['/hero.jpg', true],
    ]);
  });
});

describe('meta extras', () => {
  test('nosnippet in meta or X-Robots-Tag limits the snippet', () => {
    const meta = bundleFromHtml(page('<meta name="robots" content="nosnippet"/>', ''));
    const header = bundleFromHtml(page('', ''));

    header.securityHeaders = { ...header.securityHeaders, x_robots_tag: 'max-snippet:0' };
    expect(findingById(meta, 'meta:snippet-limits')?.severity).toBe('warn');
    expect(findingById(header, 'meta:snippet-limits')?.severity).toBe('warn');
  });
  test('hreflang without self reference or x-default is a warning and earns no bonus', () => {
    const html = page(
      '<link rel="alternate" hreflang="pt-BR" href="https://example.com/pt"/><link rel="alternate" hreflang="es" href="https://example.com/es"/>',
      '',
    );
    const finding = findingById(bundleFromHtml(html), 'meta:hreflang');

    expect(finding?.severity).toBe('warn');
    expect(finding?.detail).toContain('no self reference');
    expect(finding?.detail).toContain('no x-default');
  });
  test('missing charset is a warning', () => {
    const bundle = bundleFromHtml('<html><body><h1>T</h1></body></html>');

    bundle.pageHeaders = { 'content-type': 'text/html' };
    expect(findingById(bundle, 'meta:charset')?.severity).toBe('warn');
  });
});

describe('gate findings', () => {
  test('robots.txt that blocks Googlebot on the path fails search-crawlers and the SEO gate', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.crawlerAccess = parseRobotsTxt('User-agent: Googlebot\nDisallow: /\n', '/');
    const findings = allFindings(bundle);

    expect(findings.find((item) => item.id === 'discovery:search-crawlers')?.severity).toBe('fail');
    expect(kindThresholdStatus('seo', [], findings)).toBe('fail');
  });
  test('a mobile noindex fails parity, and a failed mobile GET names the error', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.mobileFetchError = 'timeout';
    expect(findingById(bundle, 'discovery:mobile')).toMatchObject({
      severity: 'info',
      detail: 'mobile GET failed: timeout',
    });
    bundle.mobilePage = {
      statusCode: 200,
      byteLength: 10,
      wordCount: bundle.auditedPage.wordCount,
      h1: bundle.auditedPage.headings.h1,
      jsRenderingRisk: { isLikelyCsr: false, reason: null },
      canonicalUrl: bundle.auditedPage.canonicalUrl,
      effectiveRobotsDirective: 'noindex',
      viewport: true,
      structuredDataTypes: [],
      internalLinkCount: 0,
      visibleTextSha256: bundle.auditedPage.visibleTextSha256,
      visibleTextExcerpt: '',
    };
    expect(findingById(bundle, 'discovery:mobile')).toMatchObject({
      severity: 'fail',
      detail: 'mobile noindex',
    });
  });
  test('a redirect chain longer than one hop is a warning', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.redirects = { ...bundle.redirects, chain_length: 2 };
    expect(findingById(bundle, 'discovery:redirects')?.severity).toBe('warn');
  });
});

describe('link findings', () => {
  test('a broken internal link fails and a generic anchor warns', () => {
    const bundle = bundleFromHtml(page('', '<a href="/gone">click here</a>'));

    bundle.linkStatus = {
      status: 'completed',
      checked: 1,
      candidates: 1,
      results: [
        {
          href: 'https://example.com/gone',
          scope: 'internal',
          status: 404,
          finalUrl: 'https://example.com/gone',
          redirects: 0,
          error: null,
        },
      ],
    };
    expect(findingById(bundle, 'links:status')?.severity).toBe('fail');
    expect(findingById(bundle, 'links:anchor-text')?.severity).toBe('warn');
  });
  test('link status rows are absent when the probe was skipped', () => {
    expect(findingById(bundleFromHtml(PAGE_HTML), 'links:status')).toBeUndefined();
  });
  test('checkPageLinks keeps page order, skips the page itself, and never probes outbound links', async () => {
    const calls: string[] = [];
    const spy = spyOn(fetchModule, 'fetchPublicUrl').mockImplementation(
      async (url: string): Promise<FetchOutcome> => {
        calls.push(url);

        return {
          ok: true,
          requestedUrl: url,
          finalUrl: url,
          status: url.endsWith('/b') ? 404 : 200,
          contentType: 'text/html',
          body: '',
          fetchedAt: '2026-01-01T00:00:00.000Z',
          headers: {},
          redirectChain: [url],
          responseTimeMs: 1,
        };
      },
    );

    try {
      const internal = [
        link('https://example.com/', 'home'),
        ...Array.from({ length: 30 }, (_, i) => link(`https://example.com/${i}`, '')),
      ];
      internal.splice(2, 0, link('https://example.com/b', 'b'));
      const report = await checkPageLinks('https://example.com/', internal);

      expect(report.checked).toBe(25);
      expect(report.results[0]?.href).toBe('https://example.com/0');
      expect(report.results[1]).toMatchObject({ href: 'https://example.com/b', status: 404 });
      expect(report.results.every((r) => r.scope === 'internal')).toBe(true);
      expect(calls).not.toContain('https://example.com/');
      expect(calls.some((url) => url.includes('other.example'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

function contentScore(bundle: DiscoveryBundle): number | null | undefined {
  return computeAuditScores(bundle).breakdown.find((row) => row.component === 'content_quality')
    ?.score;
}

describe('scoring determinism and focus', () => {
  test('freshness reads fetchedAt, not the clock', () => {
    const html = page(
      '<meta property="article:modified_time" content="2026-09-20"/>',
      '<h1>T</h1>',
    );
    const recent = bundleFromHtml(html);
    const later = bundleFromHtml(html);

    later.fetchedAt = '2028-09-20T00:00:00.000Z';

    expect(contentScore(recent)).toBe(contentScore(bundleFromHtml(html)));
    expect(contentScore(later)).toBeLessThan(contentScore(recent) ?? 0);
  });
  test('poor origin CrUX does not cap the page, poor URL CrUX does', () => {
    const poor = { rating: 'poor' };
    const record = { cwv_pass: false, metrics: { largest_contentful_paint: poor } };
    const blockersFor = (urlLevel: boolean) => {
      const bundle = bundleFromHtml(PAGE_HTML);
      const blockers: CriticalBlocker[] = [];

      bundle.crux = {
        status: 'completed',
        errors: [],
        results: [
          {
            url: bundle.auditedUrl,
            origin: 'https://example.com',
            status: 'ok',
            url_data: urlLevel ? record : null,
            origin_data: record,
            errors: [],
          },
        ],
      };
      computeAuditScores(bundle, blockers);

      return blockers.map((blocker) => blocker.id);
    };
    expect(blockersFor(false)).not.toContain('poor_core_web_vitals');
    expect(blockersFor(true)).toContain('poor_core_web_vitals');
  });
  test('a bare year is not a statistic', () => {
    const parsed = parseHtmlPage(
      page(
        '',
        '<main><p>Founded in 1999 and still here.</p><p>Revenue grew 40% in a year.</p></main>',
      ),
      'https://example.com/a',
    );

    expect(parsed.contentSignals.statistic_snippet_count).toBe(1);
  });
});

const FILL_CLI = { command: 'audit', scores: { overall: 80 } };

function runFill(prose: Record<string, unknown>): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'su-fill-'));
  const template = join(dir, 't.html');
  const prosePath = join(dir, 'p.json');

  writeFileSync(template, '<html><script type="application/json" id="audit-data"></script></html>');
  writeFileSync(prosePath, JSON.stringify(prose));
  writeFileSync(join(dir, 'c.json'), JSON.stringify(FILL_CLI));

  return spawnSync(
    'node',
    [
      new URL('../skills/searchunit-audit/scripts/fill-audit-html.mjs', import.meta.url).pathname,
      '--template',
      template,
      '--prose',
      prosePath,
      '--cli',
      join(dir, 'c.json'),
      '--out',
      join(dir, 'out.html'),
    ],
    { encoding: 'utf8' },
  );
}

const BASE_PROSE = {
  lang: 'en',
  context: [],
  wrong: [],
  improve: [],
  priority: [],
  checks: [],
  sample: [],
  sampleSentence: 'URLs outside this sample were not read.',
  examples: [],
  gsc: {},
  limits: [],
  cuts: '',
  actions: [],
  validation: [],
};

describe('fill-audit-html validation', () => {
  test('rejects an item with an empty text and accepts a complete one', () => {
    const empty = runFill({
      ...BASE_PROSE,
      improve: [{ title: 'T', text: '', evidence: 'direct' }],
    });
    const complete = runFill({
      ...BASE_PROSE,
      improve: [{ title: 'T', text: 'A sentence.', evidence: 'direct' }],
    });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('improve[0]');
    expect(complete.status).toBe(0);
  });
});

describe('fill-audit-html', () => {
  test('rejects prose keys that would overwrite CLI numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'su-fill-'));
    const template = join(dir, 't.html');
    const prose = join(dir, 'p.json');

    writeFileSync(
      template,
      '<html><script type="application/json" id="audit-data"></script></html>',
    );
    writeFileSync(
      prose,
      JSON.stringify({
        lang: 'en',
        context: [],
        wrong: [],
        improve: [],
        priority: [],
        checks: [],
        sample: [],
        sampleSentence: 'URLs outside this sample were not read.',
        examples: [],
        gsc: {},
        limits: [],
        cuts: '',
        actions: [],
        validation: [],
        scores: { overall: 100 },
      }),
    );
    writeFileSync(join(dir, 'c.json'), JSON.stringify(FILL_CLI));
    const result = spawnSync(
      'node',
      [
        new URL('../skills/searchunit-audit/scripts/fill-audit-html.mjs', import.meta.url).pathname,
        '--template',
        template,
        '--prose',
        prose,
        '--cli',
        join(dir, 'c.json'),
        '--out',
        join(dir, 'out.html'),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scores');
  });
});
