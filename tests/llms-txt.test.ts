import { describe, expect, test } from 'bun:test';
import {
  extraLine,
  analysisForLlmsOutcome,
  llmsCheckSections,
} from '../src/commands/llms-txt-check.ts';
import { formatToolReport } from '../src/lib/output.ts';
import { issuesForNonPresentLlms } from '../src/engine/llms.ts';
import {
  analyzeAbsentLlmsTxt,
  analyzeLlmsTxt,
  analyzeLlmsTxtFetchError,
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

const missingFull = {
  ok: false as const,
  requestedUrl: 'https://example.com/llms-full.txt',
  error: 'not_found' as const,
};

describe('analysisForLlmsOutcome', () => {
  test('HTTP 404 is absent, not a runtime error', () => {
    const { analysis } = analysisForLlmsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 404,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      missingFull,
    );

    expect(analysis.checks[0]).toEqual(
      expect.objectContaining({ id: 'presence', status: 'fail', detail: 'not_found' }),
    );
    expect(analysis.overallStatus).toBe('fail');
  });
  test('HTTP 403 is fetch_error, not a throw', () => {
    const { analysis } = analysisForLlmsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 403,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      missingFull,
    );

    expect(analysis.checks[0]).toEqual(
      expect.objectContaining({ id: 'presence', status: 'warn', detail: 'fetch_error' }),
    );
    expect(analysis.overallStatus).toBe('warn');
    expect(analysis.score).toBe(50);
  });
  test('timeout is fetch_error', () => {
    const { analysis } = analysisForLlmsOutcome(
      {
        ok: false,
        requestedUrl: 'https://example.com/llms.txt',
        error: 'timeout',
      },
      missingFull,
    );

    expect(analysis.overallStatus).toBe('warn');
    expect(analysis.checks[0]?.detail).toBe('fetch_error');
  });
  test('keeps hasLlmsFull when llms.txt fetch errors but llms-full.txt is present', () => {
    const fullBody = '# Companion\n\n> Summary\n\n## Docs\n\n- [A](https://example.com/a.md): A\n';
    const { analysis, hasLlmsFull } = analysisForLlmsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 403,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      {
        ok: true,
        requestedUrl: 'https://example.com/llms-full.txt',
        finalUrl: 'https://example.com/llms-full.txt',
        status: 200,
        contentType: 'text/plain',
        body: fullBody,
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
    );

    expect(hasLlmsFull).toBe(true);
    expect(analysis.hasLlmsFull).toBe(true);
    expect(analysis.llmsFullChecks.length).toBeGreaterThan(0);
    expect(extraLine(hasLlmsFull, analysis)).toContain('llms-full.txt present');
  });
});

describe('extraLine', () => {
  test('does not claim a successful fetch on 404', () => {
    const { analysis } = analysisForLlmsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 404,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      missingFull,
    );

    expect(extraLine(false, analysis)).toBe(
      'llms.txt not found (optional file; not a ranking factor)',
    );
  });
});

describe('issuesForNonPresentLlms', () => {
  test('404 is not an issue; 403 and timeout are', () => {
    expect(
      issuesForNonPresentLlms('missing', {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 404,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      }),
    ).toEqual([]);
    expect(
      issuesForNonPresentLlms('error', {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 403,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      }),
    ).toEqual(['llms.txt returned status 403']);
    expect(
      issuesForNonPresentLlms('error', {
        ok: false,
        requestedUrl: 'https://example.com/llms.txt',
        error: 'timeout',
      }),
    ).toEqual(['timeout']);
  });
});

describe('analyzeLlmsTxtFetchError', () => {
  test('warns presence without treating the file as 404', () => {
    const analysis = analyzeLlmsTxtFetchError();

    expect(analysis.overallStatus).toBe('warn');
    expect(analysis.checks).toEqual([
      expect.objectContaining({ id: 'presence', status: 'warn', detail: 'fetch_error' }),
    ]);
  });
});

describe('analyzer details', () => {
  test('llms syntax check names the error', () => {
    const parsed = parseLlmsTxt('# Site\n# Other\n');
    const analysis = analyzeLlmsTxt(parsed, {
      present: true,
      contentType: 'text/plain',
      rawContent: '# Site\n# Other\n',
    });
    const syntax = analysis.checks.find((check) => check.id === 'syntax');

    expect(syntax?.detail).toMatch(/multiple_h1/);
    expect(syntax?.detail).not.toBe('syntax_errors');
  });
  test('non_list_in_section explains H2 file lists and cites the spec', () => {
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
    const syntax = analysis.checks.find((check) => check.id === 'syntax');
    const hint = analysis.checks.find((check) => check.id === 'non_list_in_section');

    expect(syntax?.status).toBe('warn');
    expect(syntax?.detail).toMatch(/lines 7, 8, 9, 10, 11: non_list_in_section/);
    expect(syntax?.detail).not.toContain('https://llmstxt.org/#format');
    expect(hint).toEqual(
      expect.objectContaining({
        status: 'info',
        detail: 'H2 file lists only allow - [name](url). https://llmstxt.org/#format',
      }),
    );
  });
});

