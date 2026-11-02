import type { Check, CheckStatus } from '../types';
import { scoreToCheckStatus } from '../types';
import type { SecurityHeaderRaw, HstsDirectives } from './parseSecurityHeaders';
import { parseHstsDirectives, parseCspDirectives } from './parseSecurityHeaders';
import {
  HEADER_PENALTIES,
  HEADER_DISPLAY_NAMES,
  HSTS_RECOMMENDED_MAX_AGE,
  CSP_UNSAFE_DIRECTIVES,
  REFERRER_KNOWN_VALUES,
  REFERRER_SAFE_VALUES,
  LETTER_GRADE_THRESHOLDS,
  BONUS_HSTS_PRELOAD,
  BONUS_CSP_NO_UNSAFE,
  BONUS_PERMISSIONS_POLICY_FLOC_OPTOUT,
  type LetterGrade,
  type SecurityHeaderId,
  SCORING_HEADER_IDS,
} from './securityHeadersRules';

/** Module-level set for O(1) scoring-header membership checks. */
const SCORING_HEADER_ID_SET = new Set<string>(SCORING_HEADER_IDS);

const OBSERVATORY_DOCS_URL =
  'https://developer.mozilla.org/en-US/observatory/docs/tests_and_scoring';

/** Score floor of each graded letter below A+, highest first. */
const GRADE_FLOORS: [LetterGrade, number][] = [
  ['A', LETTER_GRADE_THRESHOLDS.A],
  ['B+', LETTER_GRADE_THRESHOLDS.B_PLUS],
  ['B', LETTER_GRADE_THRESHOLDS.B],
  ['C+', LETTER_GRADE_THRESHOLDS.C_PLUS],
  ['C', LETTER_GRADE_THRESHOLDS.C],
  ['D+', LETTER_GRADE_THRESHOLDS.D_PLUS],
  ['D', LETTER_GRADE_THRESHOLDS.D],
];

interface SecurityHeadersCheck extends Omit<Check, 'value' | 'status'> {
  headerName: string;
  value: string | null;
  status: CheckStatus | 'info';
}

export interface SecurityHeadersAnalysis {
  score: number;
  letterGrade: LetterGrade;
  overallStatus: CheckStatus;
  https: boolean;
  redirectNotFollowed: boolean;
  checks: SecurityHeadersCheck[];
  summary: { present: number; total: number };
}

export interface AnalyzeContext {
  https: boolean;
  redirectNotFollowed: boolean;
}

/**
 * Maps a 0-100 score to a letter grade (MDN HTTP Observatory–inspired scale).
 * Local heuristic for this tool only — not a project-wide convention.
 */
export function scoreToLetterGrade(
  score: number,
  ctx: {
    https: boolean;
    allScoringChecksPass: boolean;
    redirectNotFollowed: boolean;
  },
): LetterGrade {
  if (ctx.redirectNotFollowed) {
    return 'R';
  }

  if (!ctx.https) {
    return 'F';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.A_PLUS && ctx.allScoringChecksPass) {
    return 'A+';
  }

  return GRADE_FLOORS.find(([, floor]) => score >= floor)?.[0] ?? 'F';
}

/** Main analyzer entry point. Pure, deterministic, side-effect free. */
export function analyzeSecurityHeaders(
  headers: SecurityHeaderRaw,
  ctx: AnalyzeContext,
): SecurityHeadersAnalysis {
  if (ctx.redirectNotFollowed) {
    return {
      score: 0,
      letterGrade: 'R',
      overallStatus: 'fail',
      https: ctx.https,
      redirectNotFollowed: true,
      checks: [observatoryInfoCheck()],
      // Always SCORING_HEADER_IDS.length (excludes informational x-robots-tag).
      summary: {
        present: 0,
        total: SCORING_HEADER_IDS.length,
      },
    };
  }

  // Parse once — shared by checks and bonuses (avoids duplicate CSP/HSTS work).

  const hstsParsed = parseHstsDirectives(headers.hsts);
  const cspEnforcement = hasHeaderValue(headers.csp) ? headers.csp : null;
  const cspDirectives = parseCspDirectives(cspEnforcement);

  const checks: SecurityHeadersCheck[] = [
    checkHsts(headers.hsts, ctx.https, hstsParsed),
    checkCsp(cspEnforcement, headers.cspReportOnly, cspDirectives),
    checkXFrame(headers.xFrame, cspDirectives.has('frame-ancestors')),
    checkXContentType(headers.xContentType),
    checkReferrerPolicy(headers.referrerPolicy),
    checkPermissionsPolicy(headers.permissionsPolicy),
    checkCrossOriginPolicy('cross-origin-opener-policy', headers.coop, ['same-origin']),
    checkCrossOriginPolicy('cross-origin-embedder-policy', headers.coep, [
      'require-corp',
      'credentialless',
    ]),
    checkCrossOriginPolicy('cross-origin-resource-policy', headers.corp, [
      'same-origin',
      'same-site',
    ]),
    makeCheck('x-robots-tag', 'pass', headers.xRobotsTag),
    observatoryInfoCheck(),
  ];

  const scoringChecks = checks.filter((c) => SCORING_HEADER_ID_SET.has(c.id));
  const penalties = penaltyPoints(scoringChecks);
  const bonuses = bonusPoints(hstsParsed, checks, headers.permissionsPolicy);

  let score = Math.min(100, Math.max(0, 100 - penalties + bonuses));

  if (!ctx.https) {
    score = Math.min(score, 50);
  }

  const allScoringChecksPass = scoringChecks.every((c) => c.status === 'pass');
  const letterGrade = scoreToLetterGrade(score, {
    https: ctx.https,
    allScoringChecksPass,
    redirectNotFollowed: false,
  });
  // `present` = scoring checks with status pass (not raw header presence).
  const present = scoringChecks.filter((c) => c.status === 'pass').length;

  return {
    score,
    letterGrade,
    overallStatus: scoreToCheckStatus(score),
    https: ctx.https,
    redirectNotFollowed: false,
    checks,
    summary: { present, total: SCORING_HEADER_IDS.length },
  };
}

