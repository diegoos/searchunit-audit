import { describe, expect, test } from 'bun:test';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import {
  classifyPage,
  expectedSchemaTypes,
  UNDEFINED_TYPE,
} from '../src/engine/pageClassification.ts';
import { PAGE_HTML } from './engine-fixtures.ts';

describe('expectedSchemaTypes', () => {
  test('returns unique types for page kind and site type', () => {
    expect(expectedSchemaTypes('publisher', 'article')).toEqual([
      'Article',
      'NewsArticle',
      'BlogPosting',
    ]);
    expect(expectedSchemaTypes('ecommerce', 'product')).toEqual(['Product', 'Organization']);
    expect(expectedSchemaTypes('saas', 'home')).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
    ]);
    expect(expectedSchemaTypes(UNDEFINED_TYPE, UNDEFINED_TYPE)).toEqual([]);
    expect(expectedSchemaTypes('local-business', 'profile')).toEqual([
      'Person',
      'LocalBusiness',
      'Organization',
    ]);
  });
});

describe('classifyPage', () => {
  test('uses schema and og:type, otherwise undefined', () => {
    const home = parseHtmlPage(PAGE_HTML, 'https://example.com/');

    expect(UNDEFINED_TYPE).toBe('Undefined');
    expect(classifyPage(home)).toEqual({
      siteType: 'Undefined',
      pageKind: 'Undefined',
    });
    const productHtml = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Widget"}</script></head><body><h1>Widget</h1></body></html>`;
    const productUrl = 'https://example.com/widgets/widget';

    expect(classifyPage(parseHtmlPage(productHtml, productUrl))).toEqual({
      siteType: 'ecommerce',
      pageKind: 'product',
    });
    const cartHtml = `<html><body><h1>Shop</h1><p>Add to cart then checkout</p></body></html>`;

    expect(classifyPage(parseHtmlPage(cartHtml, 'https://example.com/'))).toEqual({
      siteType: UNDEFINED_TYPE,
      pageKind: UNDEFINED_TYPE,
    });
    const websiteHtml = `<html><head><meta property="og:type" content="website"/></head><body><h1>Home</h1></body></html>`;

    expect(classifyPage(parseHtmlPage(websiteHtml, 'https://example.com/blog/post'))).toEqual({
      siteType: UNDEFINED_TYPE,
      pageKind: 'home',
    });
    const newsHtml = `<html><head><script type="application/ld+json">{"@type":"NewsMediaOrganization","name":"Paper"}</script></head><body><h1>Paper</h1></body></html>`;

    expect(classifyPage(parseHtmlPage(newsHtml, 'https://example.com/'))).toEqual({
      siteType: 'publisher',
      pageKind: UNDEFINED_TYPE,
    });
  });
});

