import { describe, expect, test } from 'bun:test';
import { runGoogleProfile } from '../src/commands/google-profile.ts';
import { CliError } from '../src/lib/errors.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import {
  buildGoogleProfileUrl,
  cleanProfileDomain,
  getApexDomain,
  isSubdomain,
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
    unset: false,
    agent: false,
    outputPath: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    ...over,
  };
}

describe('google profile URL', () => {
  test('cleans schemes and paths', () => {
    expect(cleanProfileDomain('https://WWW.Example.COM/about')).toBe('www.example.com');
    expect(cleanProfileDomain('http://example.net/')).toBe('example.net');
    expect(cleanProfileDomain('blog.example.com')).toBe('blog.example.com');
    expect(cleanProfileDomain('user:pass@example.com')).toBe('example.com');
    expect(cleanProfileDomain('example.com:8080')).toBe('example.com');
    expect(cleanProfileDomain('example.com?q=1')).toBe('example.com');
  });
  test('detects subdomains via tldts', () => {
    expect(getApexDomain('www.example.com')).toBe('example.com');
    expect(getApexDomain('g1.globo.com')).toBe('globo.com');
    expect(getApexDomain('blog.exemplo.com.br')).toBe('exemplo.com.br');
    expect(isSubdomain('www.example.com')).toBe(true);
    expect(isSubdomain('g1.globo.com')).toBe(true);
    expect(isSubdomain('example.com')).toBe(false);
    expect(isSubdomain('exemplo.com.br')).toBe(false);
  });
  test('builds a known profile.google.com URL for example.com', () => {
    expect(buildGoogleProfileUrl('example.com')).toBe(
      'https://profile.google.com/cp/Eg0KC2V4YW1wbGUuY29t',
    );
    expect(buildGoogleProfileUrl('https://example.com/section/x')).toBe(
      'https://profile.google.com/cp/Eg0KC2V4YW1wbGUuY29t',
    );
    expect(buildGoogleProfileUrl('www.example.com')).toBe(
      'https://profile.google.com/cp/EhEKD3d3dy5leGFtcGxlLmNvbQ==',
    );
  });
});

describe('google-profile command', () => {
  test('throws when the domain is missing', async () => {
    await expect(runGoogleProfile(undefined, flags())).rejects.toThrow(CliError);
    await expect(runGoogleProfile('  ', flags())).rejects.toThrow('A domain is required');
  });
  test('throws when the token has no dot', async () => {
    await expect(runGoogleProfile('localhost', flags())).rejects.toThrow('Invalid domain');
  });
  test('prints JSON with domain apex subdomain and profile URL', async () => {
    const logs: string[] = [];
    const original = console.log;

    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''));
    };
    const previous = process.env.CRUX_API_KEY;

    delete process.env.CRUX_API_KEY;

    try {
      const code = await runGoogleProfile('www.example.com', flags({ json: true }));

      expect(code).toBe(0);
      const payload = JSON.parse(logs.join('\n')) as {
        ok: boolean;
        command: string;
        domain: string;
        apex: string;
        isSubdomain: boolean;
        profileUrl: string;
        cruxApiKeyAvailable: boolean;
      };
      expect(payload).toEqual({
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
