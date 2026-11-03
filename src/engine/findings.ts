import { analyzeSchema } from '../tools/schema/analyzeSchema.ts';
import { analyzeMeta } from '../tools/meta/analyzeMeta.ts';
import {
  analyzeAbsentRobots,
  analyzeRobots,
  analyzeRobotsFetchError,
} from '../tools/robots/analyzeRobots.ts';
import {
  analyzeAbsentLlmsTxt,
  analyzeLlmsTxtFetchError,
  analyzeLlmsTxtPair,
} from '../tools/llmstxt/analyzeLlmsTxt.ts';
import { parseLlmsTxt } from '../tools/llmstxt/parseLlmsTxt.ts';
import { analyzeSecurityHeaders } from '../tools/security/analyzeSecurityHeaders.ts';
import { buildAnalyzeContext } from '../tools/security/buildAnalyzeContext.ts';
import { parseSecurityHeaders } from '../tools/security/parseSecurityHeaders.ts';
import { AI_CRAWLERS } from '../tools/robots/aiCrawlers.ts';
import type { DiscoveryBundle } from './discovery.ts';
import { CITABILITY_IDEAL_MAX_WORDS, CITABILITY_IDEAL_MIN_WORDS } from './citabilityBlocks.ts';
import { LIVE_RETRIEVAL_BOTS, type CriticalBlocker } from './scoring.ts';
import { isLocalTarget } from './localTarget.ts';
import { promptInjectionFinding } from './promptInjection.ts';
import { renderFinding } from './renderFindings.ts';
import type { ExternalResources } from './parsers/externalResources.ts';
import type { Finding, FindingSeverity, ReportKind } from './types.ts';
import {
  blockedResourcesFinding,
  makeFinding,
  mobileParityFinding,
  pageContentFindings,
  pageLinkFindings,
  pageMetaFindings,
  searchCrawlerFinding,
} from './pageFindings.ts';

const BLOCKER_TITLE: Record<CriticalBlocker['id'], string> = {
  noindex_or_error: 'Page is noindex or returned an error status',

  no_https: 'Page is not served over HTTPS',

  poor_core_web_vitals: 'Core Web Vitals are poor',

  csr_only_rendering: 'Page looks client-side rendered only',

  oversized_html: "HTML exceeds Googlebot's 2 MiB indexing limit",

  thin_content: 'Thin content (low word count)',

  no_structured_data: 'No JSON-LD structured data',

  live_retrieval_blocked: 'Live-retrieval crawlers are blocked',
};

function fromCheck(
  source: string,
  check: { id: string; label: string; status: FindingSeverity; detail: string },
): Finding {
  return makeFinding(source, check.id, check.status, check.label, check.detail);
}

/** Status plus the error code of a failed fetch, when there is one. */
function withFetchError(status: string, error: string | null): string {
  return error ? `${status} (${error} after retries)` : status;
}

function discoveryFinding(
  id: string,
  severity: FindingSeverity,
  title: string,
  detail: string,
): Finding {
  return makeFinding('discovery', id, severity, title, detail);
}

/**
 * Loopback targets get the readiness check for the HTTPS production URL. Other
 * URLs keep the plain note: their HTTPS state is already in the blockers.
 */
function httpsFinding(bundle: DiscoveryBundle): Finding {
  const readiness = bundle.httpsReadiness;

  if (readiness === null) {
    return discoveryFinding('https', 'info', 'HTTPS', 'checked on the audited URL');
  }

  const { activeCount, passiveCount } = bundle.auditedPage.mixedContent;
  const parts = [
    readiness.insecureSubresources.length > 0
      ? `http subresources (${activeCount} active, ${passiveCount} passive): ${readiness.insecureSubresources.join(', ')}`
      : null,
    readiness.insecureUrls.length > 0
      ? `http URLs on other hosts: ${fieldUrls(readiness.insecureUrls)}`
      : null,
    readiness.devHostUrls.length > 0
      ? `dev-host URLs (check the SITE_URL build config): ${fieldUrls(readiness.devHostUrls)}`
      : null,
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) {
    return discoveryFinding('https', 'pass', 'HTTPS', 'loopback URL: no HTTPS readiness issue');
  }

  return discoveryFinding(
    'https',
    httpsReadinessSeverity(bundle, readiness),
    'HTTPS',
    `loopback URL: ${parts.join('; ')}`,
  );
}

