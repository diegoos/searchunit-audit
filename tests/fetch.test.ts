import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import {
  allResolvedAddressesArePublic,
  BodyTooLargeError,
  classifyRobotsHttp,
  classifyWellKnownFetch,
  decodeFetchedBytes,
  firstReachableLoopback,
  formatFetchError,
  readCappedBody,
  resolvePublicHop,
  withLocalTarget,
} from '../src/lib/fetch.ts';
import { pinLookup } from '../src/lib/pinnedFetch.ts';

describe('allResolvedAddressesArePublic', () => {
  test.each([
    ['public records only', [{ address: '8.8.8.8' }], true],
    ['mixed public and private records', [{ address: '8.8.8.8' }, { address: '127.0.0.1' }], false],
    ['private records only', [{ address: '10.0.0.1' }], false],
    ['no records', [], false],
  ])('%s', (_label, records, expected) => {
    expect(allResolvedAddressesArePublic(records)).toBe(expected);
  });
});

describe('resolvePublicHop', () => {
  test.each([
    'http://localhost/',
    'http://127.0.0.1/',
    'http://127.0.0.1:3000/',
    'http://10.0.0.1/',
    'http://metadata.google.internal/',
    'ftp://example.com/',
    'https://example.com:8443/',
  ])('blocks %s when no dev target is set', async (url) => {
    expect(await resolvePublicHop(new URL(url))).toEqual({ ok: false, error: 'blocked' });
  });
  test('allows the dev target on its own port only', async () => {
    const probed: string[] = [];
    const probe = async (address: string, port: number): Promise<boolean> => {
      probed.push(`${address}:${port}`);

      return true;
    };
    await withLocalTarget(
      'http://127.0.0.1:5173',
      async () => {
        expect(await resolvePublicHop(new URL('http://127.0.0.1:5173/'))).toEqual({
          ok: true,
          pinnedAddress: '127.0.0.1',
        });
        expect(await resolvePublicHop(new URL('http://[::1]:5173/'))).toEqual({
          ok: true,
          pinnedAddress: '::1',
        });
        const localhost = await resolvePublicHop(new URL('http://localhost:5173/'));

        expect(localhost.ok).toBe(true);

        if (localhost.ok) {
          expect(['127.0.0.1', '::1']).toContain(localhost.pinnedAddress);
        }

        for (const url of [
          'http://127.0.0.1:8080/',
          'http://10.0.0.1:5173/',
          'https://example.com:8443/',
        ]) {
          expect(await resolvePublicHop(new URL(url))).toEqual({ ok: false, error: 'blocked' });
        }
      },
      probe,
    );

    expect(probed).toHaveLength(1);
    expect(probed[0]).toEndWith(':5173');
  });
  test('allows a public IPv4 literal on the default port', async () => {
    expect(await resolvePublicHop(new URL('https://8.8.8.8/'))).toEqual({
      ok: true,
      pinnedAddress: '8.8.8.8',
    });
  });
  test('treats an unresolvable host as a network error, not an SSRF block', async () => {
    const hop = await resolvePublicHop(
      new URL('http://this-host-does-not-exist.invalid.searchunit.test/'),
    );

    expect(hop).toEqual({ ok: false, error: 'network' });
  });
});

describe('firstReachableLoopback', () => {
  const records = [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ];

  test('pins the first address that accepts a connection, probing in record order', async () => {
    const probed: string[] = [];
    const pinned = await firstReachableLoopback(records, 5173, async (address, port) => {
      probed.push(`${address}:${port}`);

      return address === '127.0.0.1';
    });
    expect(pinned).toBe('127.0.0.1');
    expect(probed).toEqual(['::1:5173', '127.0.0.1:5173']);
  });
  test('stops at the first reachable address', async () => {
    const probed: string[] = [];

    expect(
      await firstReachableLoopback(records, 5173, async (address) => {
        probed.push(address);

        return true;
      }),
    ).toBe('::1');
    expect(probed).toEqual(['::1']);
  });
  test('keeps the first record when no address accepts', async () => {
    expect(await firstReachableLoopback(records, 5173, async () => false)).toBe('::1');
  });
});

describe('formatFetchError', () => {
  test('maps every error code to a message', () => {
    const codes = [
      'blocked',
      'not_found',
      'timeout',
      'invalid_url',
      'network',
      'too_large',
    ] as const;

    for (const error of codes) {
      expect(
        formatFetchError({ ok: false, requestedUrl: 'https://x', error }).length,
      ).toBeGreaterThan(0);
    }
  });
  test('appends the HTTP status to a network error', () => {
    expect(
      formatFetchError({ ok: false, requestedUrl: 'https://x', error: 'network', status: 503 }),
    ).toBe('Network error (HTTP 503)');
  });
});

describe('decodeFetchedBytes', () => {
  test('gunzips a gzip payload and passes plain bytes through', async () => {
    const xml = '<urlset><url><loc>https://example.com/</loc></url></urlset>';

    expect(await decodeFetchedBytes(gzipSync(xml))).toBe(xml);
    expect(await decodeFetchedBytes(new TextEncoder().encode(xml))).toBe(xml);
  });
  test('a truncated gzip payload throws instead of returning an empty body', async () => {
    await expect(decodeFetchedBytes(gzipSync('hello world').slice(0, 8))).rejects.toThrow();
  });
  test('a body over the cap throws, whether plain or after gunzip', async () => {
    await expect(decodeFetchedBytes(new TextEncoder().encode('abcdef'), 4)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );

    const gz = gzipSync('a'.repeat(64));

    await expect(decodeFetchedBytes(gz, gz.length)).rejects.toBeInstanceOf(BodyTooLargeError);
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

  return new Response(
    stream,
    contentLength ? { headers: { 'content-length': contentLength } } : {},
  );
}

describe('readCappedBody', () => {
  test('returns a body within the cap', async () => {
    const bytes = await readCappedBody(responseWithBody([new Uint8Array([1, 2, 3])]), 3);

    expect([...bytes]).toEqual([1, 2, 3]);
  });
  test('rejects a streamed body over the cap', async () => {
    const pending = readCappedBody(
      responseWithBody([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      3,
    );

    await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  test('rejects a declared content-length over the cap before reading the body', async () => {
    const pending = readCappedBody(responseWithBody([new Uint8Array([1])], '9'), 3);

    await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('classifyRobotsHttp', () => {
  test('maps 200 to present, 404 to missing, and other statuses or fetch failures to error', () => {
    expect(classifyRobotsHttp(true, 200)).toBe('present');
    expect(classifyRobotsHttp(true, 404)).toBe('missing');
    expect(classifyRobotsHttp(true, 403)).toBe('error');
    expect(classifyRobotsHttp(true, 500)).toBe('error');
    expect(classifyRobotsHttp(false, 404)).toBe('error');
  });
});

describe('classifyWellKnownFetch', () => {
  test('treats a 200 redirect to the homepage as missing', () => {
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
  test('keeps a 200 on the expected path as present', () => {
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
  test('returns the pinned address when all is false', () => {
    pinLookup('8.8.8.8', 4)('example.com', { all: false }, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('8.8.8.8');
      expect(family).toBe(4);
    });
  });
  test('returns the pinned address list when all is true', () => {
    pinLookup('8.8.8.8', 4)('example.com', { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    });
  });
});