describe('parseHtmlPage', () => {
  test('returns every ParsedPage field from a fixture', () => {
    const parsed = parseHtmlPage(PAGE_HTML, 'https://example.com/');
    expect(parsed.title).toContain('Example Company');
    expect(parsed.metaDescription).toContain('widgets');
    expect(parsed.canonicalUrl).toBe('https://example.com/');
    expect(parsed.robotsDirective).toBeNull();
    expect(parsed.lang).toBe('en');
    expect(parsed.wordCount).toBeGreaterThan(0);
    expect(parsed.viewport).toBe(true);
    expect(parsed.headings.h1).toEqual(['Example Company']);
    expect(parsed.headings.h1Count).toBe(1);
    expect(parsed.headings.h1ElementCount).toBe(1);
    expect(parsed.headings.h2Count).toBe(2);
    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.images).toEqual({ total: 1, withAlt: 1, missingAlt: 0 });
    expect(parsed.citabilityTexts.length).toBeGreaterThan(0);
    expect(parsed.contentSignals).toEqual(
      expect.objectContaining({
        paragraphs: expect.any(Number),
        lists: expect.any(Number),
        tables: expect.any(Number),
        listingPattern: expect.any(Boolean),
      }),
    );
    expect(parsed.jsRenderingRisk).toEqual({ isLikelyCsr: false, reason: null });
    expect(parsed.hasSpeakable).toBe(false);
    expect(parsed.dates).toEqual({ published: null, modified: null });
    expect(parsed.author.hasAuthor).toBe(false);
    expect(parsed.markupFormats.jsonld_only).toBe(true);
    expect(parsed.discover.hasRepresentativeImage).toBe(false);
    expect(parsed.sitemapUrls).toEqual([]);
  });
  test('reads a custom sitemap from link rel and sitemap-named anchors', () => {
    const html = `<html><head>
      <link rel="Sitemap alternate" href="/news-sitemap.xml"/>
    </head><body>
      <a href="/wp-sitemap.xml">xml</a>
      <a href="/blog/what-is-a-sitemap">article</a>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/page');

    expect(parsed.sitemapUrls).toEqual([
      'https://example.com/news-sitemap.xml',
      'https://example.com/wp-sitemap.xml',
    ]);
  });
  test('reads dates author discover signals and per-bot robots', () => {
    const html = `<html><head>
      <meta name="author" content="Desk"/>
      <meta name="googlebot" content="noindex"/>
      <meta name="robots" content="max-image-preview:large"/>
      <meta property="article:published_time" content="2026-09-10"/>
      <meta property="og:image" content="https://example.com/hero.jpg"/>
    </head><body><p>Hello</p><img src="/a.png"></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');
    expect(parsed.author).toEqual({ hasAuthor: true, names: ['Desk'] });
    expect(parsed.dates.published).toBe('2026-09-10');
    expect(parsed.metaRobotsByBot.googlebot).toBe('noindex');
    expect(parsed.discover).toEqual({ maxImagePreviewLarge: true, hasRepresentativeImage: true });
    expect(parsed.images).toEqual({ total: 1, withAlt: 0, missingAlt: 1 });
  });
  test('reads JSON-LD author arrays', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      author: [{ '@type': 'Person', name: 'Jane' }],
    })}</script></head><body><p>Hi</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/news');

    expect(parsed.author).toEqual({ hasAuthor: true, names: ['Jane'] });
  });
  test('does not treat og:url as rel=canonical', () => {
    const html = `<html><head>
      <meta property="og:url" content="https://example.com/og"/>
    </head><body><p>Hi</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/page');

    expect(parsed.canonicalUrl).toBeNull();
  });
  test('flags a CSR shell and FAQ headings', () => {
    const scripts = '<script src="/a.js"></script>'.repeat(5);
    const html = `<html><body><div id="root"></div>${scripts}<h2>FAQ</h2></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/app');

    expect(parsed.jsRenderingRisk.isLikelyCsr).toBe(true);
    expect(parsed.contentSignals.hasFaqPattern).toBe(true);
  });
  test('word count ignores script and style text', () => {
    const html = `<html><body><p>Hello world</p><script>${'token '.repeat(80)}</script><style>body { color: red }</style></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.wordCount).toBe(2);
    expect(parsed.visibleText).toBe('Hello world');
  });
  test('drops non-http(s) canonical hrefs', () => {
    const html = `<html><head><link rel="canonical" href="javascript:alert(1)"/></head><body><p>Hi</p></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/').canonicalUrl).toBeNull();
  });
  test('reads mixed-case googlebot noindex and commented JSON-LD', () => {
    const html = `<html><head>
      <meta name="Googlebot" content="noindex"/>
      <script type="application/ld+json"><!--{"@type":"Organization","name":"Acme","url":"https://example.com"}--></script>
    </head><body><p>Hi</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.metaRobotsByBot.googlebot).toBe('noindex');
    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.schemaBlocks[0]?.parseError).toBeUndefined();
  });
  test('normalizes JSON-LD IRI @type and mixed-case meta/link', () => {
    const html = `<html><head>
      <link rel="Canonical" href="https://example.com/page"/>
      <meta name="Author" content="Ada"/>
      <meta name="Robots" content="max-image-preview:large"/>
      <script type="application/ld+json">{"@type":"https://schema.org/Article","headline":"T","datePublished":"2026-01-01","author":"Ada"}</script>
    </head><body><h1>T</h1><p>${'word '.repeat(40)}</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/page');

    expect(parsed.canonicalUrl).toBe('https://example.com/page');
    expect(parsed.author.names).toContain('Ada');
    expect(parsed.discover.maxImagePreviewLarge).toBe(true);
    expect(parsed.structuredData.types).toContain('Article');
    expect(classifyPage(parsed).pageKind).toBe('article');
  });
  test('does not classify Organization with nested Person as a profile', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Organization","name":"Acme","founder":{"@type":"Person","name":"Ada"}}</script>
    </head><body><h1>About</h1><p>${'word '.repeat(40)}</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/about');

    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.structuredData.types).not.toContain('Person');
    expect(classifyPage(parsed).pageKind).toBe(UNDEFINED_TYPE);
  });
  test('nested SpeakableSpecification sets hasSpeakable', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Article","headline":"T","speakable":{"@type":"SpeakableSpecification","cssSelector":["h1"]}}</script>
    </head><body><h1>T</h1><p>${'word '.repeat(40)}</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/page');

    expect(parsed.structuredData.types).toContain('Article');
    expect(parsed.structuredData.types.some((t) => t.toLowerCase().includes('speakable'))).toBe(
      false,
    );
    expect(parsed.hasSpeakable).toBe(true);
  });
});
