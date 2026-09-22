import { parseRobots, type ParsedRobots } from '../tools/robots/parseRobots.ts';
import { parseLlmsTxt, type ParsedLlmsTxt } from '../tools/llmstxt/parseLlmsTxt.ts';
import { parseHtmlPage } from './htmlParser.ts';
import { classifyPage } from './pageClassification.ts';
import {
  crawlerAccessFromParsed,
  parseRobotsTxt,
  unknownCrawlerAccess,
  type RobotsTxtParseResult,
} from './robotsTxtParser.ts';
import { mergeRobotsDirectives } from './robotsDirective.ts';
import { deriveRedirectSignals } from './redirectSignals.ts';
import { deriveLlmsTxtStatus } from './llmsTxtStatus.ts';
import {
  DISCOVERY_PAGE_TIMEOUT_MS,
  classifyWellKnownFetch,
  fetchPublicUrl,
  formatFetchError,
  type FetchedPage,
} from '../lib/fetch.ts';

import { CliError } from '../lib/errors.ts';
import { fetchCruxResults } from './crux.ts';
import { fetchLlmsTxt } from './llms.ts';
import { parseSitemapForUrl, sitemapUrlFromRobots } from './sitemap.ts';
import { parseSecurityHeaders } from '../tools/security/parseSecurityHeaders.ts';
import { scoreCitabilityTexts } from './scoring.ts';
import type {
  AuditedPageSnapshot,
  DiscoveryResult,
  PlatformSignals,
  SecurityHeadersSummary,
} from './types.ts';

export type ProgressFn = (message: string) => void;

export type DiscoveryBundle = DiscoveryResult & {
  pageHeaders: Record<string, string>;
  requestedUrl: string;
  parsedRobots: ParsedRobots | null;
  parsedLlms: ParsedLlmsTxt | null;
  parsedLlmsFull: ParsedLlmsTxt | null;
  schemaBlocks: ReturnType<typeof parseHtmlPage>['schemaBlocks'];
  metaTags: ReturnType<typeof parseHtmlPage>['metaTags'];
};

function readSecurityHeaders(headers: Record<string, string>): SecurityHeadersSummary {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = parseSecurityHeaders(lower);

  return {
    hsts: Boolean(raw.hsts),
    csp: Boolean(raw.csp),
    x_frame: Boolean(raw.xFrame),
    x_content_type: Boolean(raw.xContentType),
    referrer_policy: Boolean(raw.referrerPolicy),
    x_robots_tag: raw.xRobotsTag,
  };
}

function buildAuditedPageSnapshot(
  fetched: FetchedPage,
  parsed: ReturnType<typeof parseHtmlPage>,
  securityHeaders: SecurityHeadersSummary,
  robotsStatus: string,
  sitemapStatus: string,
  pageKind: AuditedPageSnapshot['pageKind'],
  siteType: AuditedPageSnapshot['siteType'],
): AuditedPageSnapshot {
  return {
    url: fetched.finalUrl,
    statusCode: fetched.status,
    byteLength: new TextEncoder().encode(fetched.body).length,
    redirectCount: Math.max(0, fetched.redirectChain.length - 1),
    title: parsed.title,
    metaDescription: parsed.metaDescription,
    canonicalUrl: parsed.canonicalUrl,
    robotsDirective: parsed.robotsDirective,
    effectiveRobotsDirective: mergeRobotsDirectives(
      parsed.robotsDirective,
      securityHeaders.x_robots_tag,
    ),
    lang: parsed.lang,
    robotsStatus,
    sitemapStatus,
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
  };
}

/**
 * Runs local deterministic discovery.
 */
export async function runLocalDiscovery(
  requestedUrl: string,
  progress: ProgressFn = () => undefined,
): Promise<DiscoveryBundle> {
  progress(`Fetching ${requestedUrl}`);
  const fetched = await fetchPublicUrl(requestedUrl, {
    allowHttpErrors: true,
    timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
  });
  if (!fetched.ok) {
    throw new CliError(formatFetchError(fetched));
  }

  const robotsUrl = new URL('/robots.txt', fetched.finalUrl).toString();

  progress('Checking robots.txt, llms.txt, CrUX');
  const robotsPromise = fetchPublicUrl(robotsUrl, { allowHttpErrors: true });
  const cruxPromise = fetchCruxResults([fetched.finalUrl]);
  const llmsPromise = fetchLlmsTxt(fetched.finalUrl);

  const parsed = parseHtmlPage(fetched.body, fetched.finalUrl);
  const securityHeaders = readSecurityHeaders(fetched.headers);
  const { siteType, pageKind } = classifyPage(parsed);
  const redirects = deriveRedirectSignals(requestedUrl, fetched.finalUrl, fetched.redirectChain);
  const domain = new URL(fetched.finalUrl).hostname.replace(/^www\./i, '');

  const robots = await robotsPromise;
  const robotsStatus = classifyWellKnownFetch(robots, '/robots.txt');
  let crawlerAccess: RobotsTxtParseResult = parseRobotsTxt(null);
  let parsedRobots: ParsedRobots | null = null;

  if (robotsStatus === 'present' && robots.ok) {
    parsedRobots = parseRobots(robots.body);
    const path = new URL(fetched.finalUrl).pathname || '/';

    crawlerAccess = crawlerAccessFromParsed(parsedRobots, path);
  } else if (robotsStatus === 'error') {
    crawlerAccess = unknownCrawlerAccess();
  }

  progress('Checking sitemap');
  const sitemapUrl = sitemapUrlFromRobots(
    [...crawlerAccess.sitemaps, ...parsed.sitemapUrls],
    fetched.finalUrl,
  );
  const [sitemapParsed, crux, llmsTxt] = await Promise.all([
    parseSitemapForUrl(sitemapUrl, fetched.finalUrl),
    cruxPromise,
    llmsPromise,
  ]);

  let sitemapStatus = 'missing';

  if (sitemapParsed.present) {
    sitemapStatus = 'present';
  } else if (sitemapParsed.fetchStatus === 'error') {
    sitemapStatus = 'error';
  }

  const auditedPage = buildAuditedPageSnapshot(
    fetched,
    parsed,
    securityHeaders,
    robotsStatus,
    sitemapStatus,
    pageKind,
    siteType,
  );

  const platform_signals: PlatformSignals = {
    question_heading_count: parsed.contentSignals.question_heading_count,
    faq_pattern: parsed.contentSignals.hasFaqPattern,
    table_count: parsed.contentSignals.tables,
    list_count: parsed.contentSignals.lists,
    statistic_snippet_count: parsed.contentSignals.statistic_snippet_count,
    visible_dates: Boolean(parsed.dates.published || parsed.dates.modified),
    has_author: parsed.author.hasAuthor,
  };

  return {
    domain,
    auditedUrl: fetched.finalUrl,
    pageKind,
    siteType,
    technicalUrls: [fetched.finalUrl],
    crux,
    llmsTxt,
    llms_txt_status: deriveLlmsTxtStatus(llmsTxt),
    securityHeaders,
    crawlerAccess,
    sitemap: sitemapParsed,
    redirects,
    platform_signals,
    auditedPage,
    pagesSampled: 1,
    pageHeaders: fetched.headers,
    requestedUrl,
    parsedRobots,
    parsedLlms: llmsTxt.content === null ? null : parseLlmsTxt(llmsTxt.content),
    parsedLlmsFull: llmsTxt.full_content === null ? null : parseLlmsTxt(llmsTxt.full_content),
    schemaBlocks: parsed.schemaBlocks,
    metaTags: parsed.metaTags,
  };
}
