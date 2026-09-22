import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import {
  allResolvedAddressesArePublic,
  BodyTooLargeError,
  classifyRobotsHttp,
  classifyWellKnownFetch,
  decodeFetchedBytes,
  formatFetchError,
  readCappedBody,
  resolvePublicHop,
} from '../src/lib/fetch.ts';

import { pinLookup } from '../src/lib/pinnedFetch.ts';

describe('allResolvedAddressesArePublic', () => {
  test('rejects mixed public and private records', () => {
    expect(allResolvedAddressesArePublic([{ address: '8.8.8.8' }, { address: '127.0.0.1' }])).toBe(
      false,
    );
  });
  test('accepts only-public records', () => {
    expect(allResolvedAddressesArePublic([{ address: '8.8.8.8' }])).toBe(true);
  });
  test('rejects empty and private-only', () => {
    expect(allResolvedAddressesArePublic([])).toBe(false);
    expect(allResolvedAddressesArePublic([{ address: '10.0.0.1' }])).toBe(false);
  });
});

describe('resolvePublicHop', () => {
  test('rejects localhost', async () => {
    expect(await resolvePublicHop(new URL('http://localhost/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
    expect(await resolvePublicHop(new URL('http://127.0.0.1/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
  });
  test('rejects metadata hostnames', async () => {
    expect(await resolvePublicHop(new URL('http://metadata.google.internal/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
  });
  test('rejects non-http schemes', async () => {
    expect(await resolvePublicHop(new URL('ftp://example.com/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
  });
  test('rejects non-default ports', async () => {
    expect(await resolvePublicHop(new URL('https://example.com:8443/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
  });
  test('accepts a public IPv4 on the default port', async () => {
    expect(await resolvePublicHop(new URL('https://8.8.8.8/'))).toEqual({
      ok: true,
      pinnedAddress: '8.8.8.8',
    });
  });
  test('rejects multicast and IPv6 site-local', async () => {
    expect(await resolvePublicHop(new URL('http://224.0.0.1/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
    expect(await resolvePublicHop(new URL('http://[ff02::1]/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
    expect(await resolvePublicHop(new URL('http://[fec0::1]/'))).toEqual({
      ok: false,
      error: 'blocked',
    });
  });
  test('treats NXDOMAIN as network, not SSRF blocked', async () => {
    const hop = await resolvePublicHop(
      new URL('http://this-host-does-not-exist.invalid.searchunit.test/'),
    );

    expect(hop).toEqual({ ok: false, error: 'network' });
  });
});

describe('formatFetchError', () => {
  test('maps each error code to a CLI string', () => {
    expect(formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'blocked' })).toBe(
      'URL blocked by SSRF policy (private/localhost/metadata host)',
    );
    expect(formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'not_found' })).toBe(
      'Resource not found (HTTP 404)',
    );
    expect(formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'timeout' })).toBe(
      'Fetch timed out',
    );
    expect(formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'invalid_url' })).toBe(
      'Invalid URL',
    );
    expect(formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'network' })).toBe(
      'Network error',
    );
    expect(
      formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'network', status: 503 }),
    ).toBe('Network error (HTTP 503)');
    expect(formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'too_large' })).toBe(
      'Response body exceeds the configured size cap',
    );
  });
});

describe('decodeFetchedBytes', () => {
  test('gunzips a gzip payload and leaves plain XML unchanged', async () => {
    const xml = '<urlset><url><loc>https://example.com/</loc></url></urlset>';

    expect(await decodeFetchedBytes(gzipSync(xml))).toBe(xml);
    expect(await decodeFetchedBytes(new TextEncoder().encode(xml))).toBe(xml);
  });
  test('truncated gzip fails decode instead of returning an empty body', async () => {
    const gz = gzipSync('hello world');

    await expect(decodeFetchedBytes(gz.slice(0, 8))).rejects.toThrow();
  });
  test('gzip that expands past the cap throws instead of returning a prefix', async () => {
    const raw = 'a'.repeat(64);
    const gz = gzipSync(raw);

    expect(gz.length).toBeLessThan(raw.length);
    await expect(decodeFetchedBytes(gz, gz.length)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  test('plain bytes over the cap throw', async () => {
    await expect(decodeFetchedBytes(new TextEncoder().encode('abcdef'), 4)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});

function responseWithBody(chunks: Uint8Array[], contentLength?: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
  const headers = contentLength ? { 'content-length': contentLength } : undefined;

  return new Response(stream, { headers });
}

describe('readCappedBody', () => {
  test('returns a body that fits the cap', async () => {
    const bytes = await readCappedBody(responseWithBody([new Uint8Array([1, 2, 3])]), 3);

    expect([...bytes]).toEqual([1, 2, 3]);
  });
  test('rejects a body over the cap', async () => {
    const pending = readCappedBody(
      responseWithBody([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      3,
    );

    await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  test('rejects a content-length over the cap before reading', async () => {
    const pending = readCappedBody(responseWithBody([new Uint8Array([1])], '9'), 3);

    await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('classifyRobotsHttp', () => {
  test('maps 200 present, 404 missing, other HTTP and fetch failure to error', () => {
    expect(classifyRobotsHttp(true, 200)).toBe('present');
    expect(classifyRobotsHttp(true, 404)).toBe('missing');
    expect(classifyRobotsHttp(true, 403)).toBe('error');
    expect(classifyRobotsHttp(true, 500)).toBe('error');
    expect(classifyRobotsHttp(false, 404)).toBe('error');
  });
});

describe('classifyWellKnownFetch', () => {
  test('treats a 200 homepage redirect as missing', () => {
    expect(
      classifyWellKnownFetch(
        {
          ok: true,
          requestedUrl: 'https://example.com/robots.txt',
          finalUrl: 'https://example.com/',
          status: 200,
          contentType: 'text/html',
          body: '<html></html>',
          fetchedAt: new Date().toISOString(),
          headers: {},
          redirectChain: ['https://example.com/robots.txt', 'https://example.com/'],
          responseTimeMs: 1,
        },
        '/robots.txt',
      ),
    ).toBe('missing');
  });
  test('keeps a 200 on the expected path', () => {
    expect(
      classifyWellKnownFetch(
        {
          ok: true,
          requestedUrl: 'https://example.com/robots.txt',
          finalUrl: 'https://example.com/robots.txt',
          status: 200,
          contentType: 'text/plain',
          body: 'User-agent: *\nDisallow:',
          fetchedAt: new Date().toISOString(),
          headers: {},
          redirectChain: ['https://example.com/robots.txt'],
          responseTimeMs: 1,
        },
        '/robots.txt',
      ),
    ).toBe('present');
  });
});

describe('pinLookup', () => {
  test('returns a single address when all is false', () => {
    const lookup = pinLookup('8.8.8.8', 4);

    lookup('example.com', { all: false }, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('8.8.8.8');
      expect(family).toBe(4);
    });
  });
  test('returns an address list when all is true', () => {
    const lookup = pinLookup('8.8.8.8', 4);

    lookup('example.com', { all: true }, (err, address) => {
      expect(err).toBeNull();
      expect(address).toEqual([{ address: '8.8.8.8', family: 4 }]);
    });
  });
});
