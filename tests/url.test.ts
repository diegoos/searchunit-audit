import { describe, expect, test } from 'bun:test';
import { isValidHttpUrl, normalizeUrl, requireHttpUrl, stripUserinfo } from '../src/lib/url.ts';

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
