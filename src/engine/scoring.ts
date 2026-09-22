/**
 * GEO component scoring for local audits. Keep scores here; do not add them
 * in commands or render.
 */
import { DEFAULT_MAX_BODY_BYTES } from '../lib/maxBodyBytes.ts';
import type { CrawlerAccessStatus } from './robotsTxtParser.ts';
import { expectedSchemaTypes } from './pageClassification.ts';
import { isNoindexCombined, isPageIndexable } from './robotsDirective.ts';
import {
  CITABILITY_IDEAL_MAX_WORDS,
  CITABILITY_IDEAL_MIN_WORDS,
  citabilityWordCount,
  type CitabilityBlockScore,
  type CitabilityDimensions,
  type CitabilitySummary,
} from './citabilityBlocks.ts';
import { STATISTIC_SNIPPET_RE } from './parsers/contentSignals.ts';
import type {
  CruxUrlResult,
  DiscoveryResult,
  EvidenceType,
  ReportKind,
  ScoreBreakdownItem,
  ScoreComponentId,
  ScoreConfidence,
  ScoreLabel,
} from './types.ts';

const COMPONENT_WEIGHT: Record<ScoreComponentId, number> = {
  ai_citability_visibility: 0.3125,
  content_quality: 0.25,
  technical_foundations: 0.1875,
  structured_data: 0.125,
  platform_optimization: 0.125,
};

const COMPONENT_LABEL: Record<ScoreComponentId, string> = {
  ai_citability_visibility: 'AI citability',
  content_quality: 'Content quality (E-E-A-T)',
  technical_foundations: 'Technical foundations',
  structured_data: 'Structured data',
  platform_optimization: 'Platform optimization',
};

const KIND_COMPONENTS: Record<ReportKind, ScoreComponentId[]> = {
  geo: ['ai_citability_visibility', 'platform_optimization'],
  seo: ['content_quality', 'technical_foundations', 'structured_data'],
  overview: [
    'ai_citability_visibility',
    'content_quality',
    'technical_foundations',
    'structured_data',
    'platform_optimization',
  ],
};

const CRAWLER_WEIGHT: Record<string, number> = {
  Googlebot: 1.2,
  Bingbot: 1.2,
  'OAI-SearchBot': 2,
  'ChatGPT-User': 2,
  ClaudeBot: 2,
  PerplexityBot: 2,
  GPTBot: 0.8,
  'Google-Extended': 0.8,
  'anthropic-ai': 0.8,
  CCBot: 0.7,
  Bytespider: 0.7,
  'Applebot-Extended': 0.8,
  Amazonbot: 0.8,
  'cohere-ai': 0.7,
};

const LIVE_RETRIEVAL_BOTS = new Set([
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'PerplexityBot',
  'Googlebot',
  'Bingbot',
]);

export interface AuditScores {
  overall: number;
  label: ScoreLabel;
  confidence: ScoreConfidence;
  evidence_quality: EvidenceType;
  breakdown: ScoreBreakdownItem[];
}

