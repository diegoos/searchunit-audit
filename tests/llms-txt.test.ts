import { describe, expect, test } from 'bun:test';
import {
  analysisForLlmsOutcome,
  extraLine,
  llmsCheckSections,
} from '../src/commands/llms-txt-check.ts';
import { formatToolReport } from '../src/lib/output.ts';
import type { FetchOutcome } from '../src/lib/fetch.ts';
import type { CheckStatus } from '../src/lib/output.ts';
import { issuesForNonPresentLlms } from '../src/engine/llms.ts';
import {
  analyzeAbsentLlmsTxt,
  analyzeLlmsTxt,
  analyzeLlmsTxtPair,
} from '../src/tools/llmstxt/analyzeLlmsTxt.ts';
import { hasMdExtension, isAbsoluteUrl, parseLlmsTxt } from '../src/tools/llmstxt/parseLlmsTxt.ts';

const VALID_LLMS = `# FastHTML

> FastHTML is a python library for server-rendered hypermedia applications.

## Docs

- [Quick start](https://fastht.ml/docs/tutorials/quickstart_for_web_devs.html.md): Overview of features

- [HTMX reference](https://github.com/bigskysoftware/htmx/blob/master/www/content/reference.md): HTMX attributes

## Optional

- [Starlette docs](https://gist.githubusercontent.com/jph00/raw/starlette-sml.md): Subset of Starlette docs

`;

function fetched(status: number, body = '', url = 'https://example.com/llms.txt'): FetchOutcome {
  return {
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    status,
    contentType: 'text/plain',
    body,
    fetchedAt: '2026-09-11T00:00:00.000Z',
    headers: {},
    redirectChain: [],
    responseTimeMs: 1,
  } as FetchOutcome;
}

const timedOut: FetchOutcome = {
  ok: false,
  requestedUrl: 'https://example.com/llms.txt',
  error: 'timeout',
} as FetchOutcome;

const missingFull = {
  ok: false as const,
  requestedUrl: 'https://example.com/llms-full.txt',
  error: 'not_found' as const,
};

describe('analysisForLlmsOutcome', () => {
  test.each<[string, FetchOutcome, CheckStatus, string]>([
    ['HTTP 404 is absent, not a runtime error', fetched(404), 'fail', 'not_found'],
    ['HTTP 403 is fetch_error, not a throw', fetched(403), 'warn', 'fetch_error'],
    ['a timeout is fetch_error', timedOut, 'warn', 'fetch_error'],
  ])('%s', (_name, outcome, status, detail) => {
    const { analysis } = analysisForLlmsOutcome(outcome, missingFull);

    expect(analysis.checks[0]).toMatchObject({ id: 'presence', status, detail });
    expect(analysis.overallStatus).toBe(status);
  });
  test('HTTP 403 scores 50', () => {
    expect(analysisForLlmsOutcome(fetched(403), missingFull).analysis.score).toBe(50);
  });
  test('keeps hasLlmsFull when llms.txt fetch errors but llms-full.txt is present', () => {
    const fullBody = '# Companion\n\n> Summary\n\n## Docs\n\n- [A](https://example.com/a.md): A\n';
    const { analysis, hasLlmsFull } = analysisForLlmsOutcome(
      fetched(403),
      fetched(200, fullBody, 'https://example.com/llms-full.txt'),
    );

    expect(hasLlmsFull).toBe(true);
    expect(analysis.hasLlmsFull).toBe(true);
    expect(analysis.llmsFullChecks.length).toBeGreaterThan(0);
    expect(extraLine(hasLlmsFull, analysis)).toContain('llms-full.txt present');
  });
});

describe('extraLine', () => {
  test('does not claim a fetched llms.txt on 404', () => {
    const { analysis } = analysisForLlmsOutcome(fetched(404), missingFull);

    expect(extraLine(false, analysis)).toContain('not found');
  });
});

describe('issuesForNonPresentLlms', () => {
  test('404 is not an issue; 403 and timeout are', () => {
    expect(issuesForNonPresentLlms('missing', fetched(404))).toEqual([]);
    expect(issuesForNonPresentLlms('error', fetched(403))).toEqual([
      { code: 'http_status', line: null, text: '403' },
    ]);
    expect(issuesForNonPresentLlms('error', timedOut)).toEqual([
      { code: 'timeout', line: null, text: null },
    ]);
  });
});

describe('parseLlmsTxt', () => {
  test('parses the H1, summary, sections, links and optional sections', () => {
    const parsed = parseLlmsTxt(VALID_LLMS);

    expect(parsed.h1).toBe('FastHTML');
    expect(parsed.summary).toContain('python library');
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]?.heading).toBe('Docs');
    expect(parsed.sections[1]?.isOptional).toBe(true);
    expect(parsed.links).toHaveLength(3);
    expect(parsed.hasBom).toBe(false);
    expect(parsed.syntaxErrors).toEqual([]);
  });
  test('detects a BOM and a missing H1', () => {
    expect(parseLlmsTxt('\uFEFF# Title\n\n> Summary').hasBom).toBe(true);

    const missing = parseLlmsTxt('## Docs\n\n- [Link](/relative)');

    expect(missing.h1).toBeNull();
    expect(missing.syntaxErrors.length).toBeGreaterThan(0);
  });
});

