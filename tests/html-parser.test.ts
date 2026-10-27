import { describe, expect, test } from 'bun:test';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { isBylineParagraph } from '../src/engine/parsers/contentSignals.ts';
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
  test('uses schema and og:type, the root path for home, otherwise undefined', () => {
    const home = parseHtmlPage(PAGE_HTML, 'https://example.com/');

    expect(UNDEFINED_TYPE).toBe('Undefined');
    expect(classifyPage(home, 'https://example.com/')).toEqual({
      siteType: 'Undefined',
      pageKind: 'home',
    });
    const productHtml = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Widget"}</script></head><body><h1>Widget</h1></body></html>`;
    const productUrl = 'https://example.com/widgets/widget';

    expect(classifyPage(parseHtmlPage(productHtml, productUrl), productUrl)).toEqual({
      siteType: 'ecommerce',
      pageKind: 'product',
    });
    const cartHtml = `<html><body><h1>Shop</h1><p>Add to cart then checkout</p></body></html>`;

    expect(
      classifyPage(parseHtmlPage(cartHtml, 'https://example.com/cart'), 'https://example.com/cart'),
    ).toEqual({
      siteType: UNDEFINED_TYPE,
      pageKind: UNDEFINED_TYPE,
    });
    const websiteHtml = `<html><head><meta property="og:type" content="website"/></head><body><h1>Home</h1></body></html>`;

    expect(
      classifyPage(
        parseHtmlPage(websiteHtml, 'https://example.com/blog/post'),
        'https://example.com/blog/post',
      ),
    ).toEqual({
      siteType: UNDEFINED_TYPE,
      pageKind: UNDEFINED_TYPE,
    });
    const newsHtml = `<html><head><script type="application/ld+json">{"@type":"NewsMediaOrganization","name":"Paper"}</script></head><body><h1>Paper</h1></body></html>`;

    expect(
      classifyPage(parseHtmlPage(newsHtml, 'https://example.com/'), 'https://example.com/'),
    ).toEqual({
      siteType: 'publisher',
      pageKind: 'home',
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
    expect(parsed.headings.h2).toEqual(['What we do', 'How it works']);
    expect(parsed.images).toEqual({
      total: 1,
      withAlt: 1,
      decorative: 0,
      missingAlt: 0,
      items: [
        {
          src: '/logo.png',
          alt: 'Example logo',
          width: null,
          height: null,
          srcset: null,
          loading: null,
          fetchPriority: null,
          nearby: null,
          hero: false,
        },
      ],
    });
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
    expect(parsed.dates).toEqual({ published: null, modified: null, visible: null });
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
    expect(parsed.author).toEqual({ hasAuthor: true, names: ['Desk'], urls: [] });
    expect(parsed.dates.published).toBe('2026-09-10');
    expect(parsed.metaRobotsByBot.googlebot).toBe('noindex');
    expect(parsed.discover).toEqual({ maxImagePreviewLarge: true, hasRepresentativeImage: true });
    expect(parsed.images).toEqual({
      total: 1,
      withAlt: 0,
      decorative: 0,
      missingAlt: 1,
      items: [
        {
          src: '/a.png',
          alt: null,
          width: null,
          height: null,
          srcset: null,
          loading: null,
          fetchPriority: null,
          nearby: null,
          hero: false,
        },
      ],
    });
  });
  test('reads JSON-LD author arrays', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      author: [{ '@type': 'Person', name: 'Jane' }],
    })}</script></head><body><p>Hi</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/news');

    expect(parsed.author).toEqual({ hasAuthor: true, names: ['Jane'], urls: [] });
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
    const html = `<html><body><div id="root"></div>${scripts}<h2>FAQ</h2><h3>How does it work?</h3></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/app');

    expect(parsed.jsRenderingRisk.isLikelyCsr).toBe(true);
    expect(parsed.contentSignals.hasFaqPattern).toBe(true);
  });
  test.each([
    'Frequently asked questions',
    'Perguntas frequentes',
    'Preguntas frecuentes',
    'Questions fréquentes',
  ])('detects an FAQ heading phrased as "%s"', (heading) => {
    const html = `<html><body><main><h2>${heading}</h2><h3>How do I start?</h3><p>Answer.</p></main></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/help');

    expect(parsed.contentSignals.hasFaqPattern).toBe(true);
  });
  test('does not flag a heading without an FAQ phrase', () => {
    const html = `<html><body><main><h2>Shipping and returns</h2><p>Answer.</p></main></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/help');

    expect(parsed.contentSignals.hasFaqPattern).toBe(false);
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
    expect(classifyPage(parsed, 'https://example.com/page').pageKind).toBe('article');
  });
  test('does not classify Organization with nested Person as a profile', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Organization","name":"Acme","founder":{"@type":"Person","name":"Ada"}}</script>
    </head><body><h1>About</h1><p>${'word '.repeat(40)}</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/about');

    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.structuredData.types).not.toContain('Person');
    expect(classifyPage(parsed, 'https://example.com/page').pageKind).toBe(UNDEFINED_TYPE);
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
  test('counts empty alt as decorative, not missing', () => {
    const html = `<html><body>
      <img src="/present.png" alt=""/>
      <img src="/absent.png"/>
      <img alt="no-src"/>
      <img src="   "/>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.images.total).toBe(2);
    expect(parsed.images.withAlt).toBe(1);
    expect(parsed.images.decorative).toBe(1);
    expect(parsed.images.missingAlt).toBe(1);
    expect(parsed.images.items).toEqual([
      {
        src: '/present.png',
        alt: '',
        width: null,
        height: null,
        srcset: null,
        loading: null,
        fetchPriority: null,
        nearby: null,
        hero: false,
      },
      {
        src: '/absent.png',
        alt: null,
        width: null,
        height: null,
        srcset: null,
        loading: null,
        fetchPriority: null,
        nearby: null,
        hero: false,
      },
    ]);
  });
  test('stores a whitespace alt as empty and strips userinfo from image and hreflang urls', () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="en" href="https://user:secret@example.com/en"/>
    </head><body>
      <img src="https://user:secret@cdn.example/a.png" alt="   "/>
      <a href="https://user:secret@example.com/about">About</a>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.images.items).toEqual([
      {
        src: 'https://cdn.example/a.png',
        alt: '',
        width: null,
        height: null,
        srcset: null,
        loading: null,
        fetchPriority: null,
        nearby: 'About',
        hero: false,
      },
    ]);
    expect(parsed.images.missingAlt).toBe(0);
    expect(parsed.images.decorative).toBe(1);
    expect(parsed.hreflangLinks).toEqual([{ lang: 'en', href: 'https://example.com/en' }]);
    expect(parsed.internalLinks).toEqual([
      { href: 'https://example.com/about', text: 'About', ariaLabel: null, imgAlt: null },
    ]);
  });
  test('caps h2 and h3 text at 40 and still counts every element', () => {
    const headings = Array.from({ length: 41 }, (_, index) => `<h2>H ${index}</h2>`).join('');
    const html = `<html><body><h2>   </h2>${headings}<h3>Sub</h3></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.headings.h2Count).toBe(42);
    expect(parsed.headings.h2).toHaveLength(40);
    expect(parsed.headings.h2[0]).toBe('H 0');
    expect(parsed.headings.h3).toEqual(['Sub']);
    expect(parsed.headings.h3Count).toBe(1);
  });
  test('counts every internal link and stores the first 50', () => {
    const links = Array.from(
      { length: 51 },
      (_, index) => `<a href="/p/${index}">${index}</a>`,
    ).join('');
    const html = `<html><body>${links}<a href="/p/0">again</a><a href="mailto:a@b.c">m</a><a href="https://other.test/x">o</a></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/page');

    expect(parsed.internalLinks).toHaveLength(50);
    expect(parsed.internalLinkCount).toBe(51);
    expect(parsed.internalLinksTruncated).toBe(true);
    expect(parsed.internalLinks[0]).toEqual({
      href: 'https://example.com/p/0',
      text: '0',
      ariaLabel: null,
      imgAlt: null,
    });
    expect(parsed.outboundLinks).toEqual([
      { href: 'https://other.test/x', text: 'o', ariaLabel: null, imgAlt: null },
    ]);
    expect(parsed.outboundLinksTruncated).toBe(false);
    expect(parsed.internalLinkIndex).toContain('example.com/p/50');
    expect(parsed.internalLinkIndexTruncated).toBe(false);
  });
  test('resolves hreflang hrefs that are http(s) and keeps every code', () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="en" href="/en"/>
      <link rel="alternate" hreflang="pt" href="https://example.com/pt"/>
      <link rel="alternate" hreflang="x"/>
      <link rel="alternate" hreflang="js" href="javascript:alert(1)"/>
    </head><body></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/page');

    expect(parsed.hreflang).toEqual(['en', 'pt', 'x', 'js']);
    expect(parsed.hreflangLinks).toEqual([
      { lang: 'en', href: 'https://example.com/en' },
      { lang: 'pt', href: 'https://example.com/pt' },
    ]);
  });
  test('reads pagination links and an author url on the same host', () => {
    const html = `<html><head>
      <link rel="next" href="/page/2"/>
      <link rel="prev" href="https://evil.test/back"/>
      <a rel="author" href="/authors/jane">Jane</a>
    </head><body><p>Hi</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');

    expect(parsed.pagination).toEqual({
      next: 'https://example.com/page/2',
      prev: 'https://evil.test/back',
    });
    expect(parsed.author.urls).toEqual(['https://example.com/authors/jane']);
  });
  test('reads og:url and the breadcrumb parent', () => {
    const html = `<html><head>
      <meta property="og:url" content="https://www.example.com/blog/post/"/>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
          { '@type': 'ListItem', position: 2, item: 'https://example.com/blog' },
          { '@type': 'ListItem', position: 3, item: 'https://example.com/blog/post' },
        ],
      })}</script>
    </head><body><p>Hi there friend</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');

    expect(parsed.social.openGraph.url).toBe('https://www.example.com/blog/post/');
    expect(parsed.breadcrumbParent).toBe('https://example.com/blog');
    expect(parsed.visibleTextExcerpt).toBe('Hi there friend');
    expect(parsed.visibleTextSha256).toHaveLength(64);
  });
  test('takes the breadcrumb parent when the current page item has no URL', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
          { '@type': 'ListItem', position: 2, item: 'https://example.com/blog' },
          { '@type': 'ListItem', position: 3, name: 'Post' },
        ],
      })}</script>
    </head><body><p>Hi there friend</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');

    expect(parsed.breadcrumbParent).toBe('https://example.com/blog');
  });
  test('orders breadcrumb items by position before picking the parent', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 3, name: 'Post' },
          { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
          { '@type': 'ListItem', position: 2, item: 'https://example.com/blog' },
        ],
      })}</script>
    </head><body><p>Hi there friend</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');

    expect(parsed.breadcrumbParent).toBe('https://example.com/blog');
  });
  test('returns no JSON-LD parent when the parent item has no URL', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
          { '@type': 'ListItem', position: 2, name: 'Blog' },
          { '@type': 'ListItem', position: 3, name: 'Post' },
        ],
      })}</script>
    </head><body><p>Hi there friend</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');

    expect(parsed.breadcrumbParent).toBeNull();
  });
  test('stores every heading when the cap is infinite', () => {
    const headings = Array.from({ length: 41 }, (_, index) => `<h2>H${index}</h2>`).join('');
    const parsed = parseHtmlPage(
      `<html><body>${headings}</body></html>`,
      'https://example.com/',
      Number.POSITIVE_INFINITY,
    );

    expect(parsed.headings.h2).toHaveLength(41);
  });
  test('stores social strings, snippet directives, image size, and missing schema props', () => {
    const html = `<html><head>
      <meta property="og:title" content="Post title"/>
      <meta property="og:image" content="/hero.jpg"/>
      <meta name="twitter:card" content="summary_large_image"/>
      <meta name="robots" content="max-snippet:120, noarchive, unavailable_after: 1 Jan 2030 00:00:00 GMT"/>
      <meta name="googlebot" content="nosnippet"/>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Article',
        author: 'Ada',
        datePublished: '2020-01-01',
      })}</script>
    </head><body>
      <img src="/hero.jpg" width="800" height="400" loading="lazy" srcset="/hero.jpg 800w" alt="Hero"/>
      <p data-nosnippet>Hidden</p>
      <div itemtype="https://schema.org/Article" itemscope></div>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');
    const article = parsed.structuredData.blocks.find((block) => block.type === 'Article');

    expect(parsed.social.openGraph.title).toBe('Post title');
    expect(parsed.social.openGraph.image).toBe('https://example.com/hero.jpg');
    expect(parsed.social.twitter.card).toBe('summary_large_image');
    expect(parsed.snippetDirectives).toEqual({
      nosnippet: true,
      maxSnippet: '120',
      noarchive: true,
      unavailableAfter: '1 Jan 2030 00:00:00 GMT',
      dataNosnippet: true,
    });
    expect(parsed.images.items[0]).toMatchObject({
      width: '800',
      height: '400',
      loading: 'lazy',
      srcset: '/hero.jpg 800w',
    });
    expect(article?.missingProps).toEqual(['headline']);
    expect(article?.hasRequiredProps).toBe(false);
    expect(parsed.markupFormats.microdata_types).toEqual(['Article']);
  });
  test('reads page facts the audit quotes', () => {
    const html = `<html><head>
      <link rel="alternate hreflang" hreflang="en" href="/en"/>
      <meta name="googlebot" content="noindex"/>
      <meta name="slurp" content="noindex"/>
    </head><body>
      <nav aria-label="Breadcrumb"><a href="/">Home</a><a href="/blog">Blog</a><span>Post</span></nav>
      <a rel="next" href="/page/2">Next</a>
      <a href="https://www.example.com/about">About</a>
      <time datetime="2024-01-02">2 Jan 2024</time>
      <p>Short open.</p>
      <picture><source srcset="/wide.jpg 800w"/><img alt="Wide"></picture>
      <video src="/clip.mp4" poster="/poster.jpg"></video>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'What is it?',
            acceptedAnswer: { '@type': 'Answer', text: 'A widget.' },
          },
        ],
      })}</script>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/post');

    expect(parsed.hreflangLinks).toEqual([{ lang: 'en', href: 'https://example.com/en' }]);
    expect(parsed.metaRobotsByBot.slurp).toBe('noindex');
    expect(parsed.pagination.next).toBe('https://example.com/page/2');
    expect(parsed.internalLinks).toEqual([
      { href: 'https://example.com/', text: 'Home', ariaLabel: null, imgAlt: null },
      { href: 'https://example.com/blog', text: 'Blog', ariaLabel: null, imgAlt: null },
      { href: 'https://example.com/page/2', text: 'Next', ariaLabel: null, imgAlt: null },
      { href: 'https://www.example.com/about', text: 'About', ariaLabel: null, imgAlt: null },
    ]);
    expect(parsed.breadcrumbParent).toBe('https://example.com/');
    expect(parsed.dates.visible).toBe('2024-01-02');
    expect(parsed.citabilityOpening).toBe('Short open.');
    expect(parsed.images.items[0]?.src).toBe('/wide.jpg');
    expect(parsed.images.items[0]?.hero).toBe(false);
    expect(parsed.videos).toEqual([
      { src: 'https://example.com/clip.mp4', poster: 'https://example.com/poster.jpg' },
    ]);
    expect(parsed.structuredData.faqPairs).toEqual([
      { question: 'What is it?', answer: 'A widget.' },
    ]);
    expect(parsed.headings.h2NonEmpty).toBe(0);
  });
});

