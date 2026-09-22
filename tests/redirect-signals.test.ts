import { describe, expect, test } from 'bun:test';
import { deriveRedirectSignals } from '../src/engine/redirectSignals.ts';

describe('deriveRedirectSignals', () => {
  test('counts hops and flags http to https and www changes', () => {
    const https = deriveRedirectSignals('http://example.com/', 'https://example.com/', [
      'http://example.com/',
      'https://example.com/',
    ]);
    expect(https).toEqual({
      chain_length: 1,
      http_to_https: true,
      www_normalized: false,
      redirect_chain: ['http://example.com/', 'https://example.com/'],
    });
    const www = deriveRedirectSignals('https://example.com/', 'https://www.example.com/', [
      'https://example.com/',
      'https://www.example.com/',
    ]);
    expect(www.www_normalized).toBe(true);
    expect(www.http_to_https).toBe(false);
    const empty = deriveRedirectSignals('https://example.com/', 'https://example.com/', []);
    expect(empty.chain_length).toBe(1);
    expect(empty.redirect_chain).toEqual(['https://example.com/', 'https://example.com/']);
  });
  test('leaves flags false for invalid URLs', () => {
    const signals = deriveRedirectSignals('not a url', 'also bad', ['not a url', 'also bad']);

    expect(signals.http_to_https).toBe(false);
    expect(signals.www_normalized).toBe(false);
    expect(signals.chain_length).toBe(1);
  });
});
