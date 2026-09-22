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
  });
  test('returns all-null when headers are omitted', () => {
    expect(parseSecurityHeaders(undefined).hsts).toBeNull();
  });
});

describe('parseHstsDirectives', () => {
  test('returns empty flags when the header is missing', () => {
    expect(parseHstsDirectives(null)).toEqual({
      maxAge: null,
      includeSubDomains: false,
      preload: false,
    });
  });
  test('parses max-age includeSubDomains and preload from the first header', () => {
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
  test('returns an empty map for a missing header', () => {
    expect(parseCspDirectives(null).size).toBe(0);
  });
  test('splits directives and merges comma-joined headers', () => {
    const map = parseCspDirectives("default-src 'self'; script-src 'self', frame-ancestors 'none'");

    expect(map.get('default-src')).toEqual(["'self'"]);
    expect(map.get('script-src')).toEqual(["'self'"]);
    expect(map.get('frame-ancestors')).toEqual(["'none'"]);
  });
});

describe('buildAnalyzeContext', () => {
  test('sets https from the final URL and redirect from 3xx status', () => {
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
  const httpsPass = { https: true, allScoringChecksPass: true, redirectNotFollowed: false };

  test('returns R when a redirect was not followed and F when HTTPS is off', () => {
    expect(scoreToLetterGrade(100, { ...httpsPass, redirectNotFollowed: true })).toBe('R');
    expect(scoreToLetterGrade(100, { ...httpsPass, https: false })).toBe('F');
  });
  test('maps score bands on HTTPS', () => {
    expect(scoreToLetterGrade(100, httpsPass)).toBe('A+');
    expect(scoreToLetterGrade(100, { ...httpsPass, allScoringChecksPass: false })).toBe('A');
    expect(scoreToLetterGrade(90, httpsPass)).toBe('A');
    expect(scoreToLetterGrade(80, httpsPass)).toBe('B+');
    expect(scoreToLetterGrade(70, httpsPass)).toBe('B');
    expect(scoreToLetterGrade(60, httpsPass)).toBe('C+');
    expect(scoreToLetterGrade(50, httpsPass)).toBe('C');
    expect(scoreToLetterGrade(40, httpsPass)).toBe('D+');
    expect(scoreToLetterGrade(30, httpsPass)).toBe('D');
    expect(scoreToLetterGrade(29, httpsPass)).toBe('F');
  });
});

describe('analyzeSecurityHeaders', () => {
  test('returns A+ with required analysis fields when headers are complete', () => {
    const analysis = analyzeSecurityHeaders(FULL_HEADERS, {
      https: true,
      redirectNotFollowed: false,
    });
    expect(analysis.letterGrade).toBe('A+');
    expect(analysis.score).toBeGreaterThanOrEqual(95);
    expect(analysis.overallStatus).toBe('pass');
    expect(analysis.https).toBe(true);
    expect(analysis.redirectNotFollowed).toBe(false);
    expect(analysis.summary.present).toBeGreaterThan(0);
    expect(analysis.summary.present).toBeLessThanOrEqual(analysis.summary.total);
    expect(analysis.checks.length).toBeGreaterThanOrEqual(analysis.summary.total);
    expect(analysis.checks.find((check) => check.id === 'x-frame-options')?.status).toBe('pass');
    expect(analysis.checks.find((check) => check.id === 'observatory')).toEqual(
      expect.objectContaining({
        status: 'info',
        detail:
          'Tests and grades follow MDN HTTP Observatory. https://developer.mozilla.org/en-US/observatory/docs/tests_and_scoring',
      }),
    );
  });
  test('returns R and score 0 when the redirect was not followed', () => {
    const analysis = analyzeSecurityHeaders(FULL_HEADERS, {
      https: true,
      redirectNotFollowed: true,
    });
    expect(analysis.letterGrade).toBe('R');
    expect(analysis.score).toBe(0);
    expect(analysis.redirectNotFollowed).toBe(true);
  });
  test('fails HSTS with max-age=0', () => {
    const analysis = analyzeSecurityHeaders(
      { ...FULL_HEADERS, hsts: 'max-age=0' },
      { https: true, redirectNotFollowed: false },
    );
    expect(analysis.checks.find((check) => check.id === 'strict-transport-security')?.status).toBe(
      'fail',
    );
  });
  test('warns when CSP allows unsafe-inline scripts', () => {
    const analysis = analyzeSecurityHeaders(
      {
        ...FULL_HEADERS,
        csp: "default-src 'self'; script-src 'self' 'unsafe-inline'",
      },
      { https: true, redirectNotFollowed: false },
    );
    expect(analysis.checks.find((check) => check.id === 'content-security-policy')?.status).toBe(
      'warn',
    );
  });
});
