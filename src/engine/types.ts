import type { CitabilitySummary } from './citabilityBlocks.ts';
import type { StructuredDataSummary } from './htmlParser.ts';
import type { HttpsReadiness } from './httpsReadiness.ts';
import type { ExternalResources } from './parsers/externalResources.ts';
import type { ImageSignals, VideoSignal } from './parsers/imageDiscover.ts';
import type { PageKind, SiteType } from './pageClassification.ts';
import type {
  HeadingOutlineItem,
  HiddenText,
  MixedContent,
  TrustPages,
} from './parsers/pageHygiene.ts';
import type { RedirectSignals } from './redirectSignals.ts';
import type { RobotsTxtParseResult } from './robotsTxtParser.ts';

export type LlmsTxtStatus =
  | 'absent'
  | 'error'
  | 'malformed'
  | 'limited'
  | 'useful'
  | 'comprehensive';

export type EvidenceType = 'direct' | 'mixed' | 'indirect' | 'lab' | 'inferred' | 'insufficient';
export type ReportKind = 'overview' | 'geo' | 'seo';
export type ScoreConfidence = 'high' | 'medium' | 'low';
export type ScoreLabel = 'Excellent' | 'Good' | 'Moderate' | 'Below Average' | 'Needs Attention';

export type ScoreComponentId =
  | 'ai_citability_visibility'
  | 'content_quality'
  | 'technical_foundations'
  | 'structured_data'
  | 'platform_optimization';

export interface ScoreBreakdownItem {
  component: ScoreComponentId;
  display_name: string;
  score: number | null;
  weight: number;
  weighted: number | null;
  evidence_type: EvidenceType;
}

export interface CruxMetric {
  p75?: number | null;
  rating?: string;
  good_density?: number | null;
  needs_improvement_density?: number | null;
  poor_density?: number | null;
  histogram?: unknown[];
  fractions?: Record<string, unknown>;
}

export interface CruxParsedRecord {
  cwv_pass: boolean | null;
  metrics: Record<string, CruxMetric>;
  collection_period?: unknown;
  url_normalization?: unknown;
}

export interface CruxUrlResult {
  url: string;
  origin: string;
  status: 'ok' | 'partial' | 'error' | 'no_data';
  url_data: CruxParsedRecord | null;
  origin_data: CruxParsedRecord | null;
  errors: string[];
}

export interface CruxFetchResult {
  status: 'completed' | 'skipped';
  results: CruxUrlResult[];
  errors: string[];
}

/** One llms.txt problem. `line` and `text` are set for syntax errors only. */
export interface LlmsTxtIssue {
  code: string;
  line: number | null;
  /** Snippet or section name of the line, trimmed to 120 characters. */
  text: string | null;
}

export interface LlmsTxtResult {
  url: string;
  exists: boolean;
  /** Same present / missing / error split as robots.txt (`classifyRobotsHttp`). */
  fetchStatus: 'present' | 'missing' | 'error';
  /** Short error code when the file failed to load after retries, else null. */
  fetchError: string | null;
  format_valid: boolean;
  has_title: boolean;
  has_sections: boolean;
  has_links: boolean;
  section_count: number;
  link_count: number;
  links: { title: string; url: string }[];
  linksTruncated: boolean;
  /** True when a link matches the audited page before the 100-link cap. */
  linksToAuditedUrl: boolean;
  issues: LlmsTxtIssue[];
  content: string | null;
  full_content: string | null;
  contentType: string;
  full_version: { url: string; exists: boolean; contentType: string };
}

export interface SitemapParseResult {
  present: boolean;
  /** Same present / missing / error split as robots.txt (`classifyRobotsHttp`). */
  fetchStatus: 'present' | 'missing' | 'error';
  url_count: number;
  audited_url_listed: boolean;
  audited_url_lastmod: string | null;
  urls: { loc: string; lastmod: string | null }[];
  urlsTruncated: boolean;
  /**
   * `partial` when a declared file failed or the file cap stopped the walk.
   * Then `audited_url_listed: false` is not proof that the page is unlisted.
   */
  coverage: 'complete' | 'partial';
  /** Sitemap files read (roots, index files, and child urlsets). */
  filesRead: number;
}

export interface SecurityHeadersSummary {
  hsts: boolean;
  csp: boolean;
  x_frame: boolean;
  x_content_type: boolean;
  referrer_policy: boolean;
  x_robots_tag: string | null;
}

