/** Canonical check IDs (kebab-case) for JSON output and tests. */
const SECURITY_HEADER_IDS = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'x-robots-tag',
] as const;

export type SecurityHeaderId = (typeof SECURITY_HEADER_IDS)[number];

/** Header IDs that affect score and summary.total (excludes informational X-Robots-Tag). */
export const SCORING_HEADER_IDS = SECURITY_HEADER_IDS.filter(
  (id): id is Exclude<SecurityHeaderId, 'x-robots-tag'> => id !== 'x-robots-tag',
);

/** Penalty applied to the score when the check fails (status === 'fail'). */
export const HEADER_PENALTIES: Record<SecurityHeaderId, number> = {
  'strict-transport-security': 25,
  'content-security-policy': 25,
  'x-frame-options': 10,
  'x-content-type-options': 10,
  'referrer-policy': 10,
  'permissions-policy': 5,
  'cross-origin-opener-policy': 5,
  'cross-origin-embedder-policy': 5,
  'cross-origin-resource-policy': 5,
  'x-robots-tag': 0,
};

export const HSTS_RECOMMENDED_MAX_AGE = 31_536_000;

export const CSP_UNSAFE_DIRECTIVES = [
  'unsafe-inline',
  'unsafe-eval',
  'unsafe-hashes',
  'wasm-unsafe-eval',
] as const;

export const REFERRER_SAFE_VALUES = new Set([
  'strict-origin-when-cross-origin',
  'strict-origin',
  'same-origin',
  'no-referrer',
]);

export const REFERRER_WARN_VALUES = new Set(['no-referrer-when-downgrade']);

export const REFERRER_UNSAFE_VALUES = new Set(['unsafe-url', 'origin-when-cross-origin']);

/**
 * All W3C referrer-policy tokens (including `origin`, scored as unknown/warn).
 * Used to pick the last recognized token from a comma-separated list.
 */
export const REFERRER_KNOWN_VALUES = new Set([
  ...REFERRER_SAFE_VALUES,
  ...REFERRER_WARN_VALUES,
  ...REFERRER_UNSAFE_VALUES,
  'origin',
]);

/** Score floors for letter grades — adapted from MDN HTTP Observatory (minus grades merged). */
export const LETTER_GRADE_THRESHOLDS = {
  A_PLUS: 100,
  A: 90,
  B_PLUS: 80,
  B: 70,
  C_PLUS: 60,
  C: 50,
  D_PLUS: 40,
  D: 30,
} as const;

export type LetterGrade = 'A+' | 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D+' | 'D' | 'F' | 'R';

export const BONUS_HSTS_PRELOAD = 0.5;
export const BONUS_CSP_NO_UNSAFE = 0.5;
export const BONUS_PERMISSIONS_POLICY_FLOC_OPTOUT = 0.5;

/** HTTP header names as returned in check results. */
export const HEADER_DISPLAY_NAMES: Record<SecurityHeaderId, string> = {
  'strict-transport-security': 'Strict-Transport-Security',
  'content-security-policy': 'Content-Security-Policy',
  'x-frame-options': 'X-Frame-Options',
  'x-content-type-options': 'X-Content-Type-Options',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
  'cross-origin-opener-policy': 'Cross-Origin-Opener-Policy',
  'cross-origin-embedder-policy': 'Cross-Origin-Embedder-Policy',
  'cross-origin-resource-policy': 'Cross-Origin-Resource-Policy',
  'x-robots-tag': 'X-Robots-Tag',
};