/** Penalty for failed checks (full weight) and warned checks (half weight). */
function penaltyPoints(scoringChecks: readonly SecurityHeadersCheck[]): number {
  let penalties = 0;

  for (const check of scoringChecks) {
    const penalty = HEADER_PENALTIES[check.id as SecurityHeaderId];

    if (check.status === 'fail') {
      penalties += penalty;
    } else if (check.status === 'warn') {
      penalties += 0.5 * penalty;
    }
  }

  return penalties;
}

/** Bonus points for HSTS preload eligibility, a clean CSP, and the FLoC opt-out. */
function bonusPoints(
  hsts: HstsDirectives,
  checks: readonly SecurityHeadersCheck[],
  permissionsPolicy: string | null,
): number {
  let bonuses = 0;

  // Preload bonus only when the site is preload-list eligible (max-age + includeSubDomains).

  if (
    hsts.preload &&
    hsts.includeSubDomains &&
    hsts.maxAge !== null &&
    hsts.maxAge >= HSTS_RECOMMENDED_MAX_AGE
  ) {
    bonuses += BONUS_HSTS_PRELOAD;
  }

  if (checks.find((c) => c.id === 'content-security-policy')?.status === 'pass') {
    bonuses += BONUS_CSP_NO_UNSAFE;
  }

  if (permissionsPolicy && hasInterestCohortOptOut(permissionsPolicy)) {
    bonuses += BONUS_PERMISSIONS_POLICY_FLOC_OPTOUT;
  }

  return bonuses;
}

function observatoryInfoCheck(): SecurityHeadersCheck {
  return {
    id: 'observatory',
    label: 'observatory',
    headerName: 'HTTP Observatory',
    status: 'info',
    value: null,
    detail: `Tests and grades follow MDN HTTP Observatory. ${OBSERVATORY_DOCS_URL}`,
  };
}

function hasHeaderValue(value: string | null): value is string {
  return value !== null && value.trim() !== '';
}

/** Returns true when Permissions-Policy has an exact interest-cohort=() directive token. */
function hasInterestCohortOptOut(value: string): boolean {
  return value.split(',').some((part) => /^interest-cohort\s*=\s*\(\)$/i.test(part.trim()));
}

/**
 * Extracts the first comma-separated token (Fetch joins duplicate headers with ", ").
 * Used for XFO / XCTO single-token policies.
 */