export interface KindScore {
  value: number | null;
  label: ScoreLabel | null;
  breakdown: ScoreBreakdownItem[];
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

function applyEvidenceCeiling(score: number, evidence: EvidenceType): number {
  if (evidence === 'inferred') {
    return Math.min(score, 85);
  }

  if (evidence === 'indirect') {
    return Math.min(score, 92);
  }

  return score;
}

export function scoreLabel(score: number | null): ScoreLabel | null {
  if (score === null) {
    return null;
  }

  if (score >= 85) {
    return 'Excellent';
  }

  if (score >= 70) {
    return 'Good';
  }

  if (score >= 55) {
    return 'Moderate';
  }

  if (score >= 40) {
    return 'Below Average';
  }

  return 'Needs Attention';
}

interface WeightedScorePart {
  value: number | null;
  weight: number;
}

function weightedAverage(parts: WeightedScorePart[]): number | null {
  const available = parts.filter((p) => p.value !== null);
  const weightSum = available.reduce((sum, p) => sum + p.weight, 0);

  if (weightSum === 0) {
    return null;
  }

  const total = available.reduce((sum, p) => sum + (p.value as number) * p.weight, 0);

  return total / weightSum;
}

function isHttps(url: string): boolean {
  return url.startsWith('https://');
}

function crawlerBotScore(status: CrawlerAccessStatus): number {
  if (status === 'allowed') {
    return 100;
  }

  if (status === 'restricted') {
    return 45;
  }

  return 0;
}

function scoreCrawlerAccess(discovery: DiscoveryResult): number {
  const entries = discovery.crawlerAccess.crawlers;

  if (entries.length === 0) {
    return 50;
  }

  let totalWeight = 0;
  let earned = 0;

  for (const { bot, status } of entries) {
    const w = CRAWLER_WEIGHT[bot] ?? 1;

    totalWeight += w;
    earned += (crawlerBotScore(status) / 100) * w;
  }

  return totalWeight === 0 ? 50 : clamp((earned / totalWeight) * 100);
}

function liveRetrievalFullyBlocked(discovery: DiscoveryResult): boolean {
  const live = discovery.crawlerAccess.crawlers.filter((c) => LIVE_RETRIEVAL_BOTS.has(c.bot));

  return live.length > 0 && live.every((c) => c.status === 'blocked');
}

interface CwvReading {
  score: number | null;
  evidence: EvidenceType;
  poor: boolean;
}

const CORE_VITALS = [
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift',
] as const;

const RATING_SCORE: Record<string, number> = {
  good: 100,
  needs_improvement: 60,
  poor: 20,
};

function readCoreWebVitals(discovery: DiscoveryResult): CwvReading {
  const results = (discovery.crux.results ?? []) as CruxUrlResult[];
  const match = results.find((r) => r.url === discovery.auditedPage.url) ?? results[0] ?? null;

  if (!match) {
    return { score: null, evidence: 'insufficient', poor: false };
  }

  const urlHasVital = CORE_VITALS.some((name) => {
    const rating = match.url_data?.metrics[name]?.rating;

    return Boolean(rating) && rating !== 'unknown';
  });
  const record = urlHasVital ? match.url_data : match.origin_data;

  if (!record) {
    return { score: null, evidence: 'insufficient', poor: false };
  }

  const evidence: EvidenceType = urlHasVital ? 'direct' : 'indirect';
  const vitalRating = (name: (typeof CORE_VITALS)[number]): string | undefined =>
    record.metrics[name]?.rating;
  const ratings = CORE_VITALS.map((name) => vitalRating(name)).filter(
    (r): r is string => Boolean(r) && r !== 'unknown',
  );

  if (ratings.length === 0) {
    return { score: null, evidence: 'insufficient', poor: false };
  }

  const poor = CORE_VITALS.some((name) => vitalRating(name) === 'poor');
  const avg = ratings.reduce((sum, r) => sum + (RATING_SCORE[r] ?? 50), 0) / ratings.length;

  return { score: avg, evidence, poor };
}

interface ComponentResult {
  score: number | null;
  evidence: EvidenceType;
}

/**
 * Deterministic critical blocker. Each id maps 1:1 to a cap enforced by the
 * component scorers below.
 */
type CriticalBlockerId =
  | 'noindex_or_error'
  | 'no_https'
  | 'poor_core_web_vitals'
  | 'csr_only_rendering'
  | 'oversized_html'
  | 'thin_content'
  | 'no_structured_data'
  | 'live_retrieval_blocked';

/** A critical blocker detected in the current audit, with its score cap. */
export interface CriticalBlocker {
  id: CriticalBlockerId;
  component: ScoreComponentId;
  cap: number;
}

function indexabilityScore(
  page: DiscoveryResult['auditedPage'],
  indexable: boolean,
  noindex: boolean,
): number {
  let indexability = 50;

  if (indexable && page.canonicalUrl) {
    indexability = 100;
  } else if (indexable) {
    indexability = 80;
  } else if (noindex) {
    indexability = 0;
  }

  if (page.hreflang.length > 0) {
    indexability = Math.min(100, indexability + 10);
  }

  return indexability;
}

function applyTechnicalCaps(
  score: number,
  discovery: DiscoveryResult,
  noindex: boolean,
  https: boolean,
  poorCwv: boolean,
  collect?: CriticalBlocker[],
): number {
  const p = discovery.auditedPage;
  let next = score;

  if (p.statusCode < 200 || p.statusCode >= 300 || noindex) {
    next = Math.min(next, 20);
    collect?.push({ id: 'noindex_or_error', component: 'technical_foundations', cap: 20 });
  }

  if (!https) {
    next = Math.min(next, 40);
    collect?.push({ id: 'no_https', component: 'technical_foundations', cap: 40 });
  }

  if (poorCwv) {
    next = Math.min(next, 50);
    collect?.push({ id: 'poor_core_web_vitals', component: 'technical_foundations', cap: 50 });
  }

  if (p.jsRenderingRisk.isLikelyCsr) {
    next = Math.min(next, 40);
    collect?.push({ id: 'csr_only_rendering', component: 'technical_foundations', cap: 40 });
  }

  // Googlebot indexes the first 2 MiB of uncompressed HTML.
  // https://www.debugbear.com/blog/googlebot-crawler-file-size-limit

  if (p.byteLength > DEFAULT_MAX_BODY_BYTES) {
    next = Math.min(next, 60);
    collect?.push({ id: 'oversized_html', component: 'technical_foundations', cap: 60 });
  }

  return next;
}

function scoreTechnical(discovery: DiscoveryResult, collect?: CriticalBlocker[]): ComponentResult {
  const p = discovery.auditedPage;
  const sh = discovery.securityHeaders;
  const noindex = isNoindexCombined(p.robotsDirective, sh.x_robots_tag, p.metaRobotsByBot);
  const ok2xx = p.statusCode >= 200 && p.statusCode < 300;
  const indexable = isPageIndexable(
    p.statusCode,
    p.robotsDirective,
    sh.x_robots_tag,
    p.metaRobotsByBot,
  );
  const https = isHttps(p.url);
  const cwv = readCoreWebVitals(discovery);

  const crawlability =
    (ok2xx ? 40 : 0) +
    (p.robotsStatus === 'present' ? 30 : 0) +
    (p.sitemapStatus === 'present' ? 30 : 0);

  const headerCount = [sh.hsts, sh.csp, sh.x_frame, sh.x_content_type, sh.referrer_policy].filter(
    Boolean,
  ).length;
  const security = (https ? 60 : 0) + headerCount * 8;
  const mobile = p.viewport ? 100 : 20;

  let score = weightedAverage([
    { value: crawlability, weight: 0.25 },
    { value: cwv.score, weight: 0.25 },
    { value: indexabilityScore(p, indexable, noindex), weight: 0.2 },
    { value: Math.min(100, security), weight: 0.15 },
    { value: mobile, weight: 0.15 },
  ]);

  if (score === null) {
    return { score: null, evidence: 'insufficient' };
  }

  score = applyTechnicalCaps(score, discovery, noindex, https, cwv.poor, collect);
  const evidence: EvidenceType = cwv.score === null ? 'insufficient' : cwv.evidence;

  return { score, evidence };
}

function freshnessScore(modified: string | null): number {
  if (!modified) {
    return 35;
  }

  const ts = Date.parse(modified);

  if (Number.isNaN(ts)) {
    return 40;
  }

  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);

