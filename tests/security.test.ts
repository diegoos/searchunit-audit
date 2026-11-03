import { describe, expect, test } from 'bun:test';
import {
  analyzeSecurityHeaders,
  scoreToLetterGrade,
} from '../src/tools/security/analyzeSecurityHeaders.ts';
import { buildAnalyzeContext } from '../src/tools/security/buildAnalyzeContext.ts';
import {
  parseCspDirectives,
  parseHstsDirectives,
  parseSecurityHeaders,
  type SecurityHeaderRaw,
} from '../src/tools/security/parseSecurityHeaders.ts';
import type { LetterGrade } from '../src/tools/security/securityHeadersRules.ts';

const FULL_HEADERS: SecurityHeaderRaw = {
  hsts: 'max-age=63072000; includeSubDomains; preload',
  csp: "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
  cspReportOnly: null,
  xFrame: null,
  xContentType: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
  coop: 'same-origin',
  coep: 'require-corp',
  corp: 'same-origin',
  xRobotsTag: null,
};

const HTTPS_OK = { https: true, redirectNotFollowed: false, allScoringChecksPass: true };

describe('parseSecurityHeaders', () => {
  test('maps lowercase header names and fills missing keys with null', () => {
    expect(
      parseSecurityHeaders({
        'strict-transport-security': 'max-age=1',
        'x-content-type-options': 'nosniff',
      }),
    ).toEqual({
      hsts: 'max-age=1',
      csp: null,
      cspReportOnly: null,
      xFrame: null,
      xContentType: 'nosniff',
      referrerPolicy: null,
      permissionsPolicy: null,
      coop: null,
      coep: null,
      corp: null,
      xRobotsTag: null,
    });
    expect(parseSecurityHeaders(undefined).hsts).toBeNull();
  });
});

describe('parseHstsDirectives', () => {
  test('parses max-age, includeSubDomains and preload from the first header', () => {
    expect(parseHstsDirectives('max-age=31536000; includeSubDomains; preload')).toEqual({
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    });
    expect(parseHstsDirectives('max-age=1, max-age=999; preload')).toEqual({
      maxAge: 1,
      includeSubDomains: false,
      preload: false,
    });
  });
});

describe('parseCspDirectives', () => {
  test('splits directives and merges comma-joined headers', () => {
    const map = parseCspDirectives("default-src 'self'; script-src 'self', frame-ancestors 'none'");

    expect(map.get('default-src')).toEqual(["'self'"]);
    expect(map.get('script-src')).toEqual(["'self'"]);
    expect(map.get('frame-ancestors')).toEqual(["'none'"]);
  });
});

describe('buildAnalyzeContext', () => {
  test('sets https from the final URL and redirectNotFollowed from a 3xx status', () => {
    expect(buildAnalyzeContext({ finalUrl: 'https://example.com/', status: 200 })).toEqual({
      https: true,
      redirectNotFollowed: false,
    });
    expect(buildAnalyzeContext({ finalUrl: 'http://example.com/', status: 301 })).toEqual({
      https: false,
      redirectNotFollowed: true,
    });
  });
});

describe('scoreToLetterGrade', () => {
  test('returns R for a redirect that was not followed, and F when HTTPS is off', () => {
    expect(scoreToLetterGrade(100, { ...HTTPS_OK, redirectNotFollowed: true })).toBe('R');
    expect(scoreToLetterGrade(100, { ...HTTPS_OK, https: false })).toBe('F');
  });
  test.each<[number, boolean, LetterGrade]>([
    [100, true, 'A+'],
    [100, false, 'A'],
    [90, true, 'A'],
    [80, true, 'B+'],
    [70, true, 'B'],
    [60, true, 'C+'],
    [50, true, 'C'],
    [40, true, 'D+'],
    [30, true, 'D'],
    [29, true, 'F'],
  ])('score %p with all checks passing=%p on HTTPS gives %p', (score, allPass, grade) => {
    expect(scoreToLetterGrade(score, { ...HTTPS_OK, allScoringChecksPass: allPass })).toBe(grade);
  });
});

describe('analyzeSecurityHeaders', () => {
  test('complete headers over HTTPS grade A+ with a passing overall status', () => {
    const analysis = analyzeSecurityHeaders(FULL_HEADERS, HTTPS_OK);

    expect(analysis.letterGrade).toBe('A+');
    expect(analysis.score).toBeGreaterThanOrEqual(95);
    expect(analysis.overallStatus).toBe('pass');
    expect(analysis.https).toBe(true);
    expect(analysis.redirectNotFollowed).toBe(false);
    expect(analysis.summary.present).toBeGreaterThan(0);
    expect(analysis.summary.present).toBeLessThanOrEqual(analysis.summary.total);
    expect(analysis.checks.length).toBeGreaterThanOrEqual(analysis.summary.total);
    expect(analysis.checks.find((check) => check.id === 'x-frame-options')?.status).toBe('pass');
    expect(analysis.checks.find((check) => check.id === 'observatory')?.status).toBe('info');
  });
  test('a redirect that was not followed grades R with score 0', () => {
    const analysis = analyzeSecurityHeaders(FULL_HEADERS, {
      ...HTTPS_OK,
      redirectNotFollowed: true,
    });
    expect(analysis).toMatchObject({ letterGrade: 'R', score: 0, redirectNotFollowed: true });
  });
  test.each<[string, Partial<SecurityHeaderRaw>, 'fail' | 'warn']>([
    ['strict-transport-security', { hsts: 'max-age=0' }, 'fail'],
    [
      'content-security-policy',
      { csp: "default-src 'self'; script-src 'self' 'unsafe-inline'" },
      'warn',
    ],
  ])('%s check is %s for a weak header', (id, over, status) => {
    const analysis = analyzeSecurityHeaders({ ...FULL_HEADERS, ...over }, HTTPS_OK);

    expect(analysis.checks.find((check) => check.id === id)?.status).toBe(status);
  });
});
