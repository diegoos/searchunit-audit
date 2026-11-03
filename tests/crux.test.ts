import { describe, expect, spyOn, test } from 'bun:test';
import { runLocalDiscovery } from '../src/engine/discovery.ts';
import { computeAuditScores, type CriticalBlocker } from '../src/engine/scoring.ts';
import * as fetchModule from '../src/lib/fetch.ts';
import type { FetchOutcome } from '../src/lib/fetch.ts';
import * as pinnedModule from '../src/lib/pinnedFetch.ts';

const PAGE = 'https://example.com/product';

const HTML = `<html lang="en"><head><title>Product</title></head><body><main><h1>Product</h1><p>${'word '.repeat(200)}</p></main></body></html>`;

function page(url: string): FetchOutcome {
  return {
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    status: url === PAGE ? 200 : 404,
    contentType: 'text/html',
    body: url === PAGE ? HTML : 'missing',
    fetchedAt: '2026-10-01T00:00:00.000Z',
    headers: {},
    redirectChain: [url],
    responseTimeMs: 1,
  };
}

function cruxRecord(lcpP75: number): Record<string, unknown> {
  return {
    record: {
      metrics: {
        largest_contentful_paint: {
          histogram: [{ density: 0.5 }, { density: 0.3 }, { density: 0.2 }],
          percentiles: { p75: lcpP75 },
        },
        cumulative_layout_shift: {
          histogram: [{ density: 0.9 }, { density: 0.05 }, { density: 0.05 }],
          percentiles: { p75: '0.02' },
        },
      },
    },
  };
}

/** Runs discovery with CrUX stubbed at the network boundary (DNS pin and POST). */
async function withCrux(
  bodies: { url: Record<string, unknown>; origin: Record<string, unknown> },
  run: (posts: Record<string, string>[]) => Promise<void>,
): Promise<void> {
  const previous = process.env.CRUX_API_KEY;
  const posts: Record<string, string>[] = [];

  process.env.CRUX_API_KEY = 'test-key';
  const spies = [
    spyOn(fetchModule, 'fetchPublicUrl').mockImplementation(async (url: string) => page(url)),
    spyOn(fetchModule, 'resolvePublicHop').mockImplementation(async () => ({
      ok: true as const,
      pinnedAddress: '142.250.0.1',
      family: 4 as const,
    })),
    spyOn(pinnedModule, 'pinnedFetch').mockImplementation(async (_url, _address, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;

      posts.push(body);

      return new Response(JSON.stringify(body.url ? bodies.url : bodies.origin), { status: 200 });
    }),
  ];

  try {
    await run(posts);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }

    if (previous === undefined) {
      delete process.env.CRUX_API_KEY;
    } else {
      process.env.CRUX_API_KEY = previous;
    }
  }
}

describe('CrUX in discovery', () => {
  test('queries the audited URL and its origin, rates metrics, and scores with direct evidence', async () => {
    await withCrux({ url: cruxRecord(2000), origin: cruxRecord(5000) }, async (posts) => {
      const bundle = await runLocalDiscovery(PAGE);
      const result = bundle.crux.results[0];
      const technical = computeAuditScores(bundle).breakdown.find(
        (row) => row.component === 'technical_foundations',
      );

      expect(posts).toEqual([{ url: PAGE }, { origin: 'https://example.com' }]);
      expect(bundle.crux.status).toBe('completed');
      expect(bundle.auditScope.contextFetches.crux).toBe(true);
      expect(result?.status).toBe('ok');
      expect(result?.url_data?.metrics.largest_contentful_paint?.rating).toBe('good');
      expect(result?.origin_data?.metrics.largest_contentful_paint?.rating).toBe('poor');
      expect(technical?.evidence_type).toBe('direct');
    });
  });
  test('poor URL-level LCP caps the page; poor origin-only LCP does not', async () => {
    const blockersFor = async (url: Record<string, unknown>): Promise<string[]> => {
      let ids: string[] = [];

      await withCrux({ url, origin: cruxRecord(5000) }, async () => {
        const blockers: CriticalBlocker[] = [];

        computeAuditScores(await runLocalDiscovery(PAGE), blockers);
        ids = blockers.map((blocker) => blocker.id);
      });

      return ids;
    };
    expect(await blockersFor(cruxRecord(5000))).toContain('poor_core_web_vitals');
    expect(await blockersFor({})).not.toContain('poor_core_web_vitals');
  });
  test('a loopback page skips CrUX even with a key', async () => {
    await withCrux({ url: cruxRecord(2000), origin: cruxRecord(2000) }, async (posts) => {
      const spy = spyOn(fetchModule, 'fetchPublicUrl').mockImplementation(async (url: string) => ({
        ...page(PAGE),
        requestedUrl: url,
        finalUrl: 'http://localhost:3000/product',
      }));
      try {
        const bundle = await runLocalDiscovery('http://localhost:3000/product');

        expect(posts).toEqual([]);
        expect(bundle.crux.status).toBe('skipped');
        expect(bundle.auditScope.contextFetches.crux).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