function fieldUrls(items: readonly { field: string; url: string }[]): string {
  return items.map((item) => `${item.field} ${item.url}`).join(', ');
}

/** `warn` for an active subresource or an http URL on another host; `info` for the rest. */
function httpsReadinessSeverity(
  bundle: DiscoveryBundle,
  readiness: NonNullable<DiscoveryBundle['httpsReadiness']>,
): FindingSeverity {
  const { activeCount } = bundle.auditedPage.mixedContent;

  if (activeCount > 0 || readiness.insecureUrls.length > 0) {
    return 'warn';
  }

  return 'info';
}

function robotsAnalysisForBundle(bundle: DiscoveryBundle) {
  if (bundle.parsedRobots !== null) {
    return analyzeRobots(bundle.parsedRobots, new URL(bundle.auditedUrl).pathname || '/');
  }

  if (bundle.auditedPage.robotsStatus === 'error') {
    return analyzeRobotsFetchError();
  }

  return analyzeAbsentRobots();
}

const EMPTY_LLMS = {
  h1: null,
  summary: null,
  details: [],
  sections: [],
  links: [],
  syntaxErrors: [],
  hasBom: false,
};

function llmsAnalysisForBundle(bundle: DiscoveryBundle) {
  const full = bundle.llmsTxt.full_version;

  if (bundle.llmsTxt.exists) {
    return analyzeLlmsTxtPair(
      bundle.parsedLlms ?? parseLlmsTxt(bundle.llmsTxt.content ?? ''),
      {
        present: true,
        contentType: bundle.llmsTxt.contentType,
        rawContent: bundle.llmsTxt.content ?? '',
        hasLlmsFull: full.exists,
      },
      bundle.parsedLlmsFull,
      full.exists,
      full.exists
        ? {
            contentType: full.contentType,
            rawContent: bundle.llmsTxt.full_content ?? '',
          }
        : undefined,
    );
  }

  if (bundle.llmsTxt.fetchStatus === 'error') {
    return analyzeLlmsTxtFetchError();
  }

  if (full.exists && bundle.parsedLlmsFull) {
    return analyzeLlmsTxtPair(
      EMPTY_LLMS,
      { present: false, rawContent: '', hasLlmsFull: true },
      bundle.parsedLlmsFull,
      true,
      {
        contentType: full.contentType,
        rawContent: bundle.llmsTxt.full_content ?? '',
      },
    );
  }

  return analyzeAbsentLlmsTxt();
}

/** Third-party origins and inline block counts. Feeds the CSP writing task. */
function externalOriginSummary(resources: ExternalResources): string {
  const kinds: [string, string[]][] = [
    ['scripts', resources.scripts],
    ['stylesheets', resources.stylesheets],
    ['frames', resources.frames],
    ['images', resources.images],
    ['fonts', resources.fonts],
    ['media', resources.media],
    ['forms', resources.forms],
  ];
  const external = kinds
    .filter(([, origins]) => origins.length > 0)
    .map(([label, origins]) => `${label} ${origins.join(' ')}`);
  const origins = external.length > 0 ? external.join('; ') : 'none';

  return `external origins: ${origins}; inline scripts ${resources.inlineScripts}; inline styles ${resources.inlineStyles}`;
}

/** Browsers ignore HSTS received over http:, so a loopback URL cannot be judged on it. */
const HSTS_CHECK_ID = 'strict-transport-security';

function securityFindings(bundle: DiscoveryBundle): Finding[] {
  const headers = parseSecurityHeaders(bundle.pageHeaders);
  const ctx = buildAnalyzeContext({
    finalUrl: bundle.auditedUrl,
    status: bundle.auditedPage.statusCode,
  });
  const originSummary = externalOriginSummary(bundle.auditedPage.externalResources);
  const loopback = isLocalTarget(bundle.auditedUrl);

  return analyzeSecurityHeaders(headers, ctx).checks.map((check) => {
    if (loopback && check.id === HSTS_CHECK_ID) {
      return {
        id: `security:${check.id}`,
        source: 'security-headers',
        severity: 'info',
        title: check.label,
        detail: 'not judged on a loopback URL',
      };
    }

    const detail = check.value?.trim() || check.detail?.trim() || 'missing';
    const withOrigins =
      check.id === 'content-security-policy' && !headers.csp
        ? `${detail}; ${originSummary}`
        : detail;

    return {
      id: `security:${check.id}`,
      source: 'security-headers',
      severity: check.status,
      title: check.label,
      detail: withOrigins,
    };
  });
}

