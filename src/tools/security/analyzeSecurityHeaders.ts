import type { Check, CheckStatus } from '../types';
import { scoreToCheckStatus } from '../types';
import type { SecurityHeaderRaw, HstsDirectives } from './parseSecurityHeaders';
import { parseHstsDirectives, parseCspDirectives } from './parseSecurityHeaders';
import {
  HEADER_PENALTIES,
  HEADER_DISPLAY_NAMES,
  HSTS_RECOMMENDED_MAX_AGE,
  CSP_UNSAFE_DIRECTIVES,
  REFERRER_SAFE_VALUES,
  REFERRER_WARN_VALUES,
  REFERRER_UNSAFE_VALUES,
  REFERRER_KNOWN_VALUES,
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

  if (score >= LETTER_GRADE_THRESHOLDS.A) {
    return 'A';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.B_PLUS) {
    return 'B+';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.B) {
    return 'B';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.C_PLUS) {
    return 'C+';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.C) {
    return 'C';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.D_PLUS) {
    return 'D+';
  }

  if (score >= LETTER_GRADE_THRESHOLDS.D) {
    return 'D';
  }

  return 'F';
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
  const cspFrameAncestors = cspDirectives.has('frame-ancestors');

  const checks: SecurityHeadersCheck[] = [
    checkHsts(headers.hsts, ctx.https, hstsParsed),
    checkCsp(cspEnforcement, headers.cspReportOnly, cspDirectives),
    checkXFrame(headers.xFrame, cspFrameAncestors),
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
    checkXRobotsTag(headers.xRobotsTag),
    observatoryInfoCheck(),
  ];

  const scoringChecks = checks.filter((c) => SCORING_HEADER_ID_SET.has(c.id));
  let penalties = 0;

  for (const check of scoringChecks) {
    const penalty = HEADER_PENALTIES[check.id as SecurityHeaderId];

    if (check.status === 'fail') {
      penalties += penalty;
    } else if (check.status === 'warn') {
      penalties += 0.5 * penalty;
    }
  }

  let bonuses = 0;

  // Preload bonus only when the site is preload-list eligible (max-age + includeSubDomains).

  if (
    hstsParsed.preload &&
    hstsParsed.includeSubDomains &&
    hstsParsed.maxAge !== null &&
    hstsParsed.maxAge >= HSTS_RECOMMENDED_MAX_AGE
  ) {
    bonuses += BONUS_HSTS_PRELOAD;
  }

  const cspCheck = checks.find((c) => c.id === 'content-security-policy');

  if (cspCheck?.status === 'pass') {
    bonuses += BONUS_CSP_NO_UNSAFE;
  }

  if (headers.permissionsPolicy && hasInterestCohortOptOut(headers.permissionsPolicy)) {
    bonuses += BONUS_PERMISSIONS_POLICY_FLOC_OPTOUT;
  }

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

type MakeCheckPartial = Omit<SecurityHeadersCheck, 'id' | 'label' | 'headerName' | 'detail'> &
  Partial<Pick<SecurityHeadersCheck, 'detail'>>;

function makeCheck(id: SecurityHeaderId, partial: MakeCheckPartial): SecurityHeadersCheck {
  return {
    id,
    label: id,
    headerName: HEADER_DISPLAY_NAMES[id],
    ...partial,
    detail: partial.detail || (partial.value ? String(partial.value) : 'missing'),
  };
}

function checkHsts(
  value: string | null,
  https: boolean,
  parsed: HstsDirectives,
): SecurityHeadersCheck {
  const id = 'strict-transport-security' as const;

  if (!https) {
    return makeCheck(id, {
      status: 'fail',
      value,
    });
  }

  if (!hasHeaderValue(value)) {
    return makeCheck(id, {
      status: 'fail',
      value: null,
    });
  }

  if (parsed.maxAge === null) {
    return makeCheck(id, {
      status: 'fail',
      value,
    });
  }

  if (parsed.maxAge === 0) {
    return makeCheck(id, {
      status: 'fail',
      value,
    });
  }

  if (parsed.maxAge < HSTS_RECOMMENDED_MAX_AGE) {
    return makeCheck(id, {
      status: 'warn',
      value,
    });
  }

  if (!parsed.includeSubDomains) {
    return makeCheck(id, {
      status: 'warn',
      value,
    });
  }

  return makeCheck(id, {
    status: 'pass',
    value,
  });
}

function checkCsp(
  enforcement: string | null,
  reportOnly: string | null,
  directives: Map<string, string[]>,
): SecurityHeadersCheck {
  const id = 'content-security-policy' as const;
  const ro = hasHeaderValue(reportOnly) ? reportOnly : null;

  if (enforcement === null && ro === null) {
    return makeCheck(id, {
      status: 'fail',
      value: null,
    });
  }

  if (enforcement === null && ro !== null) {
    return makeCheck(id, {
      status: 'warn',
      value: ro,
    });
  }

  const hasDefaultSrc = directives.has('default-src');
  const hasScriptSrc = directives.has('script-src');

  if (!hasDefaultSrc && !hasScriptSrc) {
    return makeCheck(id, {
      status: 'warn',
      value: enforcement,
    });
  }

  const unsafeFound = findCspUnsafeSources(directives);

  if (unsafeFound.length > 0) {
    return makeCheck(id, {
      status: 'warn',
      value: enforcement,
    });
  }

  return makeCheck(id, {
    status: 'pass',
    value: enforcement,
  });
}

function checkXFrame(value: string | null, cspFrameAncestors: boolean): SecurityHeadersCheck {
  const id = 'x-frame-options' as const;

  if (cspFrameAncestors) {
    return makeCheck(id, {
      status: 'pass',
      value,
    });
  }

  if (!hasHeaderValue(value)) {
    return makeCheck(id, {
      status: 'fail',
      value: null,
    });
  }

  // Fetch joins duplicate XFO headers with ", "; use the first token.

  const lc = firstCommaToken(value);

  if (lc === 'deny' || lc === 'sameorigin') {
    return makeCheck(id, {
      status: 'pass',
      value,
    });
  }

  return makeCheck(id, {
    status: 'warn',
    value,
  });
}

function checkXContentType(value: string | null): SecurityHeadersCheck {
  const id = 'x-content-type-options' as const;

  if (!hasHeaderValue(value)) {
    return makeCheck(id, {
      status: 'fail',
      value: null,
    });
  }

  // Fetch joins duplicate XCTO headers with ", "; use the first token.

  if (firstCommaToken(value) === 'nosniff') {
    return makeCheck(id, {
      status: 'pass',
      value,
    });
  }

  return makeCheck(id, {
    status: 'warn',
    value,
  });
}

function checkReferrerPolicy(value: string | null): SecurityHeadersCheck {
  const id = 'referrer-policy' as const;

  if (!hasHeaderValue(value)) {
    return makeCheck(id, {
      status: 'fail',
      value: null,
    });
  }

  // W3C: ignore unknown tokens; apply the last recognized referrer policy.

  const tokens = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  let lc = '';

  for (const token of tokens) {
    if (REFERRER_KNOWN_VALUES.has(token)) {
      lc = token;
    }
  }

  if (!lc) {
    return makeCheck(id, {
      status: 'warn',
      value,
    });
  }

  if (REFERRER_UNSAFE_VALUES.has(lc)) {
    return makeCheck(id, {
      status: 'warn',
      value,
    });
  }

  if (REFERRER_WARN_VALUES.has(lc)) {
    return makeCheck(id, {
      status: 'warn',
      value,
    });
  }

  if (REFERRER_SAFE_VALUES.has(lc)) {
    return makeCheck(id, {
      status: 'pass',
      value,
    });
  }

  // Known but not in safe/legacy/unsafe sets (e.g. `origin`) → warn.

  return makeCheck(id, {
    status: 'warn',
    value,
  });
}

function checkPermissionsPolicy(value: string | null): SecurityHeadersCheck {
  const id = 'permissions-policy' as const;

  if (!hasHeaderValue(value)) {
    return makeCheck(id, {
      status: 'warn',
      value: null,
    });
  }

  return makeCheck(id, {
    status: 'pass',
    value,
  });
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
    return makeCheck(id, {
      status: 'warn',
      value: null,
    });
  }

  const token = primaryPolicyToken(value);

  if (allowed.includes(token)) {
    return makeCheck(id, {
      status: 'pass',
      value,
    });
  }

  return makeCheck(id, {
    status: 'warn',
    value,
  });
}

function checkXRobotsTag(value: string | null): SecurityHeadersCheck {
  const id = 'x-robots-tag' as const;

  if (value === null) {
    return makeCheck(id, {
      status: 'pass',
      value: null,
    });
  }

  return makeCheck(id, {
    status: 'pass',
    value,
  });
}
