import { describe, expect, test } from 'bun:test';
import {
  classifySitemapFetch,
  extractChildSitemaps,
  inspectUrlset,
  resolveSitemapChildUrl,
  sitemapFromIndexChildBodies,
  sitemapUrlFromRobots,
} from '../src/engine/sitemap.ts';
import type { FetchedPage } from '../src/lib/fetch.ts';

describe('inspectUrlset', () => {
  test('treats query and fragment as the same loc as the path', () => {
    const xml =
      '<urlset><url><loc>https://example.com/page</loc><lastmod>2026-01-01</lastmod></url></urlset>';
    const listed = inspectUrlset(xml, 'https://example.com/page?utm=1#top');

    expect(listed.url_count).toBe(1);
    expect(listed.audited_url_listed).toBe(true);
    expect(listed.audited_url_lastmod).toBe('2026-01-01');
  });
  test('treats http and https locs as the same host and path', () => {
    const xml = '<urlset><url><loc>http://example.com/page</loc></url></urlset>';
    const listed = inspectUrlset(xml, 'https://example.com/page');

    expect(listed.audited_url_listed).toBe(true);
  });
  test('reads namespaced tags and CDATA locs', () => {
    const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc><![CDATA[https://example.com/page]]></sm:loc></sm:url></sm:urlset>`;
    const listed = inspectUrlset(xml, 'https://example.com/page');

    expect(listed.url_count).toBe(1);
    expect(listed.audited_url_listed).toBe(true);
  });
  test('unclosed url opens do not hang', () => {
    const xml = `${' <url> '.repeat(20_000)}</urlset>`;
    const start = performance.now();
    const listed = inspectUrlset(xml, 'https://example.com/page');

    expect(performance.now() - start).toBeLessThan(250);
    expect(listed.url_count).toBe(0);
  });
  test('a long namespace prefix does not hang', () => {
    const prefix = 'a'.repeat(80_000);
    const xml = `<${prefix}:url><${prefix}:loc>https://example.com/page</${prefix}:loc>`;
    const start = performance.now();
    const listed = inspectUrlset(xml, 'https://example.com/page');

    expect(performance.now() - start).toBeLessThan(250);
    expect(listed.url_count).toBe(0);
  });
  test('keeps later urls when a loc contains İ', () => {
    const xml =
      '<urlset><url><loc>https://example.com/İ</loc></url><url><loc>https://example.com/page</loc></url></urlset>';
    const listed = inspectUrlset(xml, 'https://example.com/page');

    expect(listed.url_count).toBe(2);
    expect(listed.audited_url_listed).toBe(true);
  });
});

describe('extractChildSitemaps', () => {
  test('stops after the requested number of locs', () => {
    const locs = Array.from({ length: 10 }, (_, i) => `<loc>https://example.com/s${i}.xml</loc>`);
    const xml = `<sitemapindex>${locs.join('')}</sitemapindex>`;

    expect(extractChildSitemaps(xml, 3)).toHaveLength(3);
    expect(extractChildSitemaps(xml, 3)[0]).toBe('https://example.com/s0.xml');
  });
});

describe('resolveSitemapChildUrl', () => {
  test('resolves relative locs against the index URL and drops non-http', () => {
    expect(resolveSitemapChildUrl('/s0.xml', 'https://example.com/sitemap.xml')).toBe(
      'https://example.com/s0.xml',
    );
    expect(resolveSitemapChildUrl('file:///etc/passwd', 'https://example.com/sitemap.xml')).toBe(
      null,
    );
  });
});

describe('sitemapUrlFromRobots', () => {
  test('resolves a relative Sitemap: loc against the page URL', () => {
    expect(sitemapUrlFromRobots(['/sitemap.xml'], 'https://example.com/blog/')).toBe(
      'https://example.com/sitemap.xml',
    );
  });
  test('falls back to origin /sitemap.xml when none are usable', () => {
    expect(sitemapUrlFromRobots(['file:///tmp/x'], 'https://example.com/page')).toBe(
      'https://example.com/sitemap.xml',
    );
  });
  test('uses a custom HTML name when robots has no usable Sitemap', () => {
    expect(
      sitemapUrlFromRobots(['https://example.com/news-sitemap.xml'], 'https://example.com/'),
    ).toBe('https://example.com/news-sitemap.xml');
  });
  test('prefers robots Sitemap over a later HTML href', () => {
    expect(
      sitemapUrlFromRobots(
        ['https://example.com/from-robots.xml', 'https://example.com/from-html.xml'],
        'https://example.com/',
      ),
    ).toBe('https://example.com/from-robots.xml');
  });
});

function sitemapPage(
  overrides: Partial<FetchedPage> & Pick<FetchedPage, 'finalUrl' | 'contentType' | 'body'>,
): FetchedPage {
  return {
    ok: true,
    requestedUrl: 'https://example.com/sitemap.xml',
    status: 200,
    fetchedAt: new Date().toISOString(),
    headers: {},
    redirectChain: ['https://example.com/sitemap.xml', overrides.finalUrl],
    responseTimeMs: 1,
    ...overrides,
  };
}

describe('classifySitemapFetch', () => {
  test('keeps a 200 XML body after a path redirect', () => {
    expect(
      classifySitemapFetch(
        sitemapPage({
          finalUrl: 'https://example.com/wp-sitemap.xml',
          contentType: 'application/xml',
          body: '<urlset><url><loc>https://example.com/</loc></url></urlset>',
        }),
      ),
    ).toBe('present');
  });
  test('treats a 200 homepage HTML redirect as missing', () => {
    expect(
      classifySitemapFetch(
        sitemapPage({
          finalUrl: 'https://example.com/',
          contentType: 'text/html',
          body: '<html><body>home</body></html>',
        }),
      ),
    ).toBe('missing');
  });
  test('keeps namespaced xml when the content type is not xml', () => {
    expect(
      classifySitemapFetch(
        sitemapPage({
          finalUrl: 'https://example.com/sitemap.xml',
          contentType: 'text/plain',
          body: '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/</sm:loc></sm:url></sm:urlset>',
        }),
      ),
    ).toBe('present');
  });
  test('does not treat an HTML page that mentions url as a sitemap', () => {
    expect(
      classifySitemapFetch(
        sitemapPage({
          finalUrl: 'https://example.com/',
          contentType: 'text/html',
          body: '<html><body>docs use the &lt;url&gt; tag</body></html>',
        }),
      ),
    ).toBe('missing');
  });
});

describe('sitemapFromIndexChildBodies', () => {
  test('is error when every child fetch fails', () => {
    const result = sitemapFromIndexChildBodies(['', ''], 'https://example.com/');

    expect(result.present).toBe(false);
    expect(result.fetchStatus).toBe('error');
    expect(result.url_count).toBe(0);
  });
  test('keeps present when at least one child urlset loads', () => {
    const xml = '<urlset><url><loc>https://example.com/page</loc></url></urlset>';
    const result = sitemapFromIndexChildBodies(['', xml], 'https://example.com/page');

    expect(result.present).toBe(true);
    expect(result.fetchStatus).toBe('present');
    expect(result.url_count).toBe(1);
    expect(result.audited_url_listed).toBe(true);
  });
});