/**
 * Sitemap presence and whether the audited page is listed. A partial walk
 * cannot prove the page is unlisted, so that case is `info`, not `warn`.
 */
function sitemapFinding(sitemap: DiscoveryBundle['sitemap']): Finding {
  if (!sitemap.present) {
    return discoveryFinding('sitemap', 'warn', 'Sitemap', sitemap.fetchStatus);
  }

  const detail = `${sitemap.url_count} URLs in ${sitemap.filesRead} file(s), coverage=${sitemap.coverage}, audited listed=${sitemap.audited_url_listed}`;

  if (sitemap.audited_url_listed) {
    return discoveryFinding('sitemap', 'pass', 'Sitemap', detail);
  }

  return discoveryFinding(
    'sitemap',
    sitemap.coverage === 'complete' ? 'warn' : 'info',
    'Sitemap',
    detail,
  );
}

function llmsSeverityOf(llmsTxt: DiscoveryBundle['llmsTxt']): FindingSeverity {
  if (llmsTxt.exists) {
    return 'pass';
  }

  return llmsTxt.fetchStatus === 'error' ? 'warn' : 'info';
}

function blockerFindings(blockers: readonly CriticalBlocker[]): Finding[] {
  return blockers.map((blocker): Finding => ({
    id: `blocker:${blocker.id}`,
    source: 'critical-blocker',
    severity: 'fail',
    title: BLOCKER_TITLE[blocker.id],
    detail: `Caps ${blocker.component} at ${blocker.cap}`,
  }));
}

function discoveryFindings(bundle: DiscoveryBundle): Finding[] {
  const p = bundle.auditedPage;

  return [
    discoveryFinding(
      'page-class',
      'info',
      'Page classification',
      `siteType=${bundle.siteType} pageKind=${bundle.pageKind} words=${p.wordCount}`,
    ),
    discoveryFinding(
      'robots',
      p.robotsStatus === 'present' ? 'pass' : 'warn',
      'robots.txt',
      withFetchError(p.robotsStatus, p.robotsFetchError),
    ),
    sitemapFinding(bundle.sitemap),
    discoveryFinding(
      'llms',
      llmsSeverityOf(bundle.llmsTxt),
      'llms.txt status',
      withFetchError(bundle.llms_txt_status, bundle.llmsTxt.fetchError),
    ),
    httpsFinding(bundle),
    discoveryFinding(
      'crux',
      'info',
      'CrUX',
      bundle.crux.status === 'skipped'
        ? bundle.crux.errors.join('; ') || 'skipped'
        : `${bundle.crux.status} (${bundle.crux.results.length} result(s))`,
    ),
    discoveryFinding(
      'redirects',
      bundle.redirects.chain_length > 1 ? 'warn' : 'info',
      'Redirects',
      `chain=${bundle.redirects.chain_length} http→https=${bundle.redirects.http_to_https ? 'yes' : 'no'} www_normalized=${bundle.redirects.www_normalized}`,
    ),
    searchCrawlerFinding(bundle),
    mobileParityFinding(bundle),
    renderFinding(bundle),
  ];
}

function schemaFindings(bundle: DiscoveryBundle): Finding[] {
  const { blocks } = analyzeSchema(bundle.schemaBlocks);

  if (blocks.length === 0) {
    return [makeFinding('schema', 'jsonld', 'fail', 'JSON-LD', 'no application/ld+json blocks')];
  }

  return blocks.flatMap((block) =>
    block.checks.map((check) => fromCheck(`schema:${block.index}`, check)),
  );
}