  if (days < 0) {
    return 35;
  }

  if (days <= 90) {
    return 100;
  }

  if (days <= 180) {
    return 80;
  }

  if (days <= 365) {
    return 60;
  }

  return 35;
}

function contentDepth(wordCount: number): number {
  if (wordCount >= 800) {
    return 100;
  }

  if (wordCount >= 300) {
    return 70;
  }

  if (wordCount >= 120) {
    return 40;
  }

  return 15;
}

function editorialScore(page: DiscoveryResult['auditedPage']): number {
  const cs = page.contentSignals;
  let h1Score = 0;
  const { h1Count, h1ElementCount } = page.headings;

  if (h1Count === 1) {
    h1Score = 25;
  } else if (h1Count > 1) {
    h1Score = 10;
  } else if (h1ElementCount > 0 && h1Count === 0) {
    h1Score = 10;
  }

  let h2Score = 0;

  if (page.headings.h2Count >= 2) {
    h2Score = 25;
  } else if (page.headings.h2Count > 0) {
    h2Score = 15;
  }

  return (
    h1Score +
    h2Score +
    (cs.lists > 0 ? 20 : 0) +
    (cs.tables > 0 ? 15 : 0) +
    (cs.paragraphs >= 4 ? 15 : 0)
  );
}

function scoreContentQuality(
  discovery: DiscoveryResult,
  collect?: CriticalBlocker[],
): ComponentResult {
  const p = discovery.auditedPage;

  const eeat =
    (p.author.hasAuthor ? 30 : 0) +
    (p.dates.published ? 15 : 0) +
    (p.dates.modified ? 20 : 0) +
    (isHttps(p.url) ? 20 : 0) +
    (p.title && p.metaDescription ? 15 : 0);

  const depth = contentDepth(p.wordCount);
  const freshness = freshnessScore(p.dates.modified);
  const editorial = editorialScore(p);

  const imageAltScore =
    p.images.total === 0 ? 50 : clamp((p.images.withAlt / p.images.total) * 100);

  let score = weightedAverage([
    { value: Math.min(100, eeat), weight: 0.35 },
    { value: depth, weight: 0.25 },
    { value: freshness, weight: 0.2 },
    { value: Math.min(100, editorial), weight: 0.1 },
    { value: imageAltScore, weight: 0.1 },
  ]);

  if (score === null) {
    score = 0;
  }

  if (p.wordCount < 120) {
    score = Math.min(score, 35);
    collect?.push({ id: 'thin_content', component: 'content_quality', cap: 35 });
  }

  return { score: clamp(score), evidence: 'direct' };
}

