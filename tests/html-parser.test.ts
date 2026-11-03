import { describe, expect, test } from 'bun:test';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { isBylineParagraph } from '../src/engine/parsers/contentSignals.ts';
import type { ImageItem } from '../src/engine/parsers/imageDiscover.ts';
import {
  classifyPage,
  expectedSchemaTypes,
  UNDEFINED_TYPE,
} from '../src/engine/pageClassification.ts';
import { PAGE_HTML } from './engine-fixtures.ts';

const PAGE = 'https://example.com/page';

const LONG = 'word '.repeat(40);

function image(over: Partial<ImageItem> & Pick<ImageItem, 'src'>): ImageItem {
  return {
    alt: null,
    width: null,
    height: null,
    srcset: null,
    loading: null,
    fetchPriority: null,
    nearby: null,
    hero: false,
    ...over,
  };
}

function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function breadcrumb(items: unknown[]): string {
  return jsonLd({ '@type': 'BreadcrumbList', itemListElement: items });
}

describe('expectedSchemaTypes', () => {
  test('returns the unique schema types for a page kind and site type', () => {
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
    expect(expectedSchemaTypes('local-business', 'profile')).toEqual([
      'Person',
      'LocalBusiness',
      'Organization',
    ]);
    expect(expectedSchemaTypes(UNDEFINED_TYPE, UNDEFINED_TYPE)).toEqual([]);
  });
});

describe('classifyPage', () => {
  test('the root path is home; schema and og:type set the site type and kind', () => {
    const home = parseHtmlPage(PAGE_HTML, 'https://example.com/');

    expect(classifyPage(home, 'https://example.com/')).toEqual({
      siteType: 'Undefined',
      pageKind: 'home',
    });
    expect(UNDEFINED_TYPE).toBe('Undefined');
  });
  test.each<[string, string, string, ReturnType<typeof classifyPage>]>([
    [
      'Product schema',
      `<html><head>${jsonLd({ '@type': 'Product', name: 'Widget' })}</head><body><h1>Widget</h1></body></html>`,
      'https://example.com/widgets/widget',
      { siteType: 'ecommerce', pageKind: 'product' },
    ],
    [
      'NewsMediaOrganization schema on the root',
      `<html><head>${jsonLd({ '@type': 'NewsMediaOrganization', name: 'Paper' })}</head><body><h1>Paper</h1></body></html>`,
      'https://example.com/',
      { siteType: 'publisher', pageKind: 'home' },
    ],
    [
      'no schema and cart copy',
      '<html><body><h1>Shop</h1><p>Add to cart then checkout</p></body></html>',
      'https://example.com/cart',
      { siteType: UNDEFINED_TYPE, pageKind: UNDEFINED_TYPE },
    ],
    [
      'og:type website on an inner page',
      '<html><head><meta property="og:type" content="website"/></head><body><h1>Home</h1></body></html>',
      'https://example.com/blog/post',
      { siteType: UNDEFINED_TYPE, pageKind: UNDEFINED_TYPE },
    ],
  ])('%s', (_name, html, url, expected) => {
    expect(classifyPage(parseHtmlPage(html, url), url)).toEqual(expected);
  });
});