function metaFindings(bundle: DiscoveryBundle): Finding[] {
  return analyzeMeta(bundle.metaTags, bundle.auditedUrl).checks.map((check) =>
    fromCheck('meta', check),
  );
}

function robotsFindings(bundle: DiscoveryBundle): Finding[] {
  return [
    ...robotsAnalysisForBundle(bundle).checks.map((check) => fromCheck('robots', check)),
    blockedResourcesFinding(bundle),
  ];
}

function llmsFindings(bundle: DiscoveryBundle): Finding[] {
  const analysis = llmsAnalysisForBundle(bundle);

  return [
    ...analysis.checks.map((check) => fromCheck('llms', check)),
    ...analysis.llmsFullChecks.map((check) => fromCheck('llms-full', check)),
  ];
}

/**
 * Builds findings from critical blockers, discovery facts, and tool analyzers.
 */
export function collectFindings(
  bundle: DiscoveryBundle,
  blockers: readonly CriticalBlocker[],
): Finding[] {
  return [
    ...blockerFindings(blockers),
    ...discoveryFindings(bundle),
    ...schemaFindings(bundle),
    ...metaFindings(bundle),
    ...pageMetaFindings(bundle),
    ...robotsFindings(bundle),
    ...llmsFindings(bundle),
    ...securityFindings(bundle),
  ];
}

/** Worst finding severity, treating info as pass. */
function overallFindingStatus(findings: readonly Finding[]): FindingSeverity {
  if (findings.some((f) => f.severity === 'fail')) {
    return 'fail';
  }

  if (findings.some((f) => f.severity === 'warn')) {
    return 'warn';
  }

  return 'pass';
}

/**
 * Status used by `audit --fail-on`. Keys off critical blockers and discovery
 * facts, not advisory tool checks (CSP/schema/llms).
 */
export function auditThresholdStatus(
  blockers: readonly CriticalBlocker[],
  findings: readonly Finding[],
): FindingSeverity {
  if (blockers.length > 0) {
    return 'fail';
  }

  const discovery = findings.filter((finding) => finding.source === 'discovery');

  return overallFindingStatus(discovery);
}

export type KindReportKind = Extract<ReportKind, 'geo' | 'seo'>;

export const SEO_BLOCKERS = new Set<CriticalBlocker['id']>([
  'noindex_or_error',
  'no_https',
  'poor_core_web_vitals',
  'oversized_html',
  'thin_content',
  'no_structured_data',
]);

export const GEO_BLOCKERS = new Set<CriticalBlocker['id']>([
  'live_retrieval_blocked',
  'csr_only_rendering',
]);

const SEO_DISCOVERY = new Set([
  'page-class',
  'robots',
  'sitemap',
  'crux',
  'redirects',
  'search-crawlers',
  'mobile',
  'render',
]);
const GEO_DISCOVERY = new Set(['page-class', 'llms']);

const DISCOVERY_BY_KIND: Record<KindReportKind, ReadonlySet<string>> = {
  seo: SEO_DISCOVERY,
  geo: GEO_DISCOVERY,
};

export const BLOCKERS_BY_KIND: Record<KindReportKind, ReadonlySet<CriticalBlocker['id']>> = {
  seo: SEO_BLOCKERS,
  geo: GEO_BLOCKERS,
};

/** The id text after `prefix`, when the finding came from `source` with that prefix. */
function idAfterPrefix(finding: Finding, source: string, prefix: string): string | undefined {
  if (finding.source !== source || !finding.id.startsWith(prefix)) {
    return undefined;
  }

  return finding.id.slice(prefix.length);
}

function discoveryKey(finding: Finding): string | undefined {
  return idAfterPrefix(finding, 'discovery', 'discovery:');
}

function blockerId(finding: Finding): CriticalBlocker['id'] | undefined {
  return idAfterPrefix(finding, 'critical-blocker', 'blocker:') as
    | CriticalBlocker['id']
    | undefined;
}

function isSchemaSource(source: string): boolean {
  return source === 'schema' || source.startsWith('schema:');
}

