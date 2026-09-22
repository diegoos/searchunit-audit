import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { parseRobotsTxt } from '../src/engine/robotsTxtParser.ts';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import { deriveRedirectSignals } from '../src/engine/redirectSignals.ts';
import { mergeRobotsDirectives } from '../src/engine/robotsDirective.ts';
import { classifyPage } from '../src/engine/pageClassification.ts';
import { parseRobots } from '../src/tools/robots/parseRobots.ts';
import {
  computeAuditScores,
  scoreCitabilityTexts,
  type CriticalBlocker,
} from '../src/engine/scoring.ts';
import type { DiscoveryBundle } from '../src/engine/discovery.ts';

export function collectCriticalBlockers(bundle: DiscoveryBundle): CriticalBlocker[] {
  const blockers: CriticalBlocker[] = [];

  computeAuditScores(bundle, blockers);

  return blockers;
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
  const { siteType, pageKind } = classifyPage(parsed);
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
  const llmsTxt = {
    url: 'https://example.com/llms.txt',
    exists: false,
    fetchStatus: 'missing' as const,
    format_valid: false,
    has_title: false,
    has_sections: false,
    has_links: false,
    section_count: 0,
    link_count: 0,
    issues: [],
    content: null,
    full_content: null,
    contentType: '',
    full_version: { url: 'https://example.com/llms-full.txt', exists: false, contentType: '' },
  };

  return {
    domain: 'example.com',
    auditedUrl: url,
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
    },
    redirects: deriveRedirectSignals(url, url, [url]),

    platform_signals: {
      question_heading_count: parsed.contentSignals.question_heading_count,
      faq_pattern: parsed.contentSignals.hasFaqPattern,
      table_count: parsed.contentSignals.tables,
      list_count: parsed.contentSignals.lists,
      statistic_snippet_count: parsed.contentSignals.statistic_snippet_count,
      visible_dates: Boolean(parsed.dates.published || parsed.dates.modified),
      has_author: parsed.author.hasAuthor,
    },
    auditedPage: {
      url,
      statusCode: 200,
      byteLength: html.length,
      redirectCount: 0,
      title: parsed.title,
      metaDescription: parsed.metaDescription,
      canonicalUrl: parsed.canonicalUrl,
      robotsDirective: parsed.robotsDirective,
      effectiveRobotsDirective: mergeRobotsDirectives(parsed.robotsDirective, null),
      lang: parsed.lang,
      robotsStatus: 'present',
      sitemapStatus: 'present',
      internalLinks: parsed.internalLinks,
      wordCount: parsed.wordCount,
      structuredData: parsed.structuredData,
      headings: parsed.headings,
      viewport: parsed.viewport,
      hreflang: parsed.hreflang,
      dates: parsed.dates,
      author: parsed.author,
      social: parsed.social,
      contentSignals: parsed.contentSignals,
      markupFormats: parsed.markupFormats,
      metaRobotsByBot: parsed.metaRobotsByBot,
      jsRenderingRisk: parsed.jsRenderingRisk,
      images: parsed.images,
      discover: parsed.discover,
      citability: scoreCitabilityTexts(parsed.citabilityTexts),
      hasSpeakable: parsed.hasSpeakable,
      pageKind,
      siteType,
    },
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
