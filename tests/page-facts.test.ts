import { describe, expect, test } from 'bun:test';
import { bundleFromHtml } from './engine-fixtures.ts';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { mergeRobotsDirectives } from '../src/engine/robotsDirective.ts';
import { classifyPage } from '../src/engine/pageClassification.ts';
import { collectFindings } from '../src/engine/findings.ts';
import {
  pageContentFindings,
  pageLinkFindings,
  pageMetaFindings,
} from '../src/engine/pageFindings.ts';
import { parseLlmsTxt } from '../src/tools/llmstxt/parseLlmsTxt.ts';
import { parsedLlmsIssues } from '../src/engine/llms.ts';
import {
  startLighthouse,
  type LighthouseSpawn,
  type LighthouseSpawnOutcome,
} from '../src/engine/lighthouse.ts';

const PAGE = 'https://example.com/';
const PIN = '93.184.216.34';

function findingById<T extends { id: string }>(findings: readonly T[], id: string) {
  return findings.find((finding) => finding.id === id);
}

describe('trust pages', () => {
  test('a headline containing "sobre" does not claim the about page', () => {
    const html = `<html><body><main>
      <a href="/noticias/tite">Tite comenta a avaliação de Tite sobre a seleção</a>
      <a href="/noticias/copa-sobre-tudo">Copa</a>
    </main></body></html>`;

    expect(parseHtmlPage(html, PAGE).trustPages.about).toBeNull();
  });
  test('matches a whole path segment or the whole anchor text', () => {
    const html = `<html><body>
      <a href="/sobre-nos">Institucional</a>
      <a href="/politica-de-privacidade">Política de Privacidade</a>
      <a href="/termos-de-uso.html">Termos</a>
      <a href="/contato">Sobre</a>
    </body></html>`;
    const trust = parseHtmlPage(html, PAGE).trustPages;

    expect(trust.about).toBe('https://example.com/sobre-nos');

    expect(trust.privacy).toBe('https://example.com/politica-de-privacidade');

    expect(trust.terms).toBe('https://example.com/termos-de-uso.html');

    expect(trust.contact).toBe('https://example.com/contato');
  });
  test('a label inside a longer path segment does not match', () => {
    const html = `<html><body><a href="/noticias/sobre-tite-na-copa">Copa</a></body></html>`;

    expect(parseHtmlPage(html, PAGE).trustPages.about).toBeNull();
  });
});

describe('anchor text', () => {
  test('flags every empty anchor by href and skips anchors with an aria-label or image alt', () => {
    const empty = Array.from({ length: 22 }, (_, i) => `<a href="/icon/${i}"></a>`).join('');
    const html = `<html><body><main>
      <a href="/with-label" aria-label="Abrir menu"></a>
      <a href="/with-image"><img src="/x.png" alt="Logo da loja"/></a>
      <a href="/empty-image"><img src="/y.png" alt=""/></a>
      ${empty}
    </main></body></html>`;
    const bundle = bundleFromHtml(html);
    const finding = findingById(pageLinkFindings(bundle), 'links:anchor-text');

    expect(finding?.severity).toBe('warn');
    expect(finding?.detail).toContain('(no text) → https://example.com/empty-image');
    expect(finding?.detail).toContain('(no text) → https://example.com/icon/0');
    expect(finding?.detail).not.toContain('/with-label');
    expect(finding?.detail).not.toContain('/with-image');
    expect(finding?.detail).toContain('(+3 more)');
  });
  test('stores aria-label and the first non-empty img alt on each link', () => {
    const html = `<html><body>
      <a href="/a" aria-label=" Fechar "></a>
      <a href="/b"><img src="/i.png" alt=""/><img src="/j.png" alt="Ícone"/></a>
      <a href="https://other.test/c">Texto</a>
    </body></html>`;
    const parsed = parseHtmlPage(html, PAGE);

    expect(parsed.internalLinks).toEqual([
      { href: 'https://example.com/a', text: '', ariaLabel: 'Fechar', imgAlt: null },
      { href: 'https://example.com/b', text: '', ariaLabel: null, imgAlt: 'Ícone' },
    ]);
    expect(parsed.outboundLinks).toEqual([
      { href: 'https://other.test/c', text: 'Texto', ariaLabel: null, imgAlt: null },
    ]);
  });
});