function findingBelongsToKind(kind: KindReportKind, finding: Finding): boolean {
  const discovery = discoveryKey(finding);

  if (discovery) {
    return DISCOVERY_BY_KIND[kind].has(discovery);
  }

  const blocker = blockerId(finding);

  if (blocker) {
    return BLOCKERS_BY_KIND[kind].has(blocker);
  }

  if (kind === 'seo') {
    return (
      finding.source === 'meta' ||
      finding.source === 'security-headers' ||
      finding.source === 'robots' ||
      isSchemaSource(finding.source)
    );
  }

  return finding.source === 'llms' || finding.source === 'llms-full';
}

/** Keeps analyzer/discovery findings that belong to `geo` or `seo`. */
export function filterFindingsForKind(
  kind: KindReportKind,
  findings: readonly Finding[],
): Finding[] {
  return findings.filter((finding) => findingBelongsToKind(kind, finding));
}

function h1Finding({
  h1Count,
  h1ElementCount,
}: DiscoveryBundle['auditedPage']['headings']): Finding {
  if (h1Count === 1) {
    return makeFinding('content', 'h1', 'pass', 'H1', 'one H1');
  }

  if (h1ElementCount > 0 && h1Count === 0) {
    return makeFinding('content', 'h1', 'warn', 'H1', 'H1 element with no text');
  }

  if (h1Count === 0) {
    return makeFinding('content', 'h1', 'fail', 'H1', 'missing');
  }

  return makeFinding('content', 'h1', 'warn', 'H1', `${h1Count} H1 elements`);
}

function imageAltFinding({
  total,
  missingAlt,
  decorative,
}: DiscoveryBundle['auditedPage']['images']): Finding {
  if (total === 0) {
    return makeFinding('content', 'image-alt', 'info', 'Image alt', 'no images');
  }

  if (missingAlt === 0) {
    return makeFinding(
      'content',
      'image-alt',
      'pass',
      'Image alt',
      `all have alt (${decorative} decorative)`,
    );
  }

  return makeFinding(
    'content',
    'image-alt',
    'warn',
    'Image alt',
    `${missingAlt}/${total} missing alt (${decorative} decorative)`,
  );
}

function datesFinding({ published, modified }: DiscoveryBundle['auditedPage']['dates']): Finding {
  if (published && modified) {
    return makeFinding(
      'content',
      'dates',
      'pass',
      'Dates',
      `published=${published} modified=${modified}`,
    );
  }

  if (published || modified) {
    return makeFinding(
      'content',
      'dates',
      'warn',
      'Dates',
      `published=${published ?? 'missing'} modified=${modified ?? 'missing'}`,
    );
  }

  return makeFinding('content', 'dates', 'warn', 'Dates', 'missing datePublished and dateModified');
}

function seoContentExtras(bundle: DiscoveryBundle): Finding[] {
  const page = bundle.auditedPage;
  const author = page.author.hasAuthor
    ? makeFinding('content', 'author', 'pass', 'Author', page.author.names.join(', ') || 'present')
    : makeFinding('content', 'author', 'warn', 'Author', 'missing');

  return [h1Finding(page.headings), imageAltFinding(page.images), author, datesFinding(page.dates)];
}

function seoDiscoverExtras(bundle: DiscoveryBundle): Finding[] {
  const { maxImagePreviewLarge, hasRepresentativeImage } = bundle.auditedPage.discover;

  return [
    makeFinding(
      'discover',
      'max-image-preview',
      maxImagePreviewLarge ? 'pass' : 'warn',
      'max-image-preview',
      maxImagePreviewLarge ? 'large' : 'not large',
    ),
    makeFinding(
      'discover',
      'representative-image',
      hasRepresentativeImage ? 'pass' : 'warn',
      'Representative image',
      hasRepresentativeImage ? 'present' : 'missing',
    ),
  ];
}

function citabilitySeverity(score: number): FindingSeverity {
  if (score >= 70) {
    return 'pass';
  }

  if (score >= 40) {
    return 'warn';
  }

  return 'fail';
}

