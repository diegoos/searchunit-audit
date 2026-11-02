import { describe, expect, test } from 'bun:test';
import type { DiscoveryBundle } from '../src/engine/discovery.ts';
import { pageContentFindings } from '../src/engine/pageFindings.ts';
import { computeAuditScores } from '../src/engine/scoring.ts';
import { bundleFromHtml } from './engine-fixtures.ts';

const LONG_TEXT = 'Reliable widgets for operations teams. '.repeat(20);

function withUrl(html: string, url: string, statusCode = 200): DiscoveryBundle {
  const bundle = bundleFromHtml(html);

  bundle.auditedPage.url = url;
  bundle.auditedPage.statusCode = statusCode;

  return bundle;
}

function finding(bundle: DiscoveryBundle, id: string) {
  return pageContentFindings(bundle).find((item) => item.id === id);
}

describe('content:soft-404', () => {
  test.each([
    ['a title that says not found', '<title>Página não encontrada</title><h1>Loja</h1>'],
    ['an H1 that says not found', '<title>Loja</title><h1>Page not found</h1>'],
  ])('%s on a 200 page fails', (_name, head) => {
    const bundle = withUrl(
      `<html><head>${head}</head><body><p>${LONG_TEXT}</p></body></html>`,
      'https://example.com/x',
    );

    expect(finding(bundle, 'content:soft-404')?.severity).toBe('fail');
  });
  test('thin text with the missing-page wording fails on a 2xx page', () => {
    const bundle = withUrl(
      '<html><head><title>Loja</title></head><body><main><h1>Loja</h1><p>Sorry, the item was not found.</p></main></body></html>',
      'https://example.com/x',
    );

    expect(finding(bundle, 'content:soft-404')?.severity).toBe('fail');
  });
  test('the wording in long body text does not fail', () => {
    const bundle = withUrl(
      `<html><head><title>Guia</title></head><body><main><h1>Guia</h1><p>${LONG_TEXT} Error 404 is a status code.</p></main></body></html>`,
      'https://example.com/x',
    );

    expect(finding(bundle, 'content:soft-404')?.severity).toBe('pass');
  });
  test('a 404 status is not a soft 404', () => {
    const bundle = withUrl(
      '<html><head><title>Not found</title></head><body></body></html>',
      'https://example.com/x',
      404,
    );

    expect(finding(bundle, 'content:soft-404')).toBeUndefined();
  });
  test.each([
    [
      'a short page titled with a 404 prefix',
      '404 - Página não encontrada',
      'Shop the offers. '.repeat(7),
    ],
    [
      'a short page titled with a 404 prefix and a plain name',
      '404 - Loja',
      'Shop the offers. '.repeat(7),
    ],
  ])('%s fails', (_name, title, text) => {
    const bundle = withUrl(
      `<html><head><title>${title}</title></head><body><main><h1>Loja</h1><p>${text}</p></main></body></html>`,
      'https://example.com/x',
    );

    expect(finding(bundle, 'content:soft-404')?.severity).toBe('fail');
  });
  test('a bare 404 number in a short title passes', () => {
    const bundle = withUrl(
      `<html><head><title>Top 404 errors</title></head><body><main><h1>Top 404 errors</h1><p>${'Shop the offers. '.repeat(7)}</p></main></body></html>`,
      'https://example.com/x',
    );

    expect(finding(bundle, 'content:soft-404')?.severity).toBe('pass');
  });
  test.each([
    'Erro 404: como corrigir no WordPress',
    'Como corrigir o erro 404 no WordPress',
    'Why your page shows page not found today',
  ])('a short article titled "%s" passes', (heading) => {
    const bundle = withUrl(
      `<html><head><title>${heading}</title></head><body><main><h1>${heading}</h1><p>${'Shop the offers. '.repeat(30)}</p></main></body></html>`,
      'https://example.com/x',
    );

    expect(bundle.auditedPage.wordCount).toBeLessThan(300);
    expect(finding(bundle, 'content:soft-404')?.severity).toBe('pass');
  });
  test('an article about 404 errors with a long body passes', () => {
    const article = 'Reliable widgets for operations teams. '.repeat(120);
    const bundle = withUrl(
      `<html><head><title>Como corrigir erros 404</title></head><body><main><h1>Como corrigir erros 404</h1><p>${article}</p></main></body></html>`,
      'https://example.com/x',
    );

    expect(bundle.auditedPage.wordCount).toBeGreaterThanOrEqual(300);
    expect(finding(bundle, 'content:soft-404')?.severity).toBe('pass');
  });
  test('a long article whose H1 says "Erro 404" passes, so the word cap decides', () => {
    const article = 'Reliable widgets for operations teams. '.repeat(120);
    const bundle = withUrl(
      `<html><head><title>Guia de erros</title></head><body><main><h1>Erro 404: como corrigir</h1><p>${article}</p></main></body></html>`,
      'https://example.com/x',
    );

    expect(bundle.auditedPage.wordCount).toBeGreaterThanOrEqual(300);
    expect(finding(bundle, 'content:soft-404')?.severity).toBe('pass');
  });
  test('the soft 404 does not change the score', () => {
    const plain = withUrl(
      `<html><head><title>Guia</title></head><body><p>${LONG_TEXT}</p></body></html>`,
      'https://example.com/x',
    );
    const soft = withUrl(
      `<html><head><title>Not found</title></head><body><p>${LONG_TEXT}</p></body></html>`,
      'https://example.com/x',
    );

    expect(computeAuditScores(soft).overall).toBe(computeAuditScores(plain).overall);
  });
});

describe('content:url-structure', () => {
  const plainHtml = `<html><head><title>Guia</title></head><body><p>${LONG_TEXT}</p></body></html>`;

  test.each<[string, string, string, string]>([
    [
      'a session id in the query',
      'https://example.com/guia?jsessionid=ABC',
      'warn',
      'session id in URL',
    ],
    [
      'a session id in the path',
      'https://example.com/guia;jsessionid=ABC',
      'warn',
      'session id in URL',
    ],
    ['uppercase in the path', 'https://example.com/Guia/Tenis', 'info', 'uppercase in path'],
    [
      'an underscore in the slug',
      'https://example.com/guia/tenis_corrida',
      'info',
      'underscore in slug',
    ],
    [
      'four query parameters',
      'https://example.com/guia?a=1&b=2&c=3&d=4',
      'info',
      '4 query parameters',
    ],
    ['depth five', 'https://example.com/a/b/c/d/e', 'info', 'depth 5'],
  ])('%s gives %s', (_name, url, severity, detail) => {
    expect(finding(withUrl(plainHtml, url), 'content:url-structure')).toMatchObject({
      severity,
      detail: expect.stringContaining(detail),
    });
  });
  test.each([
    ['a clean URL', 'https://example.com/guia/tenis-corrida'],
    ['an encoded non-ASCII path', 'https://example.com/caf%C3%A9/guia'],
    ['three query parameters', 'https://example.com/guia?a=1&b=2&c=3'],
  ])('%s passes', (_name, url) => {
    expect(finding(withUrl(plainHtml, url), 'content:url-structure')?.severity).toBe('pass');
  });
});
