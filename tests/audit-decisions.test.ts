import { describe, expect, test } from 'bun:test';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { isLocalTarget } from '../src/engine/localTarget.ts';
import { checkPageLinks } from '../src/engine/linkStatus.ts';
import { computeAuditScores, type CriticalBlocker } from '../src/engine/scoring.ts';
import { fetchErrorCode, type FetchOutcome } from '../src/lib/fetch.ts';
import { bundleFromHtml } from './engine-fixtures.ts';

const blog = (heading: string) =>
  `<html><body><main><h1>Guia</h1><h2>${heading}</h2><p>Resposta curta e direta.</p></main></body></html>`;

function blockersFor(html: string, url: string): CriticalBlocker[] {
  const bundle = bundleFromHtml(html);
  const blockers: CriticalBlocker[] = [];

  bundle.auditedPage.url = url;
  computeAuditScores(bundle, blockers);

  return blockers;
}

describe('loopback targets', () => {
  test('isLocalTarget covers localhost, *.localhost, 127/8 and ::1 only', () => {
    expect(isLocalTarget('http://localhost:8080/x')).toBe(true);
    expect(isLocalTarget('http://app.localhost/')).toBe(true);
    expect(isLocalTarget('http://127.0.0.2/')).toBe(true);
    expect(isLocalTarget('https://example.com/')).toBe(false);
  });
  test.each([
    ['http://localhost:8080/guia.html', false],
    ['http://example.com/guia.html', true],
  ])('no_https blocker for %s: %p', (url, blocked) => {
    const blockers = blockersFor(blog('Como escolher um tênis?'), url);

    expect(blockers.some((blocker) => blocker.id === 'no_https')).toBe(blocked);
  });
});

describe('question headings and FAQ credit', () => {
  test.each([
    'How to reset your password',
    'Como escolher um tênis?',
    'What is drop?',
    'Can I run on trails?',
  ])('counts "%s" as a question heading', (heading) => {
    const parsed = parseHtmlPage(blog(heading), 'https://example.com/blog/guia');

    expect(parsed.contentSignals.question_heading_count).toBeGreaterThan(0);
  });
  test('a statement that starts with "Why" is not a question heading', () => {
    const parsed = parseHtmlPage(blog('Why choose Acme'), 'https://example.com/blog/guia');

    expect(parsed.contentSignals.question_heading_count).toBe(0);
  });
  test('an FAQ heading alone does not give the FAQ credit', () => {
    const parsed = parseHtmlPage(
      '<html><body><main><h2>FAQ</h2><p>Texto.</p></main></body></html>',
      'https://example.com/faq',
    );

    expect(parsed.contentSignals.hasFaqPattern).toBe(false);
  });
});

describe('fetch errors and outbound links', () => {
  test('fetchErrorCode names failures and HTTP error statuses, and is null when usable', () => {
    const base = { ok: false, requestedUrl: 'https://example.com/robots.txt', error: 'timeout' };

    expect(fetchErrorCode(base as FetchOutcome)).toBe('timeout');
    expect(fetchErrorCode({ ...base, ok: true, status: 503 } as unknown as FetchOutcome)).toBe(
      'http_503',
    );
    expect(
      fetchErrorCode({ ...base, ok: true, status: 200 } as unknown as FetchOutcome),
    ).toBeNull();
  });
  test('outbound links are never requested by checkPageLinks', async () => {
    const report = await checkPageLinks('https://example.com/', []);

    expect(report.results).toEqual([]);
    expect(report.candidates).toBe(0);
  });
});