function geoCitabilityExtras(bundle: DiscoveryBundle): Finding[] {
  const citability = bundle.auditedPage.citability;

  return [
    makeFinding(
      'citability',
      'page-score',
      citabilitySeverity(citability.page_score),
      'Page citability',
      String(citability.page_score),
    ),
    makeFinding(
      'citability',
      'citation-ready',
      citability.citation_ready_blocks > 0 ? 'pass' : 'warn',
      'Citation-ready blocks',
      String(citability.citation_ready_blocks),
    ),
    makeFinding(
      'citability',
      'ideal-range',
      citability.ideal_range_blocks > 0 ? 'pass' : 'info',
      'Ideal-range blocks',
      `${citability.ideal_range_blocks} in ${CITABILITY_IDEAL_MIN_WORDS}–${CITABILITY_IDEAL_MAX_WORDS} words`,
    ),
  ];
}

function crawlerCategory(bot: string): string {
  return AI_CRAWLERS.find((crawler) => crawler.userAgent === bot)?.category ?? 'search';
}

function crawlerSeverity(status: string): FindingSeverity {
  if (status === 'allowed') {
    return 'pass';
  }

  if (status === 'blocked') {
    return 'fail';
  }

  return 'warn';
}

function geoCrawlerExtras(bundle: DiscoveryBundle): Finding[] {
  return bundle.crawlerAccess.crawlers.map((entry) =>
    makeFinding(
      'crawlers',
      entry.bot,
      crawlerSeverity(entry.status),
      entry.bot,
      `${entry.status}${LIVE_RETRIEVAL_BOTS.has(entry.bot) ? ', live-retrieval gate' : ''} (${crawlerCategory(entry.bot)})`,
    ),
  );
}

function geoPlatformExtras(bundle: DiscoveryBundle): Finding[] {
  const signals = bundle.platform_signals;
  const content = bundle.auditedPage.contentSignals;

  return [
    makeFinding(
      'platform',
      'faq',
      signals.faq_pattern ? 'pass' : 'info',
      'FAQ pattern',
      signals.faq_pattern ? 'present (inferred)' : 'absent (inferred)',
    ),
    makeFinding(
      'platform',
      'definition',
      content.hasDefinitionPattern ? 'pass' : 'info',
      'Definition pattern',
      content.hasDefinitionPattern ? 'present (inferred)' : 'absent (inferred)',
    ),
    makeFinding(
      'platform',
      'question-headings',
      signals.question_heading_count > 0 ? 'pass' : 'info',
      'Question headings',
      `${signals.question_heading_count} (inferred)`,
    ),
    makeFinding(
      'platform',
      'tables',
      signals.table_count > 0 ? 'pass' : 'info',
      'Tables',
      `${signals.table_count} (inferred)`,
    ),
    makeFinding(
      'platform',
      'stats',
      signals.statistic_snippet_count > 0 ? 'pass' : 'info',
      'Statistic snippets',
      `${signals.statistic_snippet_count} (inferred)`,
    ),
    makeFinding(
      'speakable',
      'jsonld',
      bundle.auditedPage.hasSpeakable ? 'pass' : 'info',
      'Speakable',
      bundle.auditedPage.hasSpeakable ? 'present' : 'missing (optional)',
    ),
  ];
}

/** Kind-only findings appended by geo-check, seo-check, and audit. */
export function kindExtras(kind: KindReportKind, bundle: DiscoveryBundle): Finding[] {
  if (kind === 'seo') {
    return [
      ...seoContentExtras(bundle),
      ...pageContentFindings(bundle),
      promptInjectionFinding(bundle),
      ...pageLinkFindings(bundle),
      ...seoDiscoverExtras(bundle),
    ];
  }

  return [
    ...geoCitabilityExtras(bundle),
    ...geoCrawlerExtras(bundle),
    ...geoPlatformExtras(bundle),
  ];
}

/**
 * `--fail-on` for geo-check / seo-check: kind blockers plus that kind's
 * discovery findings. Advisory tool checks stay out of the gate.
 */
export function kindThresholdStatus(
  kind: KindReportKind,
  blockers: readonly CriticalBlocker[],
  findings: readonly Finding[],
): FindingSeverity {
  if (blockers.some((blocker) => BLOCKERS_BY_KIND[kind].has(blocker.id))) {
    return 'fail';
  }

  const discovery = findings.filter((finding) => {
    const key = discoveryKey(finding);

    return key !== undefined && DISCOVERY_BY_KIND[kind].has(key);
  });

  return overallFindingStatus(discovery);
}