describe('robots directive', () => {
  test('dedupes repeated tokens case-insensitively and keeps order', () => {
    const merged = mergeRobotsDirectives(
      'index, follow, max-image-preview:large',
      'Index, follow, max-image-preview:large',
    );

    expect(merged).toBe('index, follow, max-image-preview:large');
    expect(mergeRobotsDirectives('noindex, nofollow', 'nosnippet')).toBe(
      'noindex, nofollow, nosnippet',
    );
    expect(mergeRobotsDirectives(' ', null)).toBeNull();
  });
});

describe('visible date', () => {
  test('prefers a time inside main over a sidebar time earlier in the page', () => {
    const html = `<html><body>
      <aside><time datetime="2026-01-01">sidebar</time></aside>
      <main><time datetime="2024-05-05">article</time></main>
    </body></html>`;

    expect(parseHtmlPage(html, PAGE).dates.visible).toBe('2024-05-05');
  });
  test('falls back to the first time on the page when main has none', () => {
    const html = `<html><body>
      <aside><time datetime="2026-01-01">sidebar</time></aside>
      <main><p>No date here.</p></main>
    </body></html>`;

    expect(parseHtmlPage(html, PAGE).dates.visible).toBe('2026-01-01');
  });
  test('visible_dates is true when only the visible date exists', () => {
    const html = `<html><body><main><time datetime="2024-05-05">May</time></main></body></html>`;
    const bundle = bundleFromHtml(html);

    expect(bundle.platform_signals.visible_dates).toBe(true);
  });
});

describe('page kind', () => {
  const listing = Array.from(
    { length: 15 },
    (_, i) => `<a href="/noticias/${i}">Notícia ${i}</a>`,
  ).join('');
  const html = `<html><body><main>${listing}</main></body></html>`;

  test('a listing path with the listing pattern is listing; the root stays home', () => {
    const parsed = parseHtmlPage(html, 'https://example.com/noticias/');

    expect(parsed.contentSignals.listingPattern).toBe(true);
    expect(classifyPage(parsed, 'https://example.com/noticias/').pageKind).toBe('listing');
    expect(classifyPage(parsed, 'https://example.com/').pageKind).toBe('home');
  });
  test('a non-listing inner page stays Undefined', () => {
    const parsed = parseHtmlPage('<html><body><main><p>Texto.</p></main></body></html>', PAGE);

    expect(classifyPage(parsed, 'https://example.com/sobre').pageKind).toBe('Undefined');
  });
});

describe('external resources', () => {
  const html = `<html><head>
      <script src="https://cdn.one.test/a.js"></script>
      <script src="https://cdn.one.test/b.js"></script>
      <script src="/local.js"></script>
      <script type="application/ld+json">{"@type":"Thing"}</script>
      <script>window.x = 1;</script>
      <link rel="stylesheet" href="https://fonts.example.test/s.css"/>
      <link rel="preload" as="font" href="https://fonts.gstatic.example/f.woff2"/>
      <style>body{}</style>
    </head><body>
      <img src="/hero.jpg" srcset="https://img.two.test/w.jpg 800w, https://img.three.test/n.jpg 400w"/>
      <iframe src="https://video.four.test/embed"></iframe>
      <video src="https://media.five.test/clip.mp4"></video>
      <form action="https://pay.six.test/submit"></form>
    </body></html>`;
  test('lists sorted cross-origin origins per kind and counts inline blocks', () => {
    const resources = parseHtmlPage(html, PAGE).externalResources;

    expect(resources.scripts).toEqual(['https://cdn.one.test']);

    expect(resources.stylesheets).toEqual(['https://fonts.example.test']);

    expect(resources.fonts).toEqual(['https://fonts.gstatic.example']);

    expect(resources.images).toEqual(['https://img.three.test', 'https://img.two.test']);

    expect(resources.frames).toEqual(['https://video.four.test']);

    expect(resources.media).toEqual(['https://media.five.test']);

    expect(resources.forms).toEqual(['https://pay.six.test']);

    expect(resources.inlineScripts).toBe(1);
    expect(resources.inlineStyles).toBe(1);
  });
  test('the CSP finding names the origins when CSP is missing', () => {
    const bundle = bundleFromHtml(html);
    const csp = findingById(collectFindings(bundle, []), 'security:content-security-policy');

    expect(csp?.detail).toContain('external origins: scripts https://cdn.one.test');

    expect(csp?.detail).toContain('inline scripts 1; inline styles 1');
  });
});