describe('hasTopSummary and bylines', () => {
  const SUMMARY =
    'Um tênis de trail precisa de drop, solado e proteção. Escolha pelo terreno que você corre.';

  test.each([
    'Por Ana Souza, publicado em 10/03/2026, atualizado em 02/09/2026.',
    'By Ana Souza, published March 10, 2026.',
    'Por: Ana Souza',
    'Publicado em 10 de março de 2026',
    'Updated 2026-09-02',
  ])('reads "%s" as a byline', (text) => {
    expect(isBylineParagraph(text)).toBe(true);
  });
  test.each([
    'Por isso, escolha o drop certo para o seu terreno e a sua passada.',
    'O drop de cada tênis fica entre 4 e 12 mm, segundo o modelo testado em trilhas de Minas Gerais.',
  ])('does not read "%s" as a byline', (text) => {
    expect(isBylineParagraph(text)).toBe(false);
  });
  test('skips a byline first paragraph and uses the next paragraph as the summary', () => {
    const html = `<html><body><main><h1>Guia</h1><p>Por Ana Souza, publicado em 10/03/2026, atualizado em 02/09/2026.</p><p>${SUMMARY}</p></main></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/guia');

    expect(parsed.contentSignals.hasTopSummary).toBe(true);
    expect(parsed.citabilityOpening).toBe(SUMMARY);
  });
  test('a byline with no answer after it is not a top summary', () => {
    const html = `<html><body><main><p>Por Ana Souza, publicado em 10/03/2026.</p></main></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/guia');

    expect(parsed.contentSignals.hasTopSummary).toBe(false);
  });
  test('a first paragraph that is a real summary stays a top summary', () => {
    const html = `<html><body><main><p>${SUMMARY}</p><p>Por Ana Souza, publicado em 10/03/2026.</p></main></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/guia');

    expect(parsed.contentSignals.hasTopSummary).toBe(true);
  });
});