describe('parseLlmsTxt', () => {
  test('parses H1 summary sections and links', () => {
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
  test('detects BOM and a missing H1', () => {
    expect(parseLlmsTxt('\uFEFF# Title\n\n> Summary').hasBom).toBe(true);
    const missing = parseLlmsTxt('## Docs\n\n- [Link](/relative)');

    expect(missing.h1).toBeNull();
    expect(missing.syntaxErrors.length).toBeGreaterThan(0);
  });
});

describe('isAbsoluteUrl and hasMdExtension', () => {
  test('isAbsoluteUrl accepts only http(s) URLs', () => {
    expect(isAbsoluteUrl('https://example.com/a.md')).toBe(true);
    expect(isAbsoluteUrl('http://example.com/a')).toBe(true);
    expect(isAbsoluteUrl('/relative')).toBe(false);
    expect(isAbsoluteUrl('ftp://example.com/a')).toBe(false);
  });
  test('hasMdExtension reads the pathname', () => {
    expect(hasMdExtension('https://example.com/doc.md')).toBe(true);
    expect(hasMdExtension('/notes.md')).toBe(true);
    expect(hasMdExtension('https://example.com/doc.html')).toBe(false);
  });
});

describe('analyzeLlmsTxtPair and analyzeAbsentLlmsTxt', () => {
  test('analyzeAbsentLlmsTxt is a presence failure with empty sections', () => {
    const analysis = analyzeAbsentLlmsTxt();

    expect(analysis.hasLlmsFull).toBe(false);
    expect(analysis.sections).toEqual([]);
    expect(analysis.links).toEqual([]);
    expect(analysis.llmsFullChecks).toEqual([]);
    expect(analysis.checks).toEqual([
      expect.objectContaining({ id: 'presence', status: 'fail', detail: 'not_found' }),
    ]);
    expect(analysis.overallStatus).toBe('fail');
  });
  test('analyzeLlmsTxtPair keeps the main analysis when the companion is missing', () => {
    const parsed = parseLlmsTxt(VALID_LLMS);
    const main = analyzeLlmsTxt(parsed, {
      present: true,
      contentType: 'text/plain',
      rawContent: VALID_LLMS,
    });
    const pair = analyzeLlmsTxtPair(
      parsed,
      { present: true, contentType: 'text/plain', rawContent: VALID_LLMS },
      null,
      false,
    );
    expect(pair.hasLlmsFull).toBe(false);
    expect(pair.score).toBe(main.score);
    expect(pair.llmsFullChecks).toEqual([]);
  });
  test('analyzeLlmsTxtPair averages scores when llms-full.txt is present', () => {
    const parsed = parseLlmsTxt(VALID_LLMS);
    const main = analyzeLlmsTxt(parsed, {
      present: true,
      contentType: 'text/plain',
      rawContent: VALID_LLMS,
    });
    const full = analyzeLlmsTxt(parsed, {
      present: true,
      contentType: 'text/plain',
      rawContent: VALID_LLMS,
      isCompanion: true,
    });
    const pair = analyzeLlmsTxtPair(
      parsed,
      { present: true, contentType: 'text/plain', rawContent: VALID_LLMS },
      parsed,
      true,
      { contentType: 'text/plain', rawContent: VALID_LLMS },
    );
    expect(pair.hasLlmsFull).toBe(true);
    expect(pair.llmsFullChecks.length).toBe(full.checks.length);
    expect(pair.score).toBeGreaterThanOrEqual(Math.min(main.score, full.score));
    expect(pair.score).toBeLessThanOrEqual(Math.max(main.score, full.score));
  });
});

describe('llmsCheckSections', () => {
  test('uses one table when only llms.txt is present', () => {
    const { analysis } = analysisForLlmsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 200,
        contentType: 'text/plain',
        body: VALID_LLMS,
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      missingFull,
    );
    const sections = llmsCheckSections(analysis);

    expect(sections.map((section) => section.heading)).toEqual(['llms.txt']);
    expect(sections[0]?.checks.length).toBe(analysis.checks.length);
  });
  test('splits llms.txt and llms-full.txt into two tables', () => {
    const { analysis } = analysisForLlmsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/llms.txt',
        finalUrl: 'https://example.com/llms.txt',
        status: 200,
        contentType: 'text/plain',
        body: VALID_LLMS,
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      {
        ok: true,
        requestedUrl: 'https://example.com/llms-full.txt',
        finalUrl: 'https://example.com/llms-full.txt',
        status: 200,
        contentType: 'text/plain',
        body: VALID_LLMS,
        fetchedAt: '2026-09-11T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
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
    expect(sections[0]?.checks.map((check) => check.id)).not.toEqual(
      sections[1]?.checks.map((check) => check.id),
    );
    expect(text).toContain('llms.txt');
    expect(text).toContain('llms-full.txt');
    expect(text.split('Status').length - 1).toBe(2);
  });
});
