import { createHash } from 'node:crypto';
import { parseRobots, type ParsedRobots } from '../tools/robots/parseRobots.ts';
import { parseLlmsTxt, type ParsedLlmsTxt } from '../tools/llmstxt/parseLlmsTxt.ts';
import { parseHtmlPage, type ParsedPage } from './htmlParser.ts';
import { MAIN_TEXT_CAP } from './parsers/mainContent.ts';
import { unrenderedPage } from './render.ts';
import { classifyPage } from './pageClassification.ts';
import {
  crawlerAccessFromParsed,
  parseRobotsTxt,
  unknownCrawlerAccess,
  type RobotsTxtParseResult,
} from './robotsTxtParser.ts';
import { mergeRobotsDirectives, noindexSource } from './robotsDirective.ts';
import { deriveRedirectSignals } from './redirectSignals.ts';
import { deriveLlmsTxtStatus } from './llmsTxtStatus.ts';
import {
  DISCOVERY_PAGE_TIMEOUT_MS,
  classifyWellKnownFetch,
  fetchErrorCode,
  fetchPublicUrl,
  formatFetchError,
  type FetchedPage,
  type FetchOutcome,
} from '../lib/fetch.ts';

import { CliError } from '../lib/errors.ts';
import { parseLinkHeader } from '../lib/url.ts';
import { fetchCruxResults } from './crux.ts';
import { cappedLlmsLinks, fetchLlmsTxt } from './llms.ts';
import { parseSitemapForUrl, sitemapUrlsFromDeclared } from './sitemap.ts';
import { parseSecurityHeaders } from '../tools/security/parseSecurityHeaders.ts';
import { scoreCitabilityTexts } from './scoring.ts';
import { httpsReadinessOfPage } from './httpsReadiness.ts';
import { checkPageLinks, skippedLinkStatus } from './linkStatus.ts';
import type {
  AuditedPageSnapshot,
  DiscoveryResult,
  LlmsTxtResult,
  MobilePageSnapshot,
  PlatformSignals,
  SecurityHeadersSummary,
  SitemapParseResult,
} from './types.ts';

/** Mobile Chrome user-agent for the second GET of the audited URL. */
export const MOBILE_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Mobile Safari/537.36';

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

/** Platform facts from one parsed page. `visible_dates` counts any date the page shows or declares. */
export function platformSignalsFor(parsed: ParsedPage): PlatformSignals {
  return {
    question_heading_count: parsed.contentSignals.question_heading_count,
    faq_pattern: parsed.contentSignals.hasFaqPattern,
    table_count: parsed.contentSignals.tables,
    list_count: parsed.contentSignals.lists,
    statistic_snippet_count: parsed.contentSignals.statistic_snippet_count,
    visible_dates: Boolean(parsed.dates.published || parsed.dates.modified || parsed.dates.visible),
    has_author: parsed.author.hasAuthor,
  };
}

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

/** Hex SHA-256 of the audited HTML string, as UTF-8. Scoring does not read it. */
export function auditedBodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function utf8ByteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

interface AuditedPageInput {
  fetched: FetchedPage;
  parsed: ReturnType<typeof parseHtmlPage>;
  securityHeaders: SecurityHeadersSummary;
  robotsStatus: string;
  robotsFetchError: string | null;
  sitemapStatus: string;
  pageKind: AuditedPageSnapshot['pageKind'];
  siteType: AuditedPageSnapshot['siteType'];
  citabilityTextCap: number;
}

