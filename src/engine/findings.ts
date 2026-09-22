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
import { AI_CRAWLERS } from '../tools/robots/aiCrawlers';
import type { DiscoveryBundle } from './discovery.ts';
import { CITABILITY_IDEAL_MAX_WORDS, CITABILITY_IDEAL_MIN_WORDS } from './citabilityBlocks.ts';
import type { CriticalBlocker } from './scoring.ts';
import type { Finding, FindingSeverity, ReportKind } from './types.ts';

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
  return {
    id: `${source}:${check.id}`,
    source,
    severity: check.status,
    title: check.label,
    detail: check.detail,
  };
}

/** Maps a discovery fact onto a finding with the `discovery:` id prefix. */

function discoveryFinding(
  id: string,
  severity: FindingSeverity,
  title: string,
  detail: string,
): Finding {
  return { id: `discovery:${id}`, source: 'discovery', severity, title, detail };
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

function securityFindings(bundle: DiscoveryBundle): Finding[] {
  const headers = parseSecurityHeaders(bundle.pageHeaders);
  const ctx = buildAnalyzeContext({
    finalUrl: bundle.auditedUrl,
    status: bundle.auditedPage.statusCode,
  });

  return analyzeSecurityHeaders(headers, ctx).checks.map((check) => ({
    id: `security:${check.id}`,
    source: 'security-headers',
    severity: check.status,
    title: check.label,
    detail: check.value?.trim() || check.detail?.trim() || 'missing',
  }));
}

/**
 * Builds findings from critical blockers, discovery facts, and tool analyzers.
 */
export function collectFindings(
  bundle: DiscoveryBundle,
  blockers: readonly CriticalBlocker[],
): Finding[] {
  const findings: Finding[] = [];

  for (const blocker of blockers) {
    findings.push({
      id: `blocker:${blocker.id}`,
      source: 'critical-blocker',
      severity: 'fail',
      title: BLOCKER_TITLE[blocker.id],
      detail: `Caps ${blocker.component} at ${blocker.cap}`,
    });
  }

  const p = bundle.auditedPage;
  let sitemapDetail = 'missing';
  let llmsSeverity: FindingSeverity = 'info';

  if (bundle.sitemap.present) {
    sitemapDetail = `${bundle.sitemap.url_count} URLs, audited listed=${bundle.sitemap.audited_url_listed}`;
  } else if (bundle.sitemap.fetchStatus === 'error') {
    sitemapDetail = 'error';
  }

  if (bundle.llmsTxt.exists) {
    llmsSeverity = 'pass';
  } else if (bundle.llmsTxt.fetchStatus === 'error') {
    llmsSeverity = 'warn';
  }

  findings.push(
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
      p.robotsStatus,
    ),
    discoveryFinding('sitemap', bundle.sitemap.present ? 'pass' : 'warn', 'Sitemap', sitemapDetail),
    discoveryFinding('llms', llmsSeverity, 'llms.txt status', bundle.llms_txt_status),
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
      'info',
      'Redirects',
      `chain=${bundle.redirects.chain_length} http→https=${bundle.redirects.http_to_https ? 'yes' : 'no'} www_normalized=${bundle.redirects.www_normalized}`,
    ),
  );

  const schema = analyzeSchema(bundle.schemaBlocks);

  for (const block of schema.blocks) {
    for (const check of block.checks) {
      findings.push(fromCheck(`schema:${block.index}`, check));
    }
  }

  if (schema.blocks.length === 0) {
    findings.push({
      id: 'schema:jsonld',
      source: 'schema',
      severity: 'fail',
      title: 'JSON-LD',
      detail: 'no application/ld+json blocks',
    });
  }

  const meta = analyzeMeta(bundle.metaTags, bundle.auditedUrl);

  for (const check of meta.checks) {
    findings.push(fromCheck('meta', check));
  }

  for (const check of robotsAnalysisForBundle(bundle).checks) {
    findings.push(fromCheck('robots', check));
  }

  const llmsAnalysis = llmsAnalysisForBundle(bundle);

  for (const check of llmsAnalysis.checks) {
    findings.push(fromCheck('llms', check));
  }

  for (const check of llmsAnalysis.llmsFullChecks) {
    findings.push(fromCheck('llms-full', check));
  }

  findings.push(...securityFindings(bundle));

  return findings;
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
  'csr_only_rendering',
  'oversized_html',
  'thin_content',
  'no_structured_data',
]);

export const GEO_BLOCKERS = new Set<CriticalBlocker['id']>(['live_retrieval_blocked']);

const SEO_DISCOVERY = new Set(['page-class', 'robots', 'sitemap', 'crux', 'redirects']);
const GEO_DISCOVERY = new Set(['page-class', 'llms']);

const DISCOVERY_BY_KIND: Record<KindReportKind, ReadonlySet<string>> = {
  seo: SEO_DISCOVERY,
  geo: GEO_DISCOVERY,
};

const BLOCKERS_BY_KIND: Record<KindReportKind, ReadonlySet<CriticalBlocker['id']>> = {
  seo: SEO_BLOCKERS,
  geo: GEO_BLOCKERS,
};

