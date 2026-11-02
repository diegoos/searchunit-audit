import { describe, expect, spyOn, test } from 'bun:test';
import {
  classifySitemapFetch,
  extractChildSitemaps,
  inspectUrlset,
  parseSitemapForUrl,
  resolveSitemapChildUrl,
  sitemapFromIndexChildBodies,
  sitemapUrlsFromDeclared,
} from '../src/engine/sitemap.ts';
import * as fetchModule from '../src/lib/fetch.ts';
import type { FetchedPage, FetchOutcome } from '../src/lib/fetch.ts';

describe('inspectUrlset', () => {
  test('ignores tracking params and fragment when matching the page', () => {
    const xml =
      '<urlset><url><loc>https://example.com/page</loc><lastmod>2026-01-01</lastmod></url></urlset>';
    const listed = inspectUrlset(xml, 'https://www.example.com/page/?utm_source=x#top');

    expect(listed.url_count).toBe(1);
    expect(listed.audited_url_listed).toBe(true);
    expect(listed.audited_url_lastmod).toBe('2026-01-01');
  });
  test('keeps other query params, so /page?id=1 is not /page', () => {
    const xml = '<urlset><url><loc>https://example.com/page</loc></url></urlset>';

    expect(inspectUrlset(xml, 'https://example.com/page?id=1').audited_url_listed).toBe(false);
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
  test('decodes XML entities, strips userinfo, and drops non-http locs', () => {
    const xml = `<urlset>
      <url><loc>https://example.com/search?q=a&amp;page=2</loc></url>
      <url><loc>https://user:secret@example.com/hidden</loc></url>
      <url><loc>ftp://example.com/file</loc></url>
    </urlset>`;
    const listed = sitemapFromIndexChildBodies([xml], 'https://example.com/');

    expect(listed.url_count).toBe(2);
    expect(listed.urls.map((entry) => entry.loc)).toEqual([
      'https://example.com/search?q=a&page=2',
      'https://example.com/hidden',
    ]);
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
  test('decodes a child loc and drops a non-http scheme', () => {
    const xml = `<sitemapindex>
      <loc>https://example.com/s&amp;1.xml</loc>
      <loc>https://user:secret@example.com/s2.xml</loc>
      <loc>file:///tmp/secret.xml</loc>
    </sitemapindex>`;

    expect(extractChildSitemaps(xml, 5)).toEqual([
      'https://example.com/s&1.xml',
      'https://example.com/s2.xml',
    ]);
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

describe('sitemapUrlsFromDeclared', () => {
  test('resolves a relative Sitemap: loc against the page URL', () => {
    expect(sitemapUrlsFromDeclared(['/sitemap.xml'], 'https://example.com/blog/')).toEqual([
      'https://example.com/sitemap.xml',
    ]);
  });
  test('falls back to origin /sitemap.xml when none are usable', () => {
    expect(sitemapUrlsFromDeclared(['file:///tmp/x'], 'https://example.com/page')).toEqual([
      'https://example.com/sitemap.xml',
    ]);
  });
  test('keeps every declared sitemap in order, deduped and capped at 5', () => {
    const declared = [
      'https://example.com/a.xml',
      'https://example.com/b.xml',
      'https://example.com/a.xml',
      ...Array.from({ length: 6 }, (_, i) => `https://example.com/x${i}.xml`),
    ];

    expect(sitemapUrlsFromDeclared(declared, 'https://example.com/')).toEqual([
      'https://example.com/a.xml',
      'https://example.com/b.xml',
      'https://example.com/x0.xml',
      'https://example.com/x1.xml',
      'https://example.com/x2.xml',
    ]);
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
});

describe('sitemapFromIndexChildBodies', () => {
  test('is error when every child fetch fails', () => {
    const result = sitemapFromIndexChildBodies(['', ''], 'https://example.com/');

    expect(result.present).toBe(false);
    expect(result.fetchStatus).toBe('error');
    expect(result.url_count).toBe(0);
    expect(result.urls).toEqual([]);
    expect(result.urlsTruncated).toBe(false);
  });
  test('keeps present when at least one child urlset loads', () => {
    const xml = '<urlset><url><loc>https://example.com/page</loc></url></urlset>';
    const result = sitemapFromIndexChildBodies(['', xml], 'https://example.com/page');

    expect(result.present).toBe(true);
    expect(result.fetchStatus).toBe('present');
    expect(result.url_count).toBe(1);
    expect(result.audited_url_listed).toBe(true);
  });
  test('puts institutional and short urls first, in file order', () => {
    const firstLong = 'https://example.com/a/b/c/1';
    const secondLong = 'https://example.com/a/b/c/2';
    const xml = `<urlset>
      <url><loc>${firstLong}</loc></url>
      <url><loc>https://example.com/about</loc><lastmod>2024-01-02</lastmod></url>
      <url><loc>https://example.com/news/story</loc></url>
      <url><loc>https://example.com/company/privacy-policy/legal</loc></url>
      <url><loc>${secondLong}</loc></url>
    </urlset>`;
    const result = sitemapFromIndexChildBodies([xml], 'https://example.com/');

    expect(result.urls.map((entry) => entry.loc)).toEqual([
      'https://example.com/news/story',
      'https://example.com/about',
      'https://example.com/company/privacy-policy/legal',
      firstLong,
      secondLong,
    ]);
    expect(result.urls[0]?.lastmod).toBeNull();
    expect(result.urls[1]?.lastmod).toBe('2024-01-02');
    expect(result.url_count).toBe(5);
    expect(result.urlsTruncated).toBe(false);
  });
  test('merges index children before the priority slice and truncates at 200', () => {
    const first = `<urlset>
      <url><loc>https://example.com/a/b/c/d</loc></url>
      <url><loc>https://example.com/about</loc></url>
    </urlset>`;
    const second = `<urlset>
      <url><loc>https://example.com/contact</loc></url>
      <url><loc>https://example.com/e/f/g/h</loc></url>
    </urlset>`;
    const merged = sitemapFromIndexChildBodies([first, second], 'https://example.com/');

    expect(merged.urls.map((entry) => entry.loc)).toEqual([
      'https://example.com/about',
      'https://example.com/contact',
      'https://example.com/a/b/c/d',
      'https://example.com/e/f/g/h',
    ]);
    expect(merged.urlsTruncated).toBe(false);

    const locs = Array.from({ length: 201 }, (_, index) => {
      return `<url><loc>https://example.com/a/b/c/${index}</loc></url>`;
    });
    locs.push('<url><loc>https://example.com/contact</loc></url>');
    const truncated = sitemapFromIndexChildBodies(
      [`<urlset>${locs.join('')}</urlset>`],
      'https://example.com/',
    );

    expect(truncated.url_count).toBe(202);
    expect(truncated.urls).toHaveLength(200);
    expect(truncated.urls[0]?.loc).toBe('https://example.com/contact');
    expect(truncated.urlsTruncated).toBe(true);
  });
  test('keeps one url per template class ahead of the 200 cap', () => {
    const locs = Array.from({ length: 200 }, (_, index) => {
      return `<url><loc>https://example.com/a/b/c/${index}</loc></url>`;
    });
    locs.push('<url><loc>https://example.com/blog/post</loc></url>');
    locs.push('<url><loc>https://example.com/shop/sku-1</loc></url>');
    locs.push('<url><loc>https://example.com/category/shoes</loc></url>');
    locs.push(
      '<url><loc>https://example.com/a/b/c/recent</loc><lastmod>2026-10-19</lastmod></url>',
    );
    const result = sitemapFromIndexChildBodies(
      [`<urlset>${locs.join('')}</urlset>`],
      'https://example.com/',
    );

    expect(result.url_count).toBe(204);
    expect(result.urls).toHaveLength(200);
    expect(result.urlsTruncated).toBe(true);
    expect(result.urls.slice(0, 4).map((entry) => entry.loc)).toEqual([
      'https://example.com/shop/sku-1',
      'https://example.com/blog/post',
      'https://example.com/category/shoes',
      'https://example.com/a/b/c/recent',
    ]);
  });
  test('marks an unexpanded child index and unfetched siblings as truncated', () => {
    const childIndex = '<sitemapindex><loc>https://example.com/nested.xml</loc></sitemapindex>';
    const nested = sitemapFromIndexChildBodies([childIndex], 'https://example.com/');
    const siblings = sitemapFromIndexChildBodies(
      ['<urlset><url><loc>https://example.com/about</loc></url></urlset>'],
      'https://example.com/',
      true,
    );

    expect(nested.urlsTruncated).toBe(true);
    expect(nested.coverage).toBe('partial');
    expect(nested.url_count).toBe(0);
    expect(siblings.urlsTruncated).toBe(true);
    expect(siblings.urls.map((entry) => entry.loc)).toEqual(['https://example.com/about']);
  });
});

function xmlPage(url: string, body: string): FetchOutcome {
  return sitemapPage({ requestedUrl: url, finalUrl: url, contentType: 'application/xml', body });
}

async function withSitemaps(
  files: Record<string, string>,
  run: (calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const spy = spyOn(fetchModule, 'fetchPublicUrl').mockImplementation(async (url: string) => {
    calls.push(url);
    const body = files[url];

    if (body === undefined) {
      return { ...xmlPage(url, 'not found'), status: 404, contentType: 'text/plain' };
    }

    return xmlPage(url, body);
  });
  try {
    await run(calls);
  } finally {
    spy.mockRestore();
  }
}

const urlset = (...locs: string[]) =>
  `<urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;
const index = (...locs: string[]) =>
  `<sitemapindex>${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('')}</sitemapindex>`;

describe('parseSitemapForUrl', () => {
  test('finds the page in the second declared sitemap', async () => {
    await withSitemaps(
      {
        'https://example.com/a.xml': urlset('https://example.com/other'),
        'https://example.com/b.xml': urlset('https://example.com/page'),
      },
      async () => {
        const result = await parseSitemapForUrl(
          ['https://example.com/a.xml', 'https://example.com/b.xml'],
          'https://example.com/page',
        );

        expect(result.audited_url_listed).toBe(true);
        expect(result.coverage).toBe('complete');
        expect(result.filesRead).toBe(2);
      },
    );
  });
  test('follows every index child and nested index', async () => {
    const children = Array.from({ length: 4 }, (_, i) => `https://example.com/s${i}.xml`);
    const files: Record<string, string> = {
      'https://example.com/sitemap.xml': index(...children),
      'https://example.com/nested.xml': urlset('https://example.com/page'),
    };
    for (const child of children.slice(0, 3)) {
      files[child] = urlset(`${child}/entry`);
    }

    files[children[3]!] = index('https://example.com/nested.xml');

    await withSitemaps(files, async () => {
      const result = await parseSitemapForUrl(
        ['https://example.com/sitemap.xml'],
        'https://example.com/page',
      );

      expect(result.audited_url_listed).toBe(true);
      expect(result.coverage).toBe('complete');
      expect(result.filesRead).toBe(6);
    });
  });
  test('fetches at most 5 sitemap files at once', async () => {
    const children = Array.from({ length: 12 }, (_, i) => `https://example.com/s${i}.xml`);
    let active = 0;
    let peak = 0;
    const spy = spyOn(fetchModule, 'fetchPublicUrl').mockImplementation(async (url: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;

      return xmlPage(
        url,
        url.endsWith('sitemap.xml') ? index(...children) : urlset(`${url}/entry`),
      );
    });
    try {
      const result = await parseSitemapForUrl(
        ['https://example.com/sitemap.xml'],
        'https://example.com/',
      );

      expect(peak).toBeLessThanOrEqual(5);
      expect(result.filesRead).toBe(13);
      expect(result.coverage).toBe('complete');
    } finally {
      spy.mockRestore();
    }
  });
  test('is partial when the file cap stops the walk', async () => {
    const children = Array.from({ length: 30 }, (_, i) => `https://example.com/s${i}.xml`);
    const files: Record<string, string> = { 'https://example.com/sitemap.xml': index(...children) };

    for (const child of children) {
      files[child] = urlset(`${child}/entry`);
    }

    await withSitemaps(files, async (calls) => {
      const result = await parseSitemapForUrl(
        ['https://example.com/sitemap.xml'],
        'https://example.com/page',
      );

      expect(calls).toHaveLength(25);
      expect(result.coverage).toBe('partial');
      expect(result.audited_url_listed).toBe(false);
    });
  });
  test('is partial when a declared file fails, and missing when all fail', async () => {
    await withSitemaps(
      { 'https://example.com/a.xml': urlset('https://example.com/x') },
      async () => {
        const partial = await parseSitemapForUrl(
          ['https://example.com/a.xml', 'https://example.com/gone.xml'],
          'https://example.com/page',
        );
        const missing = await parseSitemapForUrl(
          ['https://example.com/gone.xml'],
          'https://example.com/page',
        );

        expect(partial.coverage).toBe('partial');
        expect(missing.present).toBe(false);
        expect(missing.fetchStatus).toBe('missing');
      },
    );
  });
});
