import type { CitabilitySummary } from './citabilityBlocks.ts';
import type { StructuredDataSummary } from './htmlParser.ts';
import type { PageKind, SiteType } from './pageClassification.ts';
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

export interface LlmsTxtResult {
  url: string;
  exists: boolean;
  /** Same present / missing / error split as robots.txt (`classifyRobotsHttp`). */
  fetchStatus: 'present' | 'missing' | 'error';
  format_valid: boolean;
  has_title: boolean;
  has_sections: boolean;
  has_links: boolean;
  section_count: number;
  link_count: number;
  issues: string[];
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
}

export interface SecurityHeadersSummary {
  hsts: boolean;
  csp: boolean;
  x_frame: boolean;
  x_content_type: boolean;
  referrer_policy: boolean;
  x_robots_tag: string | null;
}

export interface AuditedPageSnapshot {
  url: string;
  statusCode: number;
  byteLength: number;
  redirectCount: number;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsDirective: string | null;
  effectiveRobotsDirective: string | null;
  lang: string | null;
  robotsStatus: string;
  sitemapStatus: string;
  internalLinks: string[];
  wordCount: number;
  structuredData: StructuredDataSummary;
  headings: {
    h1: string[];
    h1Count: number;
    h1ElementCount: number;
    h2Count: number;
    h3Count: number;
  };
  viewport: boolean;
  hreflang: string[];
  dates: { published: string | null; modified: string | null };
  author: { hasAuthor: boolean; names: string[] };
  social: {
    openGraph: { title: boolean; image: boolean; type: string | null };
    twitter: { card: boolean };
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
    has_rdfa: boolean;
    rdfa_property_count: number;
    jsonld_only: boolean;
    jsonld_blocks_missing_type: number;
  };
  metaRobotsByBot: Record<string, string>;
  jsRenderingRisk: { isLikelyCsr: boolean; reason: string | null };
  images: { total: number; withAlt: number; missingAlt: number };
  discover: { maxImagePreviewLarge: boolean; hasRepresentativeImage: boolean };
  citability: CitabilitySummary;
  hasSpeakable: boolean;
  pageKind: PageKind;
  siteType: SiteType;
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

/** Snapshot of one local discovery run, consumed by scoring and findings. */
export interface DiscoveryResult {
  domain: string;
  auditedUrl: string;
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