function discoveryKey(finding: Finding): string | undefined {
  if (finding.source !== 'discovery' || !finding.id.startsWith('discovery:')) {
    return undefined;
  }

  return finding.id.slice('discovery:'.length);
}

function blockerId(finding: Finding): CriticalBlocker['id'] | undefined {
  if (finding.source !== 'critical-blocker' || !finding.id.startsWith('blocker:')) {
    return undefined;
  }

  return finding.id.slice('blocker:'.length) as CriticalBlocker['id'];
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

function extraFinding(
  source: string,
  id: string,
  severity: FindingSeverity,
  title: string,
  detail: string,
): Finding {
  return { id: `${source}:${id}`, source, severity, title, detail };
}

function seoContentExtras(bundle: DiscoveryBundle): Finding[] {
  const page = bundle.auditedPage;
  const { h1Count } = page.headings;
  let h1: Finding;

  if (h1Count === 1) {
    h1 = extraFinding('content', 'h1', 'pass', 'H1', 'one H1');
  } else if (h1Count === 0) {
    h1 = extraFinding('content', 'h1', 'fail', 'H1', 'missing');
  } else {
    h1 = extraFinding('content', 'h1', 'warn', 'H1', `${h1Count} H1 elements`);
  }

  const { total, missingAlt } = page.images;
  let images: Finding;

  if (total === 0) {
    images = extraFinding('content', 'image-alt', 'info', 'Image alt', 'no images');
  } else if (missingAlt === 0) {
    images = extraFinding('content', 'image-alt', 'pass', 'Image alt', 'all have alt');
  } else {
    images = extraFinding(
      'content',
      'image-alt',
      'warn',
      'Image alt',
      `${missingAlt}/${total} missing alt`,
    );
  }

  const author = page.author.hasAuthor
    ? extraFinding('content', 'author', 'pass', 'Author', page.author.names.join(', ') || 'present')
    : extraFinding('content', 'author', 'warn', 'Author', 'missing');
  const { published, modified } = page.dates;
  let dates: Finding;

  if (published && modified) {
    dates = extraFinding(
      'content',
      'dates',
      'pass',
      'Dates',
      `published=${published} modified=${modified}`,
    );
  } else if (published || modified) {
    dates = extraFinding(
      'content',
      'dates',
      'warn',
      'Dates',
      `published=${published ?? 'missing'} modified=${modified ?? 'missing'}`,
    );
  } else {
    dates = extraFinding(
      'content',
      'dates',
      'warn',
      'Dates',
      'missing datePublished and dateModified',
    );
  }

  return [h1, images, author, dates];
}

function seoDiscoverExtras(bundle: DiscoveryBundle): Finding[] {
  const { maxImagePreviewLarge, hasRepresentativeImage } = bundle.auditedPage.discover;

  return [
    extraFinding(
      'discover',
      'max-image-preview',
      maxImagePreviewLarge ? 'pass' : 'warn',
      'max-image-preview',
      maxImagePreviewLarge ? 'large' : 'not large',
    ),
    extraFinding(
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
    extraFinding(
      'citability',
      'page-score',
      citabilitySeverity(citability.page_score),
      'Page citability',
      String(citability.page_score),
    ),
    extraFinding(
      'citability',
      'citation-ready',
      citability.citation_ready_blocks > 0 ? 'pass' : 'warn',
      'Citation-ready blocks',
      String(citability.citation_ready_blocks),
    ),
    extraFinding(
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
    extraFinding(
      'crawlers',
      entry.bot,
      crawlerSeverity(entry.status),
      entry.bot,
      `${entry.status} (${crawlerCategory(entry.bot)})`,
    ),
  );
}

function geoPlatformExtras(bundle: DiscoveryBundle): Finding[] {
  const signals = bundle.platform_signals;
  const content = bundle.auditedPage.contentSignals;

  return [
    extraFinding(
      'platform',
      'faq',
      signals.faq_pattern ? 'pass' : 'info',
      'FAQ pattern',
      signals.faq_pattern ? 'present (inferred)' : 'absent (inferred)',
    ),
    extraFinding(
      'platform',
      'definition',
      content.hasDefinitionPattern ? 'pass' : 'info',
      'Definition pattern',
      content.hasDefinitionPattern ? 'present (inferred)' : 'absent (inferred)',
    ),
    extraFinding(
      'platform',
      'question-headings',
      signals.question_heading_count > 0 ? 'pass' : 'info',
      'Question headings',
      `${signals.question_heading_count} (inferred)`,
    ),
    extraFinding(
      'platform',
      'tables',
      signals.table_count > 0 ? 'pass' : 'info',
      'Tables',
      `${signals.table_count} (inferred)`,
    ),
    extraFinding(
      'platform',
      'stats',
      signals.statistic_snippet_count > 0 ? 'pass' : 'info',
      'Statistic snippets',
      `${signals.statistic_snippet_count} (inferred)`,
    ),
    extraFinding(
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
    return [...seoContentExtras(bundle), ...seoDiscoverExtras(bundle)];
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
