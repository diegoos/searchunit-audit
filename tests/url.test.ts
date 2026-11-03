import { describe, expect, test } from 'bun:test';
import {
  isValidHttpUrl,
  normalizeUrl,
  pageKey,
  parseLinkHeader,
  requireHttpUrl,
} from '../src/lib/url.ts';

describe('normalizeUrl', () => {
  test.each([
    ['example.com', 'https://example.com'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:5173/docs', 'http://127.0.0.1:5173/docs'],
    ['[::1]:8080', 'http://[::1]:8080'],
    ['http://example.com/path', 'http://example.com/path'],
    ['', ''],
    ['   ', ''],
  ])('normalizeUrl(%j) is %j', (input, output) => {
    expect(normalizeUrl(input)).toBe(output);
  });
});

describe('isValidHttpUrl', () => {
  test('accepts http and https, with or without a scheme', () => {
    expect(isValidHttpUrl('https://example.com')).toBe(true);
    expect(isValidHttpUrl('example.com')).toBe(true);
  });
  test('rejects javascript URLs and empty input', () => {
    expect(isValidHttpUrl(`javascript:${'alert(1)'}`)).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });
});

describe('pageKey', () => {
  test.each([
    ['http://localhost:8765/page.html', 'localhost:8765/page.html'],
    ['http://localhost:3000/page.html', 'localhost:3000/page.html'],
    ['https://example.com:443/a', 'example.com/a'],
    ['http://example.com:80/a', 'example.com/a'],
  ])('keeps a non-default port and drops the scheme default: %s', (url, key) => {
    expect(pageKey(url)).toBe(key);
  });
  test('drops www, a trailing slash, and tracking params', () => {
    expect(pageKey('https://www.example.com/a/?utm_source=x&gclid=1&fbclid=2')).toBe(
      'example.com/a',
    );
  });
  test('keeps query params that change the document, sorted by name', () => {
    expect(pageKey('https://example.com/a?id=1&utm_campaign=spring')).toBe('example.com/a?id=1');
    expect(pageKey('https://example.com/a?id=1&b=2')).toBe('example.com/a?b=2&id=1');
  });
});

describe('parseLinkHeader', () => {
  test('reads canonical and hreflang links', () => {
    expect(
      parseLinkHeader(
        '<https://example.com/a>; rel="canonical", <https://example.com/pt>; rel="alternate"; hreflang="pt"',
        'https://example.com/',
      ),
    ).toEqual({
      canonical: 'https://example.com/a',
      hreflang: [{ lang: 'pt', href: 'https://example.com/pt' }],
    });
  });
});

describe('requireHttpUrl', () => {
  test.each([[undefined], ['  ']])('throws "A URL is required" for %j', (input) => {
    expect(() => requireHttpUrl(input)).toThrow('A URL is required');
  });
  test('throws on an invalid URL', () => {
    expect(() => requireHttpUrl(`javascript:${'alert(1)'}`)).toThrow('Invalid URL');
  });
  test('returns a normalized href without userinfo', () => {
    expect(requireHttpUrl('example.com')).toBe('https://example.com/');
    expect(requireHttpUrl('https://user:secret@example.com/path')).toBe('https://example.com/path');
  });
  test('does not echo userinfo when parsing fails', () => {
    expect(() => requireHttpUrl('https://user:secret@')).toThrow('Invalid URL: https://');
  });
});
