import { describe, expect, test } from 'bun:test';
import {
  isValidHttpUrl,
  normalizeUrl,
  pageKey,
  parseLinkHeader,
  requireHttpUrl,
  stripUserinfo,
} from '../src/lib/url.ts';

describe('normalizeUrl', () => {
  test('prepends https when the scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });
  test('prepends http for a loopback host without a scheme', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('127.0.0.1:5173/docs')).toBe('http://127.0.0.1:5173/docs');
    expect(normalizeUrl('[::1]:8080')).toBe('http://[::1]:8080');
  });
  test('keeps an existing scheme', () => {
    expect(normalizeUrl('http://example.com/path')).toBe('http://example.com/path');
  });
  test('returns empty for blank input', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });
});

describe('isValidHttpUrl', () => {
  test('accepts http and https', () => {
    expect(isValidHttpUrl('https://example.com')).toBe(true);
    expect(isValidHttpUrl('example.com')).toBe(true);
  });
  test('rejects javascript URLs and empty input', () => {
    expect(isValidHttpUrl(`javascript:${'alert(1)'}`)).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });
});

describe('stripUserinfo', () => {
  test('clears username and password on the URL', () => {
    const url = stripUserinfo(new URL('https://user:secret@example.com/path'));
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.href).toBe('https://example.com/path');
  });
});

describe('pageKey', () => {
  test('keeps a non-default port and drops the scheme default', () => {
    expect(pageKey('http://localhost:8765/page.html')).toBe('localhost:8765/page.html');
    expect(pageKey('http://localhost:3000/page.html')).toBe('localhost:3000/page.html');
    expect(pageKey('https://example.com:443/a')).toBe('example.com/a');
    expect(pageKey('http://example.com:80/a')).toBe('example.com/a');
  });
  test('drops www, a trailing slash, and tracking params', () => {
    expect(pageKey('https://www.example.com/a/?utm_source=x&gclid=1&fbclid=2')).toBe(
      'example.com/a',
    );
  });
  test('keeps a query that changes the document', () => {
    expect(pageKey('https://example.com/a?id=1&utm_campaign=spring')).toBe('example.com/a?id=1');
    expect(pageKey('https://example.com/a?b=2&id=1')).toBe('example.com/a?b=2&id=1');
  });
});

describe('parseLinkHeader', () => {
  test('reads canonical and hreflang', () => {
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
  test('throws when missing', () => {
    expect(() => requireHttpUrl(undefined)).toThrow('A URL is required');
    expect(() => requireHttpUrl('  ')).toThrow('A URL is required');
  });
  test('throws when the URL is invalid', () => {
    expect(() => requireHttpUrl(`javascript:${'alert(1)'}`)).toThrow('Invalid URL');
  });
  test('returns a normalized href', () => {
    expect(requireHttpUrl('example.com')).toBe('https://example.com/');
  });
  test('strips userinfo from the href', () => {
    expect(requireHttpUrl('https://user:secret@example.com/path')).toBe('https://example.com/path');
  });
  test('does not echo userinfo on a parse failure', () => {
    expect(() => requireHttpUrl('https://user:secret@')).toThrow('Invalid URL: https://');
  });
});
