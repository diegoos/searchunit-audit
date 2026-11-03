import { describe, expect, spyOn, test } from 'bun:test';
import { MOBILE_CHROME_USER_AGENT, runLocalDiscovery } from '../src/engine/discovery.ts';
import * as fetchModule from '../src/lib/fetch.ts';
import type { FetchOptions, FetchOutcome } from '../src/lib/fetch.ts';

const DESKTOP_HTML = `<html><head><title>Desk</title></head><body><h1>Desk</h1><p>Hello desktop page.</p></body></html>`;

const MOBILE_HTML = `<html><head>
  <meta name="viewport" content="width=device-width"/>
  <meta name="robots" content="noindex"/>
  <script type="application/ld+json">{"@type":"Product","name":"Widget"}</script>
</head><body>
  <h1>Mobile</h1>
  <a href="/a">a</a>
  <a href="/b">b</a>
  <p>hello mobile page</p>
</body></html>`;

function page(url: string, body: string, headers: Record<string, string> = {}): FetchOutcome {
  return {
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    body,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    headers,
    redirectChain: [url],
    responseTimeMs: 1,
  };
}

function failure(url: string): FetchOutcome {
  return { ok: false, requestedUrl: url, error: 'network' };
}

function isSideFile(url: string): boolean {
  return /\/(robots\.txt|llms\.txt|llms-full\.txt|sitemap\.xml)$/.test(new URL(url).pathname);
}

async function withFetchStub(
  mobile: (url: string) => FetchOutcome | Promise<FetchOutcome>,
  assert: (calls: { url: string; userAgent?: string }[]) => Promise<void>,
  desktopHeaders: Record<string, string> = {},
): Promise<void> {
  const previous = process.env.CRUX_API_KEY;
  const calls: { url: string; userAgent?: string }[] = [];

  delete process.env.CRUX_API_KEY;
  const spy = spyOn(fetchModule, 'fetchPublicUrl').mockImplementation(
    async (url: string, options?: FetchOptions) => {
      calls.push({ url, userAgent: options?.userAgent });

      if (options?.userAgent === MOBILE_CHROME_USER_AGENT) {
        return mobile(url);
      }

      if (isSideFile(url)) {
        return failure(url);
      }

      return page(url, DESKTOP_HTML, desktopHeaders);
    },
  );

  try {
    await assert(calls);
  } finally {
    spy.mockRestore();

    if (previous === undefined) {
      delete process.env.CRUX_API_KEY;
    } else {
      process.env.CRUX_API_KEY = previous;
    }
  }
}

describe('mobile page snapshot', () => {
  test.each([
    ['a failed second GET', (url: string) => failure(url), 'network'],
    [
      'a thrown second GET',
      () => {
        throw new Error('mobile down');
      },
      undefined,
    ],
  ])('%s leaves the mobile snapshot null without throwing', async (_name, mobile, fetchError) => {
    await withFetchStub(mobile, async (calls) => {
      const bundle = await runLocalDiscovery('https://example.com/');

      expect(calls.some((call) => call.userAgent === MOBILE_CHROME_USER_AGENT)).toBe(true);
      expect(bundle.mobilePage).toBeNull();
      expect(bundle.pagesSampled).toBe(1);

      if (fetchError) {
        expect(bundle.mobileFetchError).toBe(fetchError);
      }
    });
  });
  test('discovery declares a page-level audit scope', async () => {
    await withFetchStub(
      (url) => failure(url),
      async () => {
        const kind = await runLocalDiscovery('https://example.com/');
        const audit = await runLocalDiscovery('https://example.com/', undefined, 1500, 40, true);

        expect(kind.auditScope).toMatchObject({ level: 'page', pagesScored: 1 });
        expect(kind.auditScope.contextFetches.linksProbed).toBe(0);
        expect(audit.linkStatus.status).toBe('completed');
      },
    );
  });
  test('the advisory security header values reach the summary', async () => {
    await withFetchStub(
      (url) => page(url, MOBILE_HTML),
      async () => {
        const bundle = await runLocalDiscovery('https://example.com/');

        expect(bundle.securityHeaders).toMatchObject({
          permissions_policy: 'geolocation=()',
          cross_origin_opener_policy: 'same-origin',
          cross_origin_embedder_policy: 'require-corp',
          cross_origin_resource_policy: 'same-origin',
        });
      },
      {
        'permissions-policy': 'geolocation=()',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      },
    );
  });
  test('a mobile response becomes a snapshot without the HTML body', async () => {
    await withFetchStub(
      (url) => page(url, MOBILE_HTML, { 'x-robots-tag': 'nofollow' }),
      async () => {
        const bundle = await runLocalDiscovery('https://example.com/');
        const mobile = bundle.mobilePage;

        expect(mobile?.statusCode).toBe(200);
        expect(mobile?.h1).toEqual(['Mobile']);
        expect(mobile?.viewport).toBe(true);
        expect(mobile?.canonicalUrl).toBeNull();
        expect(mobile?.effectiveRobotsDirective).toBe('noindex, nofollow');
        expect(mobile?.structuredDataTypes).toContain('Product');
        expect(mobile?.internalLinkCount).toBe(2);
        expect(mobile?.wordCount).toBeGreaterThan(0);
        expect(mobile?.byteLength).toBe(new TextEncoder().encode(MOBILE_HTML).length);
        expect(mobile).not.toHaveProperty('body');
        expect(bundle.pagesSampled).toBe(1);
      },
    );
  });
});