describe('analyzer checks', () => {
  test('a repeated H1 names multiple_h1 in the syntax check', () => {
    const body = '# Site\n# Other\n';
    const analysis = analyzeLlmsTxt(parseLlmsTxt(body), {
      present: true,
      contentType: 'text/plain',
      rawContent: body,
    });
    expect(analysis.checks.find((check) => check.id === 'syntax')?.detail).toMatch(/multiple_h1/);
  });
  test('paragraphs inside an H2 section warn with non_list_in_section', () => {
    const body = `# Site

> Summary

## Docs

Paragraph in a file list.
Another paragraph.
Third paragraph.
Fourth paragraph.
Fifth paragraph.
`;
    const analysis = analyzeLlmsTxt(parseLlmsTxt(body), {
      present: true,
      contentType: 'text/plain',
      rawContent: body,
    });
    expect(analysis.checks.find((check) => check.id === 'syntax')).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/non_list_in_section/),
    });
    expect(analysis.checks.find((check) => check.id === 'non_list_in_section')?.status).toBe(
      'info',
    );
  });
  test('isAbsoluteUrl accepts only http(s) and hasMdExtension reads the pathname', () => {
    expect(isAbsoluteUrl('https://example.com/a.md')).toBe(true);
    expect(isAbsoluteUrl('http://example.com/a')).toBe(true);
    expect(isAbsoluteUrl('/relative')).toBe(false);
    expect(isAbsoluteUrl('ftp://example.com/a')).toBe(false);
    expect(hasMdExtension('https://example.com/doc.md')).toBe(true);
    expect(hasMdExtension('/notes.md')).toBe(true);
    expect(hasMdExtension('https://example.com/doc.html')).toBe(false);
  });
});

describe('analyzeLlmsTxtPair and analyzeAbsentLlmsTxt', () => {
  const main = { present: true, contentType: 'text/plain', rawContent: VALID_LLMS };

  test('an absent llms.txt is a presence failure with empty sections', () => {
    const analysis = analyzeAbsentLlmsTxt();

    expect(analysis).toMatchObject({
      hasLlmsFull: false,
      sections: [],
      links: [],
      llmsFullChecks: [],
    });
    expect(analysis.checks).toEqual([
      expect.objectContaining({ id: 'presence', status: 'fail', detail: 'not_found' }),
    ]);
    expect(analysis.overallStatus).toBe('fail');
  });
  test('the main analysis is kept when the companion is missing', () => {
    const parsed = parseLlmsTxt(VALID_LLMS);
    const single = analyzeLlmsTxt(parsed, main);
    const pair = analyzeLlmsTxtPair(parsed, main, null, false);

    expect(pair).toMatchObject({ hasLlmsFull: false, score: single.score, llmsFullChecks: [] });
  });
  test('the pair score sits between the two analyses when llms-full.txt is present', () => {
    const parsed = parseLlmsTxt(VALID_LLMS);
    const mainOnly = analyzeLlmsTxt(parsed, main);
    const full = analyzeLlmsTxt(parsed, { ...main, isCompanion: true });
    const pair = analyzeLlmsTxtPair(parsed, main, parsed, true, {
      contentType: 'text/plain',
      rawContent: VALID_LLMS,
    });
    expect(pair.hasLlmsFull).toBe(true);
    expect(pair.llmsFullChecks.length).toBe(full.checks.length);
    expect(pair.score).toBeGreaterThanOrEqual(Math.min(mainOnly.score, full.score));
    expect(pair.score).toBeLessThanOrEqual(Math.max(mainOnly.score, full.score));
  });
});

describe('llmsCheckSections', () => {
  test('one table when only llms.txt is present', () => {
    const { analysis } = analysisForLlmsOutcome(fetched(200, VALID_LLMS), missingFull);
    const sections = llmsCheckSections(analysis);

    expect(sections.map((section) => section.heading)).toEqual(['llms.txt']);
    expect(sections[0]?.checks.length).toBe(analysis.checks.length);
  });
  test('llms.txt and llms-full.txt get two tables', () => {
    const { analysis } = analysisForLlmsOutcome(
      fetched(200, VALID_LLMS),
      fetched(200, VALID_LLMS, 'https://example.com/llms-full.txt'),
    );
    const sections = llmsCheckSections(analysis);
    const text = formatToolReport({
      title: 'llms.txt Validator',
      url: 'https://example.com/',
      score: analysis.score,
      status: analysis.overallStatus,
      sections,
    });
    expect(sections.map((section) => section.heading)).toEqual(['llms.txt', 'llms-full.txt']);
    expect(text).toContain('llms-full.txt');
    expect(text.split('Status').length - 1).toBe(2);
  });
});