function scoreStructuredData(
  discovery: DiscoveryResult,
  collect?: CriticalBlocker[],
): ComponentResult {
  const p = discovery.auditedPage;
  const sd = p.structuredData;

  // No structured data is a critical blocker that caps this component at 25

  // (minimum readiness), not 15.

  if (sd.blocks.length === 0) {
    collect?.push({ id: 'no_structured_data', component: 'structured_data', cap: 25 });

    return { score: 25, evidence: 'direct' };
  }

  const types = new Set(sd.types.map((t) => t.toLowerCase()));
  const typeList = Array.from(types);
  const expected = expectedSchemaTypes(discovery.siteType, discovery.pageKind);
  const matched = expected.filter((name) => typeList.some((t) => t.includes(name.toLowerCase())));
  const coverage = expected.length === 0 ? 50 : clamp((matched.length / expected.length) * 100);

  const validBlocks = sd.blocks.filter((b) => b.hasRequiredProps).length;
  const validation = clamp((validBlocks / sd.blocks.length) * 100 - sd.parse_errors * 15);

  let entityGraph = 35;

  if (sd.hasGraph) {
    entityGraph = 90;
  } else if (sd.blocks.some((b) => b.sameAs.length > 0)) {
    entityGraph = 70;
  }

  // Sub-component: GEO-relevant signals inside structured data (speakable, sameAs, org).

  let geoReadinessFromStructuredData = 25;

  if (p.hasSpeakable) {
    geoReadinessFromStructuredData = 100;
  } else if (
    sd.blocks.some((b) => b.sameAs.length > 0) &&
    sd.blocks.some((b) => b.type?.toLowerCase().includes('organization'))
  ) {
    geoReadinessFromStructuredData = 95;
  } else if (sd.blocks.some((b) => b.sameAs.length > 0) || p.author.hasAuthor) {
    geoReadinessFromStructuredData = 65;
  }

  let score = weightedAverage([
    { value: coverage, weight: 0.3 },
    { value: validation, weight: 0.3 },
    { value: entityGraph, weight: 0.25 },
    { value: geoReadinessFromStructuredData, weight: 0.15 },
  ]);

  if (score === null) {
    score = 25;
  }

  return { score: clamp(score), evidence: 'direct' };
}

const CITABILITY_WEIGHTS = {
  answer_block: 0.25,
  self_containment: 0.2,
  structure: 0.2,
  statistical_density: 0.2,
  uniqueness: 0.15,
} as const;

function hasCitabilityDefinition(text: string): boolean {
  return /^(what is|o que é|refers to|é um|é uma|means |significa )/i.test(text.trim());
}

function hasCitabilityStats(text: string): boolean {
  return STATISTIC_SNIPPET_RE.test(text);
}

function countCitabilitySignals(text: string): number {
  return text.match(/\d+([.,]\d+)?%|\$\d+|\b\d{4}\b/g)?.length ?? 0;
}

function hasCitabilityList(text: string): boolean {
  return /(^|\n)\s*[-*•]\s+|(^|\n)\s*\d+[.)]\s+/.test(text);
}

function hasCitabilityTable(text: string): boolean {
  return /\|.+\|/.test(text) || text.includes('\t');
}

