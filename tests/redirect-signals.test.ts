import { describe, expect, test } from 'bun:test';
import { deriveRedirectSignals } from '../src/engine/redirectSignals.ts';

describe('deriveRedirectSignals', () => {
  test('flags an http to https hop with its chain', () => {
    expect(
      deriveRedirectSignals('http://example.com/', 'https://example.com/', [
        'http://example.com/',
        'https://example.com/',
      ]),
    ).toEqual({
      chain_length: 1,
      http_to_https: true,
      www_normalized: false,
      redirect_chain: ['http://example.com/', 'https://example.com/'],
    });
  });
  test('flags a www normalization', () => {
    const signals = deriveRedirectSignals('https://example.com/', 'https://www.example.com/', [
      'https://example.com/',
      'https://www.example.com/',
    ]);

    expect(signals.www_normalized).toBe(true);
    expect(signals.http_to_https).toBe(false);
  });
  test('an empty chain falls back to the requested and final URLs', () => {
    expect(
      deriveRedirectSignals('https://example.com/', 'https://example.com/', []).redirect_chain,
    ).toEqual(['https://example.com/', 'https://example.com/']);
  });
  test('leaves flags false for invalid URLs', () => {
    const signals = deriveRedirectSignals('not a url', 'also bad', ['not a url', 'also bad']);

    expect(signals).toMatchObject({ http_to_https: false, www_normalized: false, chain_length: 1 });
  });
});