function buildAuditedPageSnapshot({
  fetched,
  parsed,
  securityHeaders,
  robotsStatus,
  robotsFetchError,
  sitemapStatus,
  pageKind,
  siteType,
  citabilityTextCap,
}: AuditedPageInput): AuditedPageSnapshot {
  const linkHeader = parseLinkHeader(fetched.headers.link ?? null, fetched.finalUrl);

  return {
    url: fetched.finalUrl,
    statusCode: fetched.status,
    byteLength: utf8ByteLength(fetched.body),
    bodySha256: auditedBodySha256(fetched.body),
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
    robotsFetchError,
    sitemapStatus,
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
    mainText: parsed.mainText.slice(0, MAIN_TEXT_CAP),
    mainTextTruncated: parsed.mainText.length > MAIN_TEXT_CAP,
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
    headerCanonical: linkHeader.canonical,
    headerHreflang: linkHeader.hreflang,
    robotsNoindexSource: noindexSource(
      parsed.robotsDirective,
      securityHeaders.x_robots_tag,
      parsed.metaRobotsByBot,
    ),
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
      ...scoreCitabilityTexts(parsed.citabilityTexts, citabilityTextCap),
      opening: parsed.citabilityOpening,
    },
    hasSpeakable: parsed.hasSpeakable,
    pageKind,
    siteType,
  };
}

function mobileSnapshot(fetched: FetchedPage): MobilePageSnapshot {
  const parsed = parseHtmlPage(fetched.body, fetched.finalUrl);
  const headers = readSecurityHeaders(fetched.headers);

  return {
    statusCode: fetched.status,
    byteLength: utf8ByteLength(fetched.body),
    wordCount: parsed.wordCount,
    h1: parsed.headings.h1,
    jsRenderingRisk: parsed.jsRenderingRisk,
    canonicalUrl: parsed.canonicalUrl,
    effectiveRobotsDirective: mergeRobotsDirectives(parsed.robotsDirective, headers.x_robots_tag),
    viewport: parsed.viewport,
    structuredDataTypes: parsed.structuredData.types,
    internalLinkCount: parsed.internalLinkCount,
    visibleTextSha256: parsed.visibleTextSha256,
    visibleTextExcerpt: parsed.visibleTextExcerpt,
  };
}

interface MobileLoad {
  page: MobilePageSnapshot | null;
  error: string | null;
}

async function loadMobilePage(url: string): Promise<MobileLoad> {
  try {
    const fetched = await fetchPublicUrl(url, {
      allowHttpErrors: true,
      timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
      userAgent: MOBILE_CHROME_USER_AGENT,
    });
    if (!fetched.ok) {
      return { page: null, error: fetched.error };
    }

    return { page: mobileSnapshot(fetched), error: null };
  } catch {
    return { page: null, error: 'network' };
  }
}

/** Report view of llms.txt: capped links. `parsed` is null exactly when the body is absent. */
function llmsWithReportLinks(
  llmsTxt: LlmsTxtResult,
  parsed: ParsedLlmsTxt | null,
  pageUrl: string,
): LlmsTxtResult {
  if (parsed === null) {
    return { ...llmsTxt, links: [], linksTruncated: false, linksToAuditedUrl: false };
  }

  return { ...llmsTxt, ...cappedLlmsLinks(parsed.links, pageUrl) };
}

/** Robots access for the audited path. An unreadable robots.txt gives no rows, not allow-all. */
function robotsAccessFor(
  robots: FetchOutcome,
  robotsStatus: 'present' | 'missing' | 'error',
  pageUrl: string,
): { crawlerAccess: RobotsTxtParseResult; parsedRobots: ParsedRobots | null } {
  if (robotsStatus === 'present' && robots.ok) {
    const parsedRobots = parseRobots(robots.body);
    const path = new URL(pageUrl).pathname || '/';

    return { crawlerAccess: crawlerAccessFromParsed(parsedRobots, path), parsedRobots };
  }

  if (robotsStatus === 'error') {
    return { crawlerAccess: unknownCrawlerAccess(), parsedRobots: null };
  }

  return { crawlerAccess: parseRobotsTxt(null), parsedRobots: null };
}

function sitemapStatusOf(sitemap: SitemapParseResult): string {
  if (sitemap.present) {
    return 'present';
  }

  return sitemap.fetchStatus === 'error' ? 'error' : 'missing';
}

/**
 * Runs local deterministic discovery. `checkLinks` adds the status probe of
 * on-page links (`audit` only, so context `seo-check` runs stay light).
 */
