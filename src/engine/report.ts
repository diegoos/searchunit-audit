import type { DiscoveryBundle } from './discovery.ts';
import {
  computeAuditScores,
  scoreForKind,
  type AuditScores,
  type CriticalBlocker,
  type KindScore,
} from './scoring.ts';

import {
  collectFindings,
  filterFindingsForKind,
  GEO_BLOCKERS,
  kindExtras,
  SEO_BLOCKERS,
  type KindReportKind,
} from './findings.ts';
import { cruxApiKeyAvailable } from '../lib/config.ts';
import { googleProfileFromAuditedUrl, type GoogleProfileSummary } from '../lib/googleProfile.ts';
import type { DiscoveryResult, Finding, ReportKind } from './types.ts';

export type KindCommand = 'geo-check' | 'seo-check';

/** Kind score, blockers, and findings without repeating discovery. */
export interface KindReportBody {
  command: KindCommand;
  kind: KindReportKind;
  scores: AuditScores;
  blockers: CriticalBlocker[];
  findings: Finding[];
}

export interface AuditReport {
  ok: true;
  command: 'audit';
  url: string;
  fetchedAt: string;
  /** True when `CRUX_API_KEY` is set. The key value is never included. */
  cruxApiKeyAvailable: boolean;
  scores: AuditScores;
  kindScores: Record<ReportKind, KindScore>;
  blockers: CriticalBlocker[];
  findings: Finding[];
  seo: KindReportBody;
  geo: KindReportBody;
  googleProfile: GoogleProfileSummary;
  discovery: DiscoveryResult;
}

export interface KindReport extends KindReportBody {
  ok: true;
  url: string;
  fetchedAt: string;
  /** True when `CRUX_API_KEY` is set. The key value is never included. */
  cruxApiKeyAvailable: boolean;
  discovery: DiscoveryResult;
}

export const REPORT_KINDS: readonly ReportKind[] = ['overview', 'geo', 'seo'];

/**
 * Drops fetch-only fields so JSON reports do not embed the HTML body.
 */
export function discoveryForReport(bundle: DiscoveryBundle): DiscoveryResult {
  return {
    domain: bundle.domain,
    auditedUrl: bundle.auditedUrl,
    pageKind: bundle.pageKind,
    siteType: bundle.siteType,
    technicalUrls: bundle.technicalUrls,
    crux: bundle.crux,
    llmsTxt: {
      ...bundle.llmsTxt,
      content: null,
      full_content: null,
    },
    llms_txt_status: bundle.llms_txt_status,
    securityHeaders: bundle.securityHeaders,
    crawlerAccess: bundle.crawlerAccess,
    sitemap: bundle.sitemap,
    redirects: bundle.redirects,
    platform_signals: bundle.platform_signals,
    auditedPage: bundle.auditedPage,
    pagesSampled: bundle.pagesSampled,
  };
}

function scoresFromKind(full: AuditScores, kind: KindScore): AuditScores {
  return {
    overall: kind.value ?? 0,
    label: kind.label ?? 'Needs Attention',
    confidence: full.confidence,
    evidence_quality: full.evidence_quality,
    breakdown: kind.breakdown,
  };
}

const KIND_BLOCKERS: Record<KindReportKind, ReadonlySet<CriticalBlocker['id']>> = {
  seo: SEO_BLOCKERS,
  geo: GEO_BLOCKERS,
};

function scoreBundle(bundle: DiscoveryBundle): {
  blockers: CriticalBlocker[];
  scores: AuditScores;
  collected: Finding[];
} {
  const blockers: CriticalBlocker[] = [];
  const scores = computeAuditScores(bundle, blockers);

  return { blockers, scores, collected: collectFindings(bundle, blockers) };
}

function kindReportBody(input: {
  command: KindCommand;
  kind: KindReportKind;
  scores: AuditScores;
  kindScore: KindScore;
  collected: readonly Finding[];
  blockers: readonly CriticalBlocker[];
  extras: readonly Finding[];
}): KindReportBody {
  const { command, kind, scores, kindScore, collected, blockers, extras } = input;

  return {
    command,
    kind,
    scores: scoresFromKind(scores, kindScore),
    blockers: blockers.filter((blocker) => KIND_BLOCKERS[kind].has(blocker.id)),
    findings: [...filterFindingsForKind(kind, collected), ...extras],
  };
}

/**
 * Scores discovery, lists every tool finding, and embeds seo-check / geo-check.
 */
export function buildAuditReport(bundle: DiscoveryBundle): AuditReport {
  const { blockers, scores, collected } = scoreBundle(bundle);
  const kindScores = Object.fromEntries(
    REPORT_KINDS.map((kind) => [kind, scoreForKind(kind, scores)]),
  ) as AuditReport['kindScores'];
  const seoExtras = kindExtras('seo', bundle);
  const geoExtras = kindExtras('geo', bundle);

  return {
    ok: true,
    command: 'audit',
    url: bundle.auditedUrl,
    fetchedAt: new Date().toISOString(),
    cruxApiKeyAvailable: cruxApiKeyAvailable(),
    scores,
    kindScores,
    blockers,
    findings: [...collected, ...seoExtras, ...geoExtras],
    seo: kindReportBody({
      command: 'seo-check',
      kind: 'seo',
      scores,
      kindScore: kindScores.seo,
      collected,
      blockers,
      extras: seoExtras,
    }),
    geo: kindReportBody({
      command: 'geo-check',
      kind: 'geo',
      scores,
      kindScore: kindScores.geo,
      collected,
      blockers,
      extras: geoExtras,
    }),
    googleProfile: googleProfileFromAuditedUrl(bundle.auditedUrl),
    discovery: discoveryForReport(bundle),
  };
}

/**
 * Same discovery as audit, with the kind score as the headline and findings
 * filtered (plus kind-only extras).
 */
export function buildKindReport(
  bundle: DiscoveryBundle,
  command: KindCommand,
  kind: KindReportKind,
): KindReport {
  const { blockers, scores, collected } = scoreBundle(bundle);
  const body = kindReportBody({
    command,
    kind,
    scores,
    kindScore: scoreForKind(kind, scores),
    collected,
    blockers,
    extras: kindExtras(kind, bundle),
  });

  return {
    ok: true,
    url: bundle.auditedUrl,
    fetchedAt: new Date().toISOString(),
    cruxApiKeyAvailable: cruxApiKeyAvailable(),
    ...body,
    discovery: discoveryForReport(bundle),
  };
}