export interface MobilePageSnapshot {
  statusCode: number;
  byteLength: number;
  wordCount: number;
  h1: string[];
  jsRenderingRisk: { isLikelyCsr: boolean; reason: string | null };
  canonicalUrl: string | null;
  effectiveRobotsDirective: string | null;
  viewport: boolean;
  structuredDataTypes: string[];
  internalLinkCount: number;
  visibleTextSha256: string;
  visibleTextExcerpt: string;
}

export interface PageLink {
  href: string;
  text: string;
  /** `aria-label` of the anchor, trimmed, or null. */
  ariaLabel: string | null;
  /** Alt of the first `img` inside the anchor with a non-empty alt, or null. */
  imgAlt: string | null;
}

export interface LinkCheck {
  href: string;
  scope: 'internal';
  /** Final HTTP status, or null when the fetch failed. */
  status: number | null;
  finalUrl: string | null;
  redirects: number;
  /** Fetch error code (`timeout`, `blocked`, `network`, ...) or null. */
  error: string | null;
}

export interface LinkStatusReport {
  /** `skipped` outside `audit`. */
  status: 'completed' | 'skipped';
  checked: number;
  /** Stored same-site links that could be probed. Outbound links are counted, never probed. */
  candidates: number;
  results: LinkCheck[];
}

export interface SnippetDirectives {
  nosnippet: boolean;
  maxSnippet: string | null;
  noarchive: boolean;
  unavailableAfter: string | null;
  dataNosnippet: boolean;
}

export interface AuditedPageSnapshot {
  url: string;
  statusCode: number;
  byteLength: number;
  /** Hex SHA-256 of this page's HTML body. Scoring does not read it. */
  bodySha256: string;
  redirectCount: number;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsDirective: string | null;
  effectiveRobotsDirective: string | null;
  lang: string | null;
  robotsStatus: string;
  /** Short error code when robots.txt failed to load after retries (`timeout`, `http_503`, ...). */
  robotsFetchError: string | null;
  sitemapStatus: string;
  internalLinks: PageLink[];
  internalLinkCount: number;
  internalLinksTruncated: boolean;
  outboundLinks: PageLink[];
  outboundLinksTruncated: boolean;
  snippetDirectives: SnippetDirectives;
  /** Same-host page keys, built before the 50-link display cap. */
  internalLinkIndex: string[];
  internalLinkIndexTruncated: boolean;
  /** Words in the main content root (main, article, else body without chrome). */
  wordCount: number;
  /** Words in the whole visible body, page chrome included. */
  bodyWordCount: number;
  /** Main content text, the root `wordCount` reads, cut at 20000 characters. */
  mainText: string;
  mainTextTruncated: boolean;
  /** Up to 5 main content tables, each up to 30 rows of up to 10 cell texts (200 characters each). */
  tables: string[][][];
  mixedContent: MixedContent;
  /** Scripts and stylesheets on the audited host, up to 30. */
  sameHostResources: string[];
  hiddenText: HiddenText;
  /** `<meta charset>` or http-equiv charset, lowercase. */
  charset: string | null;
  /** First same-site about, contact, privacy, and terms links. */
  trustPages: TrustPages;
  /** Cross-origin resource origins per kind, and inline script and style counts. */
  externalResources: ExternalResources;
  structuredData: StructuredDataSummary;
  headings: {
    h1: string[];
    h1Count: number;
    h1ElementCount: number;
    h2: string[];
    h2Count: number;
    h2NonEmpty: number;
    h3: string[];
    h3Count: number;
    h3NonEmpty: number;
    /** H1–H6 in document order, at most 60. */
    outline: HeadingOutlineItem[];
  };
  viewport: boolean;
  hreflang: string[];
  hreflangLinks: { lang: string; href: string }[];
  headerCanonical: string | null;
  headerHreflang: { lang: string; href: string }[];
  robotsNoindexSource: 'meta' | 'header' | 'bot' | null;
  pagination: { next: string | null; prev: string | null };
  breadcrumbParent: string | null;
  visibleTextSha256: string;
  visibleTextExcerpt: string;
  dates: { published: string | null; modified: string | null; visible: string | null };
  author: { hasAuthor: boolean; names: string[]; urls: string[] };
  social: {
    openGraph: {
      title: string | null;
      description: string | null;
      image: string | null;
      type: string | null;
      url: string | null;
      locale: string | null;
    };
    twitter: { card: string | null };
  };
  contentSignals: {
    paragraphs: number;
    lists: number;
    tables: number;
    hasTopSummary: boolean;
    hasFaqPattern: boolean;
    hasDefinitionPattern: boolean;
    listingPattern: boolean;
    question_heading_count: number;
    statistic_snippet_count: number;
  };
  markupFormats: {
    has_microdata: boolean;
    microdata_item_count: number;
    microdata_types: string[];
    has_rdfa: boolean;
    rdfa_property_count: number;
    rdfa_types: string[];
    jsonld_only: boolean;
    jsonld_blocks_missing_type: number;
  };
  metaRobotsByBot: Record<string, string>;
  jsRenderingRisk: { isLikelyCsr: boolean; reason: string | null };
  images: ImageSignals;
  videos: VideoSignal[];
  discover: { maxImagePreviewLarge: boolean; hasRepresentativeImage: boolean };
  citability: CitabilitySummary;
  hasSpeakable: boolean;
  pageKind: PageKind;
  siteType: SiteType;
}

