import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { parseRobotsTxt } from '../src/engine/robotsTxtParser.ts';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import { deriveRedirectSignals } from '../src/engine/redirectSignals.ts';
import { mergeRobotsDirectives, noindexSource } from '../src/engine/robotsDirective.ts';
import { classifyPage } from '../src/engine/pageClassification.ts';
import {
  auditedBodySha256,
  platformSignalsFor,
  type DiscoveryBundle,
} from '../src/engine/discovery.ts';
import { parseRobots } from '../src/tools/robots/parseRobots.ts';
import { scoreCitabilityTexts } from '../src/engine/scoring.ts';
import { unrenderedPage } from '../src/engine/render.ts';
import type { CruxFetchResult, LlmsTxtResult } from '../src/engine/types.ts';

export function llmsTxtFixture(over: Partial<LlmsTxtResult> = {}): LlmsTxtResult {
  return {
    url: 'https://example.com/llms.txt',
    exists: false,
    fetchStatus: 'missing',
    fetchError: null,
    format_valid: false,
    has_title: false,
    has_sections: false,
    has_links: false,
    section_count: 0,
    link_count: 0,
    links: [],
    linksTruncated: false,
    linksToAuditedUrl: false,
    issues: [],
    content: null,
    full_content: null,
    contentType: '',
    full_version: { url: 'https://example.com/llms-full.txt', exists: false, contentType: '' },
    ...over,
  };
}

/** CrUX field data with good Core Web Vitals, so technical foundations is measured. */
export function cruxGoodFixture(url: string): CruxFetchResult {
  const rating = { rating: 'good' };

  return {
    status: 'completed',
    errors: [],
    results: [
      {
        url,
        origin: new URL(url).origin,
        status: 'ok',
        url_data: {
          cwv_pass: true,
          metrics: {
            largest_contentful_paint: rating,
            interaction_to_next_paint: rating,
            cumulative_layout_shift: rating,
          },
        },
        origin_data: null,
        errors: [],
      },
    ],
  };
}

export const PAGE_HTML = `<!doctype html>

<html lang="en">

<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width"/>
  <title>Example Company widgets for operations teams worldwide</title>
  <meta name="description" content="Example Company builds widgets for teams worldwide."/>
  <link rel="canonical" href="https://example.com/"/>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Example Company",
    "url": "https://example.com",
    "sameAs": ["https://www.linkedin.com/company/example"]
  }

  </script>
</head>
<body>

  <h1>Example Company</h1>

  <h2>What we do</h2>

  <p>${'Reliable widgets for operations teams. '.repeat(40)}</p>

  <h2>How it works</h2>

  <ul><li>Plan</li><li>Ship</li><li>Measure</li></ul>

  <img src="/logo.png" alt="Example logo"/>
</body>
</html>`;