describe('schema recommended props', () => {
  test('lists recommended props a block lacks without changing hasRequiredProps', () => {
    const json = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Título',
      datePublished: '2026-01-01',
      author: { '@type': 'Person', name: 'Ana' },
    });
    const html = `<html><head><script type="application/ld+json">${json}</script></head><body><p>x</p></body></html>`;
    const block = parseHtmlPage(html, PAGE).structuredData.blocks[0];

    expect(block?.type).toBe('NewsArticle');
    expect(block?.recommendedMissing).toContain('image');
    expect(block?.recommendedMissing).not.toContain('headline');
    expect(block?.hasRequiredProps).toBe(true);
  });
});

describe('llms.txt issues', () => {
  test('merges structural problems and syntax errors into issues with line and text', () => {
    const content = '# Site\n\n## Docs\n- not a link here\n> stray quote\n';
    const issues = parsedLlmsIssues(parseLlmsTxt(content));

    expect(issues).toContainEqual({
      code: 'invalid_list_link',
      line: 4,
      text: '- not a link here',
    });
    expect(issues.find((issue) => issue.code === 'blockquote_outside')?.line).toBe(5);
    expect(issues.some((issue) => issue.code === 'missing_links')).toBe(true);
  });
  test('keeps the text of a syntax issue at 120 characters or fewer', () => {
    const long = `- ${'x'.repeat(200)}`;
    const issues = parsedLlmsIssues(parseLlmsTxt(`# Site\n\n## Docs\n${long}\n`));
    const syntax = issues.find((issue) => issue.code === 'invalid_list_link');

    expect(syntax?.text?.length).toBeLessThanOrEqual(120);
  });
});

