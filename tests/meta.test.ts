import { describe, expect, test } from 'bun:test';
import { analyzeMeta } from '../src/tools/meta/analyzeMeta.ts';
import { parseMeta } from '../src/tools/meta/parseMeta.ts';

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

describe('parseMeta', () => {
  test('extracts title description canonical og and twitter fields', () => {
    const tags = parseMeta(GOOD_HTML);

    expect(tags.title).toBe('SearchUnit SEO and GEO audits for teams worldwide!!');
    expect(tags.description?.startsWith('Discover how SearchUnit')).toBe(true);
    expect(tags.canonical).toBe('https://example.com/page');
    expect(tags.viewport).toContain('width=device-width');
    expect(tags.lang).toBe('en');
    expect(tags.ogTitle).toBe('Best SEO Tool for Your Website');
    expect(tags.ogImage).toBe('https://example.com/og-image.jpg');
    expect(tags.ogType).toBe('website');
    expect(tags.twitterCard).toBe('summary_large_image');
    expect(tags.robotsMeta).toBeUndefined();
  });
  test('returns undefined fields on empty HTML', () => {
    const tags = parseMeta('<html></html>');

    expect(tags.title).toBeUndefined();
    expect(tags.description).toBeUndefined();
    expect(tags.canonical).toBeUndefined();
  });
});

describe('analyzeMeta', () => {
  test('returns score overallStatus checks and tags for a complete page', () => {
    const tags = parseMeta(GOOD_HTML);
    const analysis = analyzeMeta(tags, 'https://example.com/page');

    expect(analysis.score).toBeGreaterThanOrEqual(80);
    expect(analysis.overallStatus).toBe('pass');
    expect(analysis.tags).toEqual(tags);
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
    expect(analysis.checks.find((check) => check.id === 'title')?.status).toBe('pass');
    expect(analysis.checks.find((check) => check.id === 'canonical')?.status).toBe('pass');
  });
  test('fails a missing title and a noindex robots meta', () => {
    const tags = parseMeta(GOOD_HTML);
    const missingTitle = analyzeMeta({ ...tags, title: undefined }, 'https://example.com/');

    expect(missingTitle.checks.find((check) => check.id === 'title')?.status).toBe('fail');
    expect(missingTitle.checks.find((check) => check.id === 'title')?.detail).toBe('missing');

    const noindex = analyzeMeta(
      { ...tags, robotsMeta: 'noindex, nofollow' },
      'https://example.com/',
    );
    expect(noindex.checks.find((check) => check.id === 'robots_meta')?.status).toBe('fail');
  });
  test('fails robots_meta for none and ignores noindexifembedded', () => {
    const tags = parseMeta(GOOD_HTML);
    const none = analyzeMeta({ ...tags, robotsMeta: 'none' }, 'https://example.com/');
    const embedded = analyzeMeta(
      { ...tags, robotsMeta: 'noindexifembedded' },
      'https://example.com/',
    );

    expect(none.checks.find((check) => check.id === 'robots_meta')?.status).toBe('fail');
    expect(embedded.checks.find((check) => check.id === 'robots_meta')?.status).toBe('pass');
  });
  test('fails robots_meta for UA-prefixed noindex', () => {
    const tags = parseMeta(GOOD_HTML);
    const analysis = analyzeMeta(
      { ...tags, robotsMeta: 'googlebot: noindex' },
      'https://example.com/',
    );

    expect(analysis.checks.find((check) => check.id === 'robots_meta')?.status).toBe('fail');
  });
  test('fails a title outside the warn band', () => {
    const tags = parseMeta(GOOD_HTML);
    const analysis = analyzeMeta({ ...tags, title: 'Hi' }, 'https://example.com/');

    expect(analysis.checks.find((check) => check.id === 'title')?.status).toBe('fail');
    expect(analysis.checks.find((check) => check.id === 'title')?.detail).toContain('2 chars');
    expect(analysis.checks.find((check) => check.id === 'title')?.detail).toContain('ideal 50–60');
  });
  test('warns when canonical is on another host', () => {
    const tags = parseMeta(GOOD_HTML);
    const analysis = analyzeMeta(
      { ...tags, canonical: 'https://other.example/page' },
      'https://example.com/page',
    );
    expect(analysis.checks.find((check) => check.id === 'canonical')?.status).toBe('warn');
  });
  test('falls back to og:image for twitter:image', () => {
    const tags = parseMeta(GOOD_HTML);
    const analysis = analyzeMeta({ ...tags, twitterImage: undefined }, 'https://example.com/page');
    const check = analysis.checks.find((row) => row.id === 'twitter_image');

    expect(check?.status).toBe('pass');
    expect(check?.value).toBe(tags.ogImage);
    expect(check?.detail).toBe('falls back to og:image');
  });
  test('fails robots_meta when Googlebot is noindex', () => {
    const tags = parseMeta(
      `<html><head><title>${'A'.repeat(55)}</title>
      <meta name="description" content="${'d'.repeat(140)}"/>
      <link rel="canonical" href="https://example.com/page"/>
      <meta name="robots" content="index,follow"/>
      <meta name="Googlebot" content="noindex"/>
      <meta name="viewport" content="width=device-width"/>
      <meta property="og:title" content="t"/><meta property="og:description" content="d"/>
      <meta property="og:image" content="https://example.com/i.jpg"/>
      </head></html>`,
    );
    const analysis = analyzeMeta(tags, 'https://example.com/page');

    expect(analysis.checks.find((check) => check.id === 'robots_meta')?.status).toBe('fail');
  });
  test('meta title detail includes the ideal range when over the limit', () => {
    const analysis = analyzeMeta(
      parseMeta(`<html><head><title>${'A'.repeat(95)}</title></head></html>`),
      'https://example.com/',
    );
    const title = analysis.checks.find((check) => check.id === 'title');

    expect(title?.status).toBe('fail');
    expect(title?.detail).toContain('95 chars');
    expect(title?.detail).toContain('ideal 50–60');
  });
});
