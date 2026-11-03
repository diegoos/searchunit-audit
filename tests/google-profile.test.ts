import { describe, expect, test } from 'bun:test';
import { runGoogleProfile } from '../src/commands/google-profile.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import {
  buildGoogleProfileUrl,
  cleanProfileDomain,
  getApexDomain,
} from '../src/lib/googleProfile.ts';

function flags(over: Partial<CliFlags> = {}): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    silent: true,
    outFormat: 'table',
    failOn: undefined,
    rest: [],
    global: false,
    agent: false,
    outputPath: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    ...over,
  };
}

describe('google profile helpers', () => {
  test.each([
    ['https://WWW.Example.COM/about', 'www.example.com'],
    ['user:pass@example.com', 'example.com'],
    ['example.com:8080', 'example.com'],
    ['example.com?q=1', 'example.com'],
  ])('cleanProfileDomain(%s) is %s', (input, domain) => {
    expect(cleanProfileDomain(input)).toBe(domain);
  });
  test.each([
    ['www.example.com', 'example.com'],
    ['g1.globo.com', 'globo.com'],
    ['blog.exemplo.com.br', 'exemplo.com.br'],
  ])('getApexDomain(%s) is %s', (host, apex) => {
    expect(getApexDomain(host)).toBe(apex);
  });
  test.each([
    ['example.com', 'https://profile.google.com/cp/Eg0KC2V4YW1wbGUuY29t'],
    ['https://example.com/section/x', 'https://profile.google.com/cp/Eg0KC2V4YW1wbGUuY29t'],
    ['www.example.com', 'https://profile.google.com/cp/EhEKD3d3dy5leGFtcGxlLmNvbQ=='],
  ])('buildGoogleProfileUrl(%s) builds the profile link', (input, url) => {
    expect(buildGoogleProfileUrl(input)).toBe(url);
  });
});

describe('google-profile command', () => {
  test.each([
    [undefined, 'A domain is required'],
    ['  ', 'A domain is required'],
    ['localhost', 'Invalid domain'],
  ])('domain %s throws "%s"', async (domain, message) => {
    await expect(runGoogleProfile(domain, flags())).rejects.toThrow(message);
  });
  test('prints JSON with the domain, apex, subdomain flag, and profile URL', async () => {
    const logs: string[] = [];
    const original = console.log;
    const previous = process.env.CRUX_API_KEY;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    delete process.env.CRUX_API_KEY;

    try {
      const code = await runGoogleProfile('www.example.com', flags({ json: true }));

      expect(code).toBe(0);
      expect(JSON.parse(logs.join('\n'))).toEqual({
        ok: true,
        command: 'google-profile',
        domain: 'www.example.com',
        apex: 'example.com',
        isSubdomain: true,
        profileUrl: 'https://profile.google.com/cp/EhEKD3d3dy5leGFtcGxlLmNvbQ==',
        cruxApiKeyAvailable: false,
      });
    } finally {
      console.log = original;

      if (previous === undefined) {
        delete process.env.CRUX_API_KEY;
      } else {
        process.env.CRUX_API_KEY = previous;
      }
    }
  });
});