describe('og:image and hero image', () => {
  test('warns when og:image is a logo and the page has a hero image', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/img/logo-share.png"/>
    </head><body><main><img src="/hero.jpg" alt="Hero" loading="lazy"/></main></body></html>`;
    const finding = findingById(pageMetaFindings(bundleFromHtml(html)), 'meta:og-image-hero');

    expect(finding?.severity).toBe('warn');
    expect(finding?.detail).toContain('https://example.com/img/logo-share.png');
    expect(finding?.detail).toContain('/hero.jpg');
  });
  test.each(['photo.jpg', 'iconic-bridge.jpg', 'catalogo/sapato.jpg'])(
    'no og-image hero finding for the photo og:image %s',
    (path) => {
      const html = `<html><head>
      <meta property="og:image" content="https://example.com/img/${path}"/>
    </head><body><main><img src="/hero.jpg" alt="Hero"/></main></body></html>`;

      expect(
        findingById(pageMetaFindings(bundleFromHtml(html)), 'meta:og-image-hero'),
      ).toBeUndefined();
    },
  );
  test.each(['icons/share.png', 'favicon.png', 'brand_logo.svg'])(
    'warns for the icon or logo og:image %s',
    (path) => {
      const html = `<html><head>
      <meta property="og:image" content="https://example.com/${path}"/>
    </head><body><main><img src="/hero.jpg" alt="Hero"/></main></body></html>`;

      expect(
        findingById(pageMetaFindings(bundleFromHtml(html)), 'meta:og-image-hero')?.severity,
      ).toBe('warn');
    },
  );
  test('warns on a lazy hero image and passes an eager high-priority one', () => {
    const lazy = bundleFromHtml(
      `<html><body><main><img src="/hero.jpg" alt="Hero" loading="lazy"/></main></body></html>`,
    );
    const eager = bundleFromHtml(
      `<html><body><main><img src="/hero.jpg" alt="Hero" fetchpriority="high"/></main></body></html>`,
    );

    expect(lazy.auditedPage.images.items[0]?.fetchPriority).toBeNull();
    expect(findingById(pageContentFindings(lazy), 'content:hero-image')?.severity).toBe('warn');
    expect(eager.auditedPage.images.items[0]?.fetchPriority).toBe('high');
    expect(findingById(pageContentFindings(eager), 'content:hero-image')?.severity).toBe('pass');
  });
});

describe('lighthouse details', () => {
  const lhr = {
    requestedUrl: PAGE,
    finalUrl: PAGE,
    categories: {
      performance: {
        auditRefs: [
          { id: 'largest-contentful-paint-element' },
          { id: 'unused-javascript' },
          { id: 'speed-index' },
        ],
      },
      seo: { auditRefs: [{ id: 'meta-description' }] },
      'best-practices': { auditRefs: [{ id: 'errors-in-console' }] },
    },
    audits: {
      'largest-contentful-paint-element': {
        score: null,
        title: 'LCP element',
        details: {
          type: 'list',
          items: [
            {
              items: [
                {
                  node: {
                    type: 'node',
                    selector: 'img.hero',
                    snippet: '<img class="hero">',
                    nodeLabel: 'Hero photo',
                  },
                },
              ],
            },
          ],
        },
      },
      'unused-javascript': {
        score: 0.3,
        title: 'Unused JS',
        displayValue: '120 KiB',
        details: {
          type: 'opportunity',
          items: Array.from({ length: 12 }, (_, i) => ({
            url: `https://cdn.test/${i}.js`,
            wastedBytes: 1000 + i,
            totalBytes: 5000,
          })),
        },
      },
      'speed-index': { score: 1, title: 'Speed index', details: { items: [{ url: '/x' }] } },
      'meta-description': { score: 0, title: 'Meta description' },
      'errors-in-console': {
        score: 0,
        title: 'Console errors',
        details: { items: [{ sourceLocation: { url: 'https://example.com/app.js' } }] },
      },
    },
  };
  const spawn: LighthouseSpawn = () => ({
    done: Promise.resolve<LighthouseSpawnOutcome>({
      stdout: JSON.stringify(lhr),
      stderr: '',
      code: 0,
      signal: null,
    }),
    kill() {
      return undefined;
    },
  });
  test('keeps LCP element nodes and capped url rows, and reads seo and best-practices failures', async () => {
    const report = await startLighthouse(PAGE, PIN, spawn).promise;
    const byId = (id: string) => report.failedAudits.find((audit) => audit.id === id);

    expect(report.status).toBe('ok');
    expect(report.failedAudits.map((audit) => audit.id)).toEqual([
      'largest-contentful-paint-element',
      'unused-javascript',
      'meta-description',
      'errors-in-console',
    ]);
    expect(byId('largest-contentful-paint-element')).toMatchObject({
      category: 'performance',
      score: null,
      items: [
        {
          url: null,
          node: { selector: 'img.hero', snippet: '<img class="hero">', nodeLabel: 'Hero photo' },
        },
      ],
    });
    const unused = byId('unused-javascript');

    expect(unused?.category).toBe('performance');
    expect(unused?.items).toHaveLength(10);
    expect(unused?.items[0]).toEqual({
      url: 'https://cdn.test/0.js',
      node: null,
      wastedMs: null,
      wastedBytes: 1000,
      totalBytes: 5000,
      totalMs: null,
    });
    expect(byId('meta-description')).toMatchObject({ category: 'seo', items: [] });
    expect(byId('errors-in-console')?.category).toBe('best-practices');
    expect(byId('speed-index')).toBeUndefined();
  });
});
