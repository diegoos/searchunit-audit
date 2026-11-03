import { describe, expect, test } from 'bun:test';
import { analyzeMeta } from '../src/tools/meta/analyzeMeta.ts';
import { parseMeta } from '../src/tools/meta/parseMeta.ts';
import type { CheckStatus } from '../src/lib/output.ts';

const GOOD_HTML = `<html lang="en">
  <head>
    <title>SearchUnit SEO and GEO audits for teams worldwide!!</title>
    <meta name="description" content="Discover how SearchUnit helps you improve your SEO and GEO visibility with deep audits and actionable insights for modern search engines and AI."/>
    <link rel="canonical" href="https://example.com/page"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <meta property="og:title" content="Best SEO Tool for Your Website"/>
    <meta property="og:description" content="Improve your SEO and GEO visibility."/>
    <meta property="og:image" content="https://example.com/og-image.jpg"/>
    <meta property="og:url" content="https://example.com/page"/>
    <meta property="og:type" content="website"/>
    <meta name="twitter:card" content="summary_large_image"/>
  </head>
</html>`;

const PAGE = 'https://example.com/page';

function checkOf(analysis: ReturnType<typeof analyzeMeta>, id: string) {
  return analysis.checks.find((check) => check.id === id);
}

describe('parseMeta', () => {
  test('extracts title, description, canonical, lang, og and twitter fields', () => {
    const tags = parseMeta(GOOD_HTML);

    expect(tags).toMatchObject({
      title: 'SearchUnit SEO and GEO audits for teams worldwide!!',
      canonical: PAGE,
      lang: 'en',
      ogTitle: 'Best SEO Tool for Your Website',
      ogImage: 'https://example.com/og-image.jpg',
      ogType: 'website',
      twitterCard: 'summary_large_image',
    });
    expect(tags.description?.startsWith('Discover how SearchUnit')).toBe(true);
    expect(tags.viewport).toContain('width=device-width');
    expect(tags.robotsMeta).toBeUndefined();
  });
  test('reads a bot-specific robots meta tag', () => {
    const tags = parseMeta(
      `<html><head><title>${'A'.repeat(55)}</title>
      <meta name="robots" content="index,follow"/>
      <meta name="Googlebot" content="noindex"/>
      </head></html>`,
    );

    expect(analyzeMeta(tags, PAGE).checks.find((check) => check.id === 'robots_meta')?.status).toBe(
      'fail',
    );
  });
});

describe('analyzeMeta', () => {
  test('a complete page passes with the full check list', () => {
    const analysis = analyzeMeta(parseMeta(GOOD_HTML), PAGE);

    expect(analysis.score).toBeGreaterThanOrEqual(80);
    expect(analysis.overallStatus).toBe('pass');
    expect(analysis.checks.map((check) => check.id)).toEqual([
      'title',
      'description',
      'canonical',
      'viewport',
      'lang',
      'robots_meta',
      'og_title',
      'og_description',
      'og_image',
      'og_url',
      'og_type',
      'twitter_card',
      'twitter_title',
      'twitter_description',
      'twitter_image',
    ]);
    expect(checkOf(analysis, 'title')?.status).toBe('pass');
    expect(checkOf(analysis, 'canonical')?.status).toBe('pass');
  });
  test.each<[string, Partial<ReturnType<typeof parseMeta>>, string, CheckStatus]>([
    ['a missing title', { title: undefined }, 'title', 'fail'],
    ['a noindex robots meta', { robotsMeta: 'noindex, nofollow' }, 'robots_meta', 'fail'],
    ['a none robots meta', { robotsMeta: 'none' }, 'robots_meta', 'fail'],
    ['a UA-prefixed noindex', { robotsMeta: 'googlebot: noindex' }, 'robots_meta', 'fail'],
    ['noindexifembedded', { robotsMeta: 'noindexifembedded' }, 'robots_meta', 'pass'],
    [
      'a canonical on another host',
      { canonical: 'https://other.example/page' },
      'canonical',
      'warn',
    ],
  ])('%s gives %s', (_name, over, id, status) => {
    const tags = { ...parseMeta(GOOD_HTML), ...over };

    expect(checkOf(analyzeMeta(tags, PAGE), id)?.status).toBe(status);
  });
  test.each([
    ['Hi', '2 chars'],
    ['A'.repeat(95), '95 chars'],
  ])('title %p fails and names the ideal 50–60 range', (title, sizeNote) => {
    const check = checkOf(
      analyzeMeta(parseMeta(`<html><head><title>${title}</title></head></html>`), PAGE),
      'title',
    );

    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain(sizeNote);
    expect(check?.detail).toContain('ideal 50–60');
  });
  test('twitter:image falls back to og:image', () => {
    const tags = { ...parseMeta(GOOD_HTML), twitterImage: undefined };
    const check = checkOf(analyzeMeta(tags, PAGE), 'twitter_image');

    expect(check).toMatchObject({
      status: 'pass',
      value: tags.ogImage,
      detail: 'falls back to og:image',
    });
  });
});