function firstCommaToken(value: string): string {
  return value.split(',')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Extracts the primary policy token from COOP/COEP/CORP values.
 * Fetch may join duplicate headers with ", "; take the first header value,
 * then ignore parameters such as `report-to` after `;`.
 */
function primaryPolicyToken(value: string): string {
  return value.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Last token of a Referrer-Policy value that the W3C spec recognizes. W3C ignores
 * unknown tokens, so an unknown token after a known one does not change the policy.
 */
function lastKnownReferrerToken(value: string): string {
  const tokens = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return tokens.findLast((token) => REFERRER_KNOWN_VALUES.has(token)) ?? '';
}

/** Strips optional single quotes from a CSP source token for unsafe directive matching. */
function normalizeCspSource(source: string): string {
  const trimmed = source.trim();

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/**
 * Resolves CSP sources for unsafe-* scoring.
 * `script-src` inherits `default-src` when omitted (browser behavior).
 * `object-src` does **not** inherit for scoring — omitted object-src with a
 * safe script-src must not warn on default-src `'unsafe-inline'` (styles).
 */
function getEffectiveCspSources(
  directives: Map<string, string[]>,
  name: 'script-src' | 'object-src',
): string[] {
  if (directives.has(name)) {
    return directives.get(name) ?? [];
  }

  if (name === 'script-src') {
    return directives.get('default-src') ?? [];
  }

  return [];
}

/** Collects unsafe tokens from script-src and object-src (script inherits default-src). */
function findCspUnsafeSources(directives: Map<string, string[]>): string[] {
  const unsafeFound: string[] = [];

  for (const name of ['script-src', 'object-src'] as const) {
    for (const source of getEffectiveCspSources(directives, name)) {
      const normalized = normalizeCspSource(source);
      const isUnsafe = CSP_UNSAFE_DIRECTIVES.includes(
        normalized as (typeof CSP_UNSAFE_DIRECTIVES)[number],
      );

      if (isUnsafe) {
        unsafeFound.push(normalized);
      }
    }
  }

  return unsafeFound;
}

/** Check row for one header. Detail is the raw value, or `missing` when there is none. */
function makeCheck(
  id: SecurityHeaderId,
  status: CheckStatus,
  value: string | null,
): SecurityHeadersCheck {
  return {
    id,
    label: id,
    headerName: HEADER_DISPLAY_NAMES[id],
    status,
    value,
    detail: value ? String(value) : 'missing',
  };
}

function checkHsts(
  value: string | null,
  https: boolean,
  parsed: HstsDirectives,
): SecurityHeadersCheck {
  const id = 'strict-transport-security' as const;

  if (!https) {
    return makeCheck(id, 'fail', value);
  }

  if (!hasHeaderValue(value)) {
    return makeCheck(id, 'fail', null);
  }

  return makeCheck(id, hstsStatus(parsed), value);
}

function hstsStatus(parsed: HstsDirectives): CheckStatus {
  if (parsed.maxAge === null || parsed.maxAge === 0) {
    return 'fail';
  }

  if (parsed.maxAge < HSTS_RECOMMENDED_MAX_AGE || !parsed.includeSubDomains) {
    return 'warn';
  }

  return 'pass';
}

function checkCsp(
  enforcement: string | null,
  reportOnly: string | null,
  directives: Map<string, string[]>,
): SecurityHeadersCheck {
  const id = 'content-security-policy' as const;

  if (enforcement === null) {
    return hasHeaderValue(reportOnly)
      ? makeCheck(id, 'warn', reportOnly)
      : makeCheck(id, 'fail', null);
  }

  return makeCheck(id, cspEnforcementStatus(directives), enforcement);
}

function cspEnforcementStatus(directives: Map<string, string[]>): CheckStatus {
  if (!directives.has('default-src') && !directives.has('script-src')) {
    return 'warn';
  }

  return findCspUnsafeSources(directives).length > 0 ? 'warn' : 'pass';
}

function checkXFrame(value: string | null, cspFrameAncestors: boolean): SecurityHeadersCheck {
  const id = 'x-frame-options' as const;

  if (cspFrameAncestors) {
    return makeCheck(id, 'pass', value);
  }

  if (!hasHeaderValue(value)) {
    return makeCheck(id, 'fail', null);
  }

  // Fetch joins duplicate XFO headers with ", "; use the first token.

  const lc = firstCommaToken(value);

  return makeCheck(id, lc === 'deny' || lc === 'sameorigin' ? 'pass' : 'warn', value);
}

function checkXContentType(value: string | null): SecurityHeadersCheck {
  const id = 'x-content-type-options' as const;

  if (!hasHeaderValue(value)) {
    return makeCheck(id, 'fail', null);
  }

  // Fetch joins duplicate XCTO headers with ", "; use the first token.

  return makeCheck(id, firstCommaToken(value) === 'nosniff' ? 'pass' : 'warn', value);
}

function checkReferrerPolicy(value: string | null): SecurityHeadersCheck {
  const id = 'referrer-policy' as const;

  if (!hasHeaderValue(value)) {
    return makeCheck(id, 'fail', null);
  }

  // Only the safe tier passes. Legacy, unsafe, unknown, and `origin` values warn.

  const status: CheckStatus = REFERRER_SAFE_VALUES.has(lastKnownReferrerToken(value))
    ? 'pass'
    : 'warn';

  return makeCheck(id, status, value);
}

function checkPermissionsPolicy(value: string | null): SecurityHeadersCheck {
  const id = 'permissions-policy' as const;

  if (!hasHeaderValue(value)) {
    return makeCheck(id, 'warn', null);
  }

  return makeCheck(id, 'pass', value);
}

/** Shared COOP / COEP / CORP check: primary token before `;`, allowlist pass. */
function checkCrossOriginPolicy(
  id: Extract<
    SecurityHeaderId,
    'cross-origin-opener-policy' | 'cross-origin-embedder-policy' | 'cross-origin-resource-policy'
  >,
  value: string | null,
  allowed: readonly string[],
): SecurityHeadersCheck {
  if (!hasHeaderValue(value)) {
    return makeCheck(id, 'warn', null);
  }

  const status: CheckStatus = allowed.includes(primaryPolicyToken(value)) ? 'pass' : 'warn';

  return makeCheck(id, status, value);
}