export function bundleFromHtml(html: string): DiscoveryBundle {
  const url = 'https://example.com/';
  const parsed = parseHtmlPage(html, url);
  const { siteType, pageKind } = classifyPage(parsed, url);
  const headers = {
    'content-type': 'text/html',
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
  };
  const securityHeaders = {
    hsts: true,
    csp: false,
    x_frame: false,
    x_content_type: true,
    referrer_policy: false,
    x_robots_tag: null,
  };
  const crawlerAccess = parseRobotsTxt(
    'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n',
  );
  const llmsTxt = llmsTxtFixture();

  return {
    domain: 'example.com',
    auditedUrl: url,
    auditScope: {
      level: 'page' as const,
      pagesScored: 1 as const,
      contextFetches: {
        robots: true,
        sitemapFiles: 1,
        llmsTxt: true,
        crux: false,
        mobilePage: true,
        linksProbed: 0,
      },
    },
    fetchedAt: '2026-10-01T00:00:00.000Z',
    pageKind,
    siteType,
    technicalUrls: [url],
    crux: { status: 'skipped', results: [], errors: ['CRUX_API_KEY not configured'] },
    llmsTxt,
    llms_txt_status: deriveLlmsTxtStatus(llmsTxt),
    securityHeaders,
    crawlerAccess,
    sitemap: {
      present: true,
      fetchStatus: 'present' as const,
      url_count: 1,
      audited_url_listed: true,
      audited_url_lastmod: null,
      urls: [{ loc: url, lastmod: null }],
      urlsTruncated: false,
      coverage: 'complete' as const,
      filesRead: 1,
    },
    redirects: deriveRedirectSignals(url, url, [url]),

    platform_signals: platformSignalsFor(parsed),
    auditedPage: {
      url,
      statusCode: 200,
      byteLength: html.length,
      bodySha256: auditedBodySha256(html),
      redirectCount: 0,
      title: parsed.title,
      metaDescription: parsed.metaDescription,
      canonicalUrl: parsed.canonicalUrl,
      robotsDirective: parsed.robotsDirective,
      effectiveRobotsDirective: mergeRobotsDirectives(parsed.robotsDirective, null),
      lang: parsed.lang,
      robotsStatus: 'present',
      robotsFetchError: null,
      sitemapStatus: 'present',
      internalLinks: parsed.internalLinks,
      internalLinkCount: parsed.internalLinkCount,
      internalLinksTruncated: parsed.internalLinksTruncated,
      outboundLinks: parsed.outboundLinks,
      outboundLinksTruncated: parsed.outboundLinksTruncated,
      snippetDirectives: parsed.snippetDirectives,
      internalLinkIndex: parsed.internalLinkIndex,
      internalLinkIndexTruncated: parsed.internalLinkIndexTruncated,
      wordCount: parsed.wordCount,
      bodyWordCount: parsed.bodyWordCount,
      mainText: parsed.mainText,
      mainTextTruncated: false,
      tables: parsed.tables,
      mixedContent: parsed.mixedContent,
      sameHostResources: parsed.sameHostResources,
      hiddenText: parsed.hiddenText,
      charset: parsed.charset,
      trustPages: parsed.trustPages,
      externalResources: parsed.externalResources,
      structuredData: parsed.structuredData,
      headings: parsed.headings,
      viewport: parsed.viewport,
      hreflang: parsed.hreflang,
      hreflangLinks: parsed.hreflangLinks,
      headerCanonical: null,
      headerHreflang: [],
      robotsNoindexSource: noindexSource(parsed.robotsDirective, null, parsed.metaRobotsByBot),
      pagination: parsed.pagination,
      breadcrumbParent: parsed.breadcrumbParent,
      visibleTextSha256: parsed.visibleTextSha256,
      visibleTextExcerpt: parsed.visibleTextExcerpt,
      dates: parsed.dates,
      author: parsed.author,
      social: parsed.social,
      contentSignals: parsed.contentSignals,
      markupFormats: parsed.markupFormats,
      metaRobotsByBot: parsed.metaRobotsByBot,
      jsRenderingRisk: parsed.jsRenderingRisk,
      images: parsed.images,
      videos: parsed.videos,
      discover: parsed.discover,
      citability: {
        ...scoreCitabilityTexts(parsed.citabilityTexts),
        opening: parsed.citabilityOpening,
      },
      hasSpeakable: parsed.hasSpeakable,
      pageKind,
      siteType,
    },
    mobilePage: null,
    mobileFetchError: null,
    linkStatus: { status: 'skipped' as const, checked: 0, candidates: 0, results: [] },
    httpsReadiness: null,
    renderedPage: unrenderedPage('not-requested'),
    pagesSampled: 1,

    pageHeaders: headers,

    requestedUrl: url,

    parsedRobots: parseRobots(
      'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n',
    ),
    parsedLlms: null,
    parsedLlmsFull: null,
    schemaBlocks: parsed.schemaBlocks,
    metaTags: parsed.metaTags,
  };
}