function scoreCitabilityAnswer(text: string, words: number): number {
  let score = 20;

  if (hasCitabilityDefinition(text)) {
    score += 35;
  }

  if (words >= 30 && words <= 220) {
    score += 25;
  }

  if (/^[^.!?]+[.!?]/.test(text.trim())) {
    score += 10;
  }

  if (/\?/.test(text.slice(0, 80))) {
    score += 10;
  }

  return Math.min(100, score);
}

function scoreCitabilitySelf(text: string, words: number): number {
  let score = 15;

  if (words >= 40) {
    score += 25;
  }

  if (!/\b(it|this|they|ele|ela|isso|aquilo)\b/i.test(text.slice(0, 50))) {
    score += 25;
  }

  if (/\b(is|are|é|são|means|refers)\b/i.test(text)) {
    score += 15;
  }

  if (text.split(/[.!?]/).filter((s) => s.trim().length > 10).length >= 2) {
    score += 20;
  }

  return Math.min(100, score);
}

function scoreCitabilityStructure(text: string, words: number): number {
  let score = 20;

  if (hasCitabilityList(text)) {
    score += 25;
  }

  if (hasCitabilityTable(text)) {
    score += 15;
  }

  if (words >= CITABILITY_IDEAL_MIN_WORDS && words <= CITABILITY_IDEAL_MAX_WORDS) {
    score += 25;
  } else if (words >= 80 && words <= 220) {
    score += 15;
  }

  if (/\*\*[^*]+\*\*|__[^_]+__/.test(text)) {
    score += 10;
  }

  if (text.split(/[.!?]/).filter((s) => s.trim().length > 8).length >= 3) {
    score += 10;
  }

  return Math.min(100, score);
}

function scoreCitabilityStats(text: string): number {
  const count = countCitabilitySignals(text);

  if (count === 0) {
    return 15;
  }

  if (count === 1) {
    return 45;
  }

  if (count === 2) {
    return 65;
  }

  return Math.min(100, 70 + count * 8);
}

function scoreCitabilityUniqueness(text: string): number {
  let score = 25;

  if (/\b(we|our|nós|nossa|estudo|research|proprietary|exclusive)\b/i.test(text)) {
    score += 25;
  }

  if (/\b(case study|estudo de caso|according to our|segundo nossa)\b/i.test(text)) {
    score += 20;
  }

  if (hasCitabilityStats(text) && text.length > 120) {
    score += 15;
  }

  if (!/\b(click here|saiba mais|read more|lorem ipsum)\b/i.test(text)) {
    score += 10;
  }

  return Math.min(100, score);
}

/** Five-dimension citability scores (GEO). Parser only supplies candidate texts. */
export function scoreCitabilityTexts(texts: string[]): CitabilitySummary {
  const blocks: CitabilityBlockScore[] = texts.map((text) => {
    const words = citabilityWordCount(text);
    const dimensions: CitabilityDimensions = {
      answer_block: scoreCitabilityAnswer(text, words),
      self_containment: scoreCitabilitySelf(text, words),
      structure: scoreCitabilityStructure(text, words),
      statistical_density: scoreCitabilityStats(text),
      uniqueness: scoreCitabilityUniqueness(text),
    };
    const score = Math.round(
      dimensions.answer_block * CITABILITY_WEIGHTS.answer_block +
        dimensions.self_containment * CITABILITY_WEIGHTS.self_containment +
        dimensions.structure * CITABILITY_WEIGHTS.structure +
        dimensions.statistical_density * CITABILITY_WEIGHTS.statistical_density +
        dimensions.uniqueness * CITABILITY_WEIGHTS.uniqueness,
    );

    return {
      text_preview: text.slice(0, 120),
      word_count: words,
      score,
      dimensions,
      in_ideal_word_range:
        words >= CITABILITY_IDEAL_MIN_WORDS && words <= CITABILITY_IDEAL_MAX_WORDS,
      citation_ready: score >= 70,
    };
  });
  const scored = blocks.filter((b) => b.word_count >= 25);
  const top = scored.toSorted((a, b) => b.score - a.score).slice(0, 5);
  const page_score =
    top.length === 0 ? 20 : Math.round(top.reduce((s, b) => s + b.score, 0) / top.length);

  return {
    blocks: scored.slice(0, 12),
    page_score,
    citation_ready_blocks: scored.filter((b) => b.citation_ready).length,
    ideal_range_blocks: scored.filter((b) => b.in_ideal_word_range).length,
  };
}