describe('parseHtmlPage', () => {
  test('reads the core fields from the fixture', () => {
    const parsed = parseHtmlPage(PAGE_HTML, 'https://example.com/');

    expect(parsed).toMatchObject({
      title: expect.stringContaining('Example Company'),
      metaDescription: expect.stringContaining('widgets'),
      canonicalUrl: 'https://example.com/',
      robotsDirective: null,
      lang: 'en',
      viewport: true,
      sitemapUrls: [],
      hasSpeakable: false,
      jsRenderingRisk: { isLikelyCsr: false, reason: null },
      dates: { published: null, modified: null, visible: null },
      author: { hasAuthor: false, names: [], urls: [] },
      discover: { hasRepresentativeImage: false },
      markupFormats: { jsonld_only: true },
    });
    expect(parsed.wordCount).toBeGreaterThan(0);
    expect(parsed.headings).toMatchObject({
      h1: ['Example Company'],
      h1Count: 1,
      h1ElementCount: 1,
      h2: ['What we do', 'How it works'],
      h2Count: 2,
    });
    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.images).toEqual({
      total: 1,
      withAlt: 1,
      decorative: 0,
      missingAlt: 0,
      items: [image({ src: '/logo.png', alt: 'Example logo' })],
    });
    expect(parsed.citabilityTexts.length).toBeGreaterThan(0);
  });
  test('reads a custom sitemap from link rel and sitemap-named anchors', () => {
    const html = `<html><head><link rel="Sitemap alternate" href="/news-sitemap.xml"/></head><body>
      <a href="/wp-sitemap.xml">xml</a>
      <a href="/blog/what-is-a-sitemap">article</a>
    </body></html>`;

    expect(parseHtmlPage(html, PAGE).sitemapUrls).toEqual([
      'https://example.com/news-sitemap.xml',
      'https://example.com/wp-sitemap.xml',
    ]);
  });
  test('reads the author, dates, per-bot robots, discover signals and missing alt', () => {
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
      items: [image({ src: '/a.png' })],
    });
  });
  test('reads JSON-LD author arrays', () => {
    const html = `<html><head>${jsonLd({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      author: [{ '@type': 'Person', name: 'Jane' }],
    })}</head><body><p>Hi</p></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/news').author).toEqual({
      hasAuthor: true,
      names: ['Jane'],
      urls: [],
    });
  });
  test('og:url is not a canonical, and a non-http canonical is dropped', () => {
    const ogOnly = `<html><head><meta property="og:url" content="https://example.com/og"/></head><body><p>Hi</p></body></html>`;
    const jsCanonical = `<html><head><link rel="canonical" href="javascript:alert(1)"/></head><body><p>Hi</p></body></html>`;

    expect(parseHtmlPage(ogOnly, PAGE).canonicalUrl).toBeNull();
    expect(parseHtmlPage(jsCanonical, PAGE).canonicalUrl).toBeNull();
  });
  test('flags a client-rendered shell and an FAQ heading with a question', () => {
    const scripts = '<script src="/a.js"></script>'.repeat(5);
    const html = `<html><body><div id="root"></div>${scripts}<h2>FAQ</h2><h3>How does it work?</h3></body></html>`;
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
  test('reads mixed-case googlebot noindex and JSON-LD wrapped in an HTML comment', () => {
    const html = `<html><head>
      <meta name="Googlebot" content="noindex"/>
      <script type="application/ld+json"><!--{"@type":"Organization","name":"Acme","url":"https://example.com"}--></script>
    </head><body><p>Hi</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.metaRobotsByBot.googlebot).toBe('noindex');
    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.schemaBlocks[0]?.parseError).toBeUndefined();
  });
  test('normalizes a JSON-LD IRI @type and mixed-case meta and link names', () => {
    const html = `<html><head>
      <link rel="Canonical" href="https://example.com/page"/>
      <meta name="Author" content="Ada"/>
      <meta name="Robots" content="max-image-preview:large"/>
      ${jsonLd({ '@type': 'https://schema.org/Article', headline: 'T', datePublished: '2026-01-01', author: 'Ada' })}
    </head><body><h1>T</h1><p>${LONG}</p></body></html>`;
    const parsed = parseHtmlPage(html, PAGE);

    expect(parsed.canonicalUrl).toBe(PAGE);
    expect(parsed.author.names).toContain('Ada');
    expect(parsed.discover.maxImagePreviewLarge).toBe(true);
    expect(parsed.structuredData.types).toContain('Article');
    expect(classifyPage(parsed, PAGE).pageKind).toBe('article');
  });
  test('a nested Person does not make an Organization a profile', () => {
    const html = `<html><head>${jsonLd({ '@type': 'Organization', name: 'Acme', founder: { '@type': 'Person', name: 'Ada' } })}</head><body><h1>About</h1><p>${LONG}</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/about');

    expect(parsed.structuredData.types).toContain('Organization');
    expect(parsed.structuredData.types).not.toContain('Person');
    expect(classifyPage(parsed, PAGE).pageKind).toBe(UNDEFINED_TYPE);
  });
  test('a nested SpeakableSpecification sets hasSpeakable without adding a type', () => {
    const html = `<html><head>${jsonLd({ '@type': 'Article', headline: 'T', speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1'] } })}</head><body><h1>T</h1><p>${LONG}</p></body></html>`;
    const parsed = parseHtmlPage(html, PAGE);

    expect(parsed.structuredData.types).toEqual(['Article']);
    expect(parsed.hasSpeakable).toBe(true);
  });
  test('empty alt counts as decorative, a missing alt as missing, a blank src is skipped', () => {
    const html = `<html><body>
      <img src="/present.png" alt=""/>
      <img src="/absent.png"/>
      <img alt="no-src"/>
      <img src="   "/>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.images).toMatchObject({ total: 2, withAlt: 1, decorative: 1, missingAlt: 1 });
    expect(parsed.images.items).toEqual([
      image({ src: '/present.png', alt: '' }),
      image({ src: '/absent.png' }),
    ]);
  });
  test('strips userinfo from image, hreflang and link urls and stores a blank alt as empty', () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="en" href="https://user:secret@example.com/en"/>
    </head><body>
      <img src="https://user:secret@cdn.example/a.png" alt="   "/>
      <a href="https://user:secret@example.com/about">About</a>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/');

    expect(parsed.images.items).toEqual([
      image({ src: 'https://cdn.example/a.png', alt: '', nearby: 'About' }),
    ]);
    expect(parsed.images).toMatchObject({ missingAlt: 0, decorative: 1 });
    expect(parsed.hreflangLinks).toEqual([{ lang: 'en', href: 'https://example.com/en' }]);
    expect(parsed.internalLinks).toEqual([
      { href: 'https://example.com/about', text: 'About', ariaLabel: null, imgAlt: null },
    ]);
  });
  test('caps h2 text at 40 entries but still counts every element', () => {
    const headings = Array.from({ length: 41 }, (_, index) => `<h2>H ${index}</h2>`).join('');
    const parsed = parseHtmlPage(
      `<html><body><h2>   </h2>${headings}<h3>Sub</h3></body></html>`,
      'https://example.com/',
    );

    expect(parsed.headings.h2Count).toBe(42);
    expect(parsed.headings.h2).toHaveLength(40);
    expect(parsed.headings.h2[0]).toBe('H 0');
    expect(parsed.headings.h3).toEqual(['Sub']);
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
  test('counts every internal link, stores the first 50, and ignores mailto', () => {
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
    expect(parsed.internalLinkIndex).toContain('example.com/p/50');
    expect(parsed.internalLinkIndexTruncated).toBe(false);
  });
  test('keeps every hreflang code but only http(s) hrefs in hreflangLinks', () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="en" href="/en"/>
      <link rel="alternate" hreflang="pt" href="https://example.com/pt"/>
      <link rel="alternate" hreflang="x"/>
      <link rel="alternate" hreflang="js" href="javascript:alert(1)"/>
    </head><body></body></html>`;
    const parsed = parseHtmlPage(html, PAGE);

    expect(parsed.hreflang).toEqual(['en', 'pt', 'x', 'js']);
    expect(parsed.hreflangLinks).toEqual([
      { lang: 'en', href: 'https://example.com/en' },
      { lang: 'pt', href: 'https://example.com/pt' },
    ]);
  });
  test('reads pagination links, and an author url on the same host', () => {
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
  test('reads og:url, the breadcrumb parent and the visible excerpt', () => {
    const html = `<html><head>
      <meta property="og:url" content="https://www.example.com/blog/post/"/>
      ${breadcrumb([
        { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, item: 'https://example.com/blog' },
        { '@type': 'ListItem', position: 3, item: 'https://example.com/blog/post' },
      ])}
    </head><body><p>Hi there friend</p></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');

    expect(parsed.social.openGraph.url).toBe('https://www.example.com/blog/post/');
    expect(parsed.breadcrumbParent).toBe('https://example.com/blog');
    expect(parsed.visibleTextExcerpt).toBe('Hi there friend');
    expect(parsed.visibleTextSha256).toHaveLength(64);
  });
  test.each([
    [
      'the current item has no URL',
      [
        { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, item: 'https://example.com/blog' },
        { '@type': 'ListItem', position: 3, name: 'Post' },
      ],
      'https://example.com/blog',
    ],
    [
      'items are out of order',
      [
        { '@type': 'ListItem', position: 3, name: 'Post' },
        { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, item: 'https://example.com/blog' },
      ],
      'https://example.com/blog',
    ],
    [
      'the parent item has no URL',
      [
        { '@type': 'ListItem', position: 1, item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, name: 'Blog' },
        { '@type': 'ListItem', position: 3, name: 'Post' },
      ],
      null,
    ],
  ])('breadcrumb parent when %s', (_name, items, parent) => {
    const html = `<html><head>${breadcrumb(items)}</head><body><p>Hi there friend</p></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/blog/post').breadcrumbParent).toBe(parent);
  });
  test('reads social strings, snippet directives, image size, microdata and missing schema props', () => {
    const html = `<html><head>
      <meta property="og:title" content="Post title"/>
      <meta property="og:image" content="/hero.jpg"/>
      <meta name="twitter:card" content="summary_large_image"/>
      <meta name="robots" content="max-snippet:120, noarchive, unavailable_after: 1 Jan 2030 00:00:00 GMT"/>
      <meta name="googlebot" content="nosnippet"/>
      ${jsonLd({ '@type': 'Article', author: 'Ada', datePublished: '2020-01-01' })}
    </head><body>
      <img src="/hero.jpg" width="800" height="400" loading="lazy" srcset="/hero.jpg 800w" alt="Hero"/>
      <p data-nosnippet>Hidden</p>
      <div itemtype="https://schema.org/Article" itemscope></div>
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/post');
    const article = parsed.structuredData.blocks.find((block) => block.type === 'Article');

    expect(parsed.social.openGraph).toMatchObject({
      title: 'Post title',
      image: 'https://example.com/hero.jpg',
    });
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
  test('reads the page facts the audit quotes', () => {
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
      ${jsonLd({
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'What is it?',
            acceptedAnswer: { '@type': 'Answer', text: 'A widget.' },
          },
        ],
      })}
    </body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/post');

    expect(parsed.hreflangLinks).toEqual([{ lang: 'en', href: 'https://example.com/en' }]);
    expect(parsed.metaRobotsByBot.slurp).toBe('noindex');
    expect(parsed.pagination.next).toBe('https://example.com/page/2');
    expect(parsed.internalLinks.map((link) => link.href)).toEqual([
      'https://example.com/',
      'https://example.com/blog',
      'https://example.com/page/2',
      'https://www.example.com/about',
    ]);
    expect(parsed.breadcrumbParent).toBe('https://example.com/');
    expect(parsed.dates.visible).toBe('2024-01-02');
    expect(parsed.citabilityOpening).toBe('Short open.');
    expect(parsed.images.items[0]).toMatchObject({ src: '/wide.jpg', hero: false });
    expect(parsed.videos).toEqual([
      { src: 'https://example.com/clip.mp4', poster: 'https://example.com/poster.jpg' },
    ]);
    expect(parsed.structuredData.faqPairs).toEqual([
      { question: 'What is it?', answer: 'A widget.' },
    ]);
    expect(parsed.headings.h2NonEmpty).toBe(0);
  });
});

describe('FAQ headings', () => {
  test.each([
    'Frequently asked questions',
    'Perguntas frequentes',
    'Preguntas frecuentes',
    'Questions fréquentes',
  ])('detects an FAQ heading phrased as "%s"', (heading) => {
    const html = `<html><body><main><h2>${heading}</h2><h3>How do I start?</h3><p>Answer.</p></main></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/help').contentSignals.hasFaqPattern).toBe(true);
  });
  test('a heading without an FAQ phrase is not flagged', () => {
    const html = `<html><body><main><h2>Shipping and returns</h2><p>Answer.</p></main></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/help').contentSignals.hasFaqPattern).toBe(
      false,
    );
  });
});

describe('question headings and bylines', () => {
  test.each([
    'How to reset your password',
    'Como escolher um tênis?',
    'What is drop?',
    'Can I run on trails?',
  ])('counts "%s" as a question heading', (heading) => {
    const html = `<html><body><main><h1>Guia</h1><h2>${heading}</h2><p>Resposta curta e direta.</p></main></body></html>`;

    expect(
      parseHtmlPage(html, 'https://example.com/blog/guia').contentSignals.question_heading_count,
    ).toBeGreaterThan(0);
  });
  test('a statement that starts with "Why" is not a question heading', () => {
    const html = `<html><body><main><h1>Guia</h1><h2>Why choose Acme</h2><p>Resposta.</p></main></body></html>`;

    expect(
      parseHtmlPage(html, 'https://example.com/blog/guia').contentSignals.question_heading_count,
    ).toBe(0);
  });
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
});

describe('opening paragraph and top summary', () => {
  const SUMMARY =
    'Um tênis de trail precisa de drop, solado e proteção. Escolha pelo terreno que você corre.';
  const BYLINE = 'Por Ana Souza, publicado em 10/03/2026, atualizado em 02/09/2026.';

  test('a leading byline is skipped and the next paragraph is the opening and summary', () => {
    const html = `<html><body><main><h1>Guia</h1><p>${BYLINE}</p><p>${SUMMARY}</p></main></body></html>`;
    const parsed = parseHtmlPage(html, 'https://example.com/blog/guia');

    expect(parsed.contentSignals.hasTopSummary).toBe(true);
    expect(parsed.citabilityOpening).toBe(SUMMARY);
  });
  test('a byline with no answer after it is not a top summary', () => {
    const html = `<html><body><main><p>Por Ana Souza, publicado em 10/03/2026.</p></main></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/blog/guia').contentSignals.hasTopSummary).toBe(
      false,
    );
  });
  test('a real summary first paragraph stays a top summary', () => {
    const html = `<html><body><main><p>${SUMMARY}</p><p>${BYLINE}</p></main></body></html>`;

    expect(parseHtmlPage(html, 'https://example.com/blog/guia').contentSignals.hasTopSummary).toBe(
      true,
    );
  });
});