export async function runLocalDiscovery(
  requestedUrl: string,
  progress: ProgressFn = () => undefined,
  citabilityTextCap = 1500,
  headingCap = 40,
  checkLinks = false,
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
  const mobilePromise = loadMobilePage(fetched.finalUrl);

  progress('Checking robots.txt, llms.txt, CrUX');
  const robotsPromise = fetchPublicUrl(robotsUrl, { allowHttpErrors: true });
  const cruxPromise = fetchCruxResults([fetched.finalUrl]);
  const llmsPromise = fetchLlmsTxt(fetched.finalUrl);

  const parsed = parseHtmlPage(fetched.body, fetched.finalUrl, headingCap);
  const linkPromise = checkLinks
    ? checkPageLinks(fetched.finalUrl, parsed.internalLinks)
    : Promise.resolve(skippedLinkStatus());
  const securityHeaders = readSecurityHeaders(fetched.headers);
  const { siteType, pageKind } = classifyPage(parsed, fetched.finalUrl);
  const redirects = deriveRedirectSignals(requestedUrl, fetched.finalUrl, fetched.redirectChain);
  const domain = new URL(fetched.finalUrl).hostname.replace(/^www\./i, '');

  const robots = await robotsPromise;
  const robotsStatus = classifyWellKnownFetch(robots, '/robots.txt');
  const { crawlerAccess, parsedRobots } = robotsAccessFor(robots, robotsStatus, fetched.finalUrl);

  progress('Checking sitemap');
  const sitemapUrls = sitemapUrlsFromDeclared(
    [...crawlerAccess.sitemaps, ...parsed.sitemapUrls],
    fetched.finalUrl,
  );
  const [sitemapParsed, crux, llmsTxt, mobile, linkStatus] = await Promise.all([
    parseSitemapForUrl(sitemapUrls, fetched.finalUrl),
    cruxPromise,
    llmsPromise,
    mobilePromise,
    linkPromise,
  ]);

  const auditedPage = buildAuditedPageSnapshot({
    fetched,
    parsed,
    securityHeaders,
    robotsStatus,
    robotsFetchError: robotsStatus === 'error' ? fetchErrorCode(robots) : null,
    sitemapStatus: sitemapStatusOf(sitemapParsed),
    pageKind,
    siteType,
    citabilityTextCap,
  });
  const parsedLlms = llmsTxt.content === null ? null : parseLlmsTxt(llmsTxt.content);
  const parsedLlmsFull = llmsTxt.full_content === null ? null : parseLlmsTxt(llmsTxt.full_content);
  const platform_signals = platformSignalsFor(parsed);

  return {
    domain,
    auditedUrl: fetched.finalUrl,
    auditScope: {
      level: 'page',
      pagesScored: 1,
      contextFetches: {
        robots: true,
        sitemapFiles: sitemapParsed.filesRead,
        llmsTxt: true,
        crux: crux.status === 'completed',
        mobilePage: true,
        linksProbed: linkStatus.checked,
      },
    },
    fetchedAt: fetched.fetchedAt,
    pageKind,
    siteType,
    technicalUrls: [fetched.finalUrl],
    crux,
    llmsTxt: llmsWithReportLinks(llmsTxt, parsedLlms, fetched.finalUrl),
    llms_txt_status: deriveLlmsTxtStatus(llmsTxt),
    securityHeaders,
    crawlerAccess,
    sitemap: sitemapParsed,
    redirects,
    platform_signals,
    auditedPage,
    mobilePage: mobile.page,
    mobileFetchError: mobile.error,
    linkStatus,
    httpsReadiness: httpsReadinessOfPage(fetched.finalUrl, parsed),
    renderedPage: unrenderedPage('not-requested'),
    pagesSampled: 1,
    pageHeaders: fetched.headers,
    requestedUrl,
    parsedRobots,
    parsedLlms,
    parsedLlmsFull,
    schemaBlocks: parsed.schemaBlocks,
    metaTags: parsed.metaTags,
  };
}