function scorePageCitability(discovery: DiscoveryResult): number {
  const p = discovery.auditedPage;
  let score = p.citability.page_score;

  if (p.discover.hasRepresentativeImage) {
    score = Math.min(100, score + 5);
  }

  if (p.discover.maxImagePreviewLarge) {
    score = Math.min(100, score + 5);
  }

  return clamp(score);
}

function scoreAiCitability(
  discovery: DiscoveryResult,
  collect?: CriticalBlocker[],
): ComponentResult {
  const pageScore = scorePageCitability(discovery);
  const crawlerScore = scoreCrawlerAccess(discovery);

  let score = weightedAverage([
    { value: pageScore, weight: 0.7 },
    { value: crawlerScore, weight: 0.3 },
  ]);

  if (score === null) {
    score = 40;
  }

  if (liveRetrievalFullyBlocked(discovery)) {
    score = Math.min(score, 30);
    collect?.push({
      id: 'live_retrieval_blocked',
      component: 'ai_citability_visibility',
      cap: 30,
    });
  }

  return { score: clamp(score), evidence: 'direct' };
}

export function computeAuditScores(
  discovery: DiscoveryResult,
  collect?: CriticalBlocker[],
): AuditScores {
  const blockers = collect ?? [];
  const technical = scoreTechnical(discovery, blockers);
  const content = scoreContentQuality(discovery, blockers);
  const citability = scoreAiCitability(discovery, blockers);
  const structured = scoreStructuredData(discovery, blockers);

  const platformParts: WeightedScorePart[] = [
    { value: technical.score, weight: 1 },
    { value: content.score, weight: 1 },
    { value: citability.score, weight: 1 },
  ];
  const platformScore = weightedAverage(platformParts);

  const raw: Record<ScoreComponentId, ComponentResult> = {
    ai_citability_visibility: citability,
    content_quality: content,
    technical_foundations: technical,
    structured_data: structured,
    platform_optimization: {
      score: platformScore === null ? null : clamp(platformScore),
      evidence: platformScore === null ? 'insufficient' : 'inferred',
    },
  };
  const breakdown: ScoreBreakdownItem[] = (Object.keys(COMPONENT_WEIGHT) as ScoreComponentId[]).map(
    (component) => {
      const weight = COMPONENT_WEIGHT[component];
      const evidence = raw[component].evidence;
      const rawScore = raw[component].score;
      const score = rawScore === null ? null : applyEvidenceCeiling(clamp(rawScore), evidence);

      return {
        component,
        display_name: COMPONENT_LABEL[component],
        score,
        weight,
        weighted: score === null ? null : Math.round(score * weight),
        evidence_type: evidence,
      };
    },
  );

  const overallRaw = weightedAverage(breakdown.map((b) => ({ value: b.score, weight: b.weight })));
  const overall = overallRaw === null ? 0 : clamp(overallRaw);

  const evidences = breakdown.filter((b) => b.score !== null).map((b) => b.evidence_type);
  const hasDirect = evidences.some((e) => e === 'direct' || e === 'mixed');
  const evidence_quality: EvidenceType = hasDirect ? 'mixed' : 'inferred';

  const availableCount = breakdown.filter((b) => b.score !== null).length;
  const cruxPresent = (discovery.crux.results ?? []).length > 0;
  // Search Console is not collected, so confidence never reaches high.
  // One missing component still counts as medium when CrUX is present.
  const confidence: ScoreConfidence =
    availableCount >= breakdown.length - 1 && cruxPresent ? 'medium' : 'low';

  return {
    overall,
    label: scoreLabel(overall) ?? 'Needs Attention',
    confidence,
    evidence_quality,
    breakdown,
  };
}

export function scoreForKind(kind: ReportKind, scores: AuditScores): KindScore {
  const ids = new Set(KIND_COMPONENTS[kind]);
  const breakdown = scores.breakdown.filter((b) => ids.has(b.component));
  const value = weightedAverage(breakdown.map((b) => ({ value: b.score, weight: b.weight })));
  const rounded = value === null ? null : clamp(value);

  return { value: rounded, label: scoreLabel(rounded), breakdown };
}
