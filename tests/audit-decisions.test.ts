import { describe, expect, test } from 'bun:test';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { checkPageLinks } from '../src/engine/linkStatus.ts';
import { isLocalTarget } from '../src/engine/scoring.ts';
import { fetchErrorCode, type FetchOutcome } from '../src/lib/fetch.ts';
import { bundleFromHtml, collectCriticalBlockers } from './engine-fixtures.ts';

const blog = (heading: string) =>
  `<html><body><main><h1>Guia</h1><h2>${heading}</h2><p>Resposta curta e direta.</p></main></body></html>`;

describe('loopback targets', () => {
  test('isLocalTarget covers localhost, *.localhost, 127/8 and ::1 only', () => {
    expect(isLocalTarget('http://localhost:8080/x')).toBe(true);
    expect(isLocalTarget('http://app.localhost/')).toBe(true);
    expect(isLocalTarget('http://127.0.0.2/')).toBe(true);
    expect(isLocalTarget('https://example.com/')).toBe(false);
  });
  test('a local http target is not blocked by no_https', () => {
    const bundle = bundleFromHtml(blog('Como escolher um tênis?'));

    bundle.auditedPage.url = 'http://localhost:8080/guia.html';

    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'no_https')).toBe(false);
  });
  test('a public http target is still blocked by no_https', () => {
    const bundle = bundleFromHtml(blog('Como escolher um tênis?'));

    bundle.auditedPage.url = 'http://example.com/guia.html';

    expect(collectCriticalBlockers(bundle).some((b) => b.id === 'no_https')).toBe(true);
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

describe('opening paragraph', () => {
  test('citability.opening skips a leading byline', () => {
    const html =
      '<html><body><main><p>Por Ana Souza, publicado em 10/03/2026.</p><p>Resposta direta aqui.</p></main></body></html>';
    const parsed = parseHtmlPage(html, 'https://example.com/blog/guia');

    expect(parsed.citabilityOpening).toBe('Resposta direta aqui.');
  });
});

describe('fetch errors', () => {
  test('fetchErrorCode names failures and HTTP error statuses, and is null when usable', () => {
    const failed: FetchOutcome = {
      ok: false,
      requestedUrl: 'https://example.com/robots.txt',
      error: 'timeout',
    };
    const http503 = { ...failed, ok: true, status: 503 } as unknown as FetchOutcome;
    const usable = { ...failed, ok: true, status: 200 } as unknown as FetchOutcome;

    expect(fetchErrorCode(failed)).toBe('timeout');
    expect(fetchErrorCode(http503)).toBe('http_503');
    expect(fetchErrorCode(usable)).toBeNull();
  });
  test('outbound links are never requested by checkPageLinks', async () => {
    const report = await checkPageLinks('https://example.com/', []);

    expect(report.results).toEqual([]);
    expect(report.candidates).toBe(0);
  });
});