export type RenderReason = 'not-requested' | 'chrome-missing' | 'timeout' | 'too_large' | 'error';

/**
 * Chrome-rendered DOM of the audited URL, run through the same parser as the raw
 * HTML. Content fields are null unless `status` is `ok`.
 */
export interface RenderedPage {
  status: 'ok' | 'skipped' | 'error';
  reason: RenderReason | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  effectiveRobotsDirective: string | null;
  h1: string[] | null;
  wordCount: number | null;
  /** Main content text, cut at 20000 characters. */
  mainText: string | null;
  /** True when the render held more text than `mainText` keeps. Null unless `ok`. */
  mainTextTruncated: boolean | null;
  structuredDataTypes: string[] | null;
  internalLinkCount: number | null;
  hreflang: string[] | null;
  visibleTextSha256: string | null;
  /** Install command or phrase for a missing Chrome. Null otherwise. */
  install: string | null;
  /** Rendered internal-link pageKeys missing from the raw index, up to 20. Null unless `ok`. */
  linksOnlyAfterRender: string[] | null;
  /** All such pageKeys, not capped. Null unless `ok`. */
  linksOnlyAfterRenderCount: number | null;
}

export interface PlatformSignals {
  question_heading_count: number;
  faq_pattern: boolean;
  table_count: number;
  list_count: number;
  statistic_snippet_count: number;
  visible_dates: boolean;
  has_author: boolean;
}

/**
 * Audit level of this run. The CLI scores one page. Every other request is
 * evidence for that page, counted in `contextFetches`.
 */
export interface AuditScope {
  level: 'page';
  pagesScored: 1;
  contextFetches: {
    robots: boolean;
    sitemapFiles: number;
    llmsTxt: boolean;
    crux: boolean;
    mobilePage: boolean;
    linksProbed: number;
  };
}

/** Snapshot of one local discovery run, consumed by scoring and findings. */
export interface DiscoveryResult {
  domain: string;
  auditedUrl: string;
  auditScope: AuditScope;
  /** ISO time of the audited page fetch. Freshness scoring measures age from it. */
  fetchedAt: string;
  pageKind: PageKind;
  siteType: SiteType;
  technicalUrls: string[];
  crux: CruxFetchResult;
  llmsTxt: LlmsTxtResult;
  llms_txt_status: LlmsTxtStatus;
  securityHeaders: SecurityHeadersSummary;
  crawlerAccess: RobotsTxtParseResult;
  sitemap: SitemapParseResult;
  redirects: RedirectSignals;
  platform_signals: PlatformSignals;
  auditedPage: AuditedPageSnapshot;
  mobilePage: MobilePageSnapshot | null;
  /** Why `mobilePage` is null (a fetch error code; an HTTP error status still returns a page), else null. */
  mobileFetchError: string | null;
  /** Status probe of links on the audited page. Only `audit` runs it. */
  linkStatus: LinkStatusReport;
  /** HTTPS production readiness of a loopback page. Null for any other URL. */
  httpsReadiness: HttpsReadiness | null;
  /** Chrome render of the audited URL. `not-requested` outside `audit` with a lab trigger. */
  renderedPage: RenderedPage;
  pagesSampled: number;
}

export type FindingSeverity = 'fail' | 'warn' | 'pass' | 'info';

export interface Finding {
  id: string;
  source: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
}
