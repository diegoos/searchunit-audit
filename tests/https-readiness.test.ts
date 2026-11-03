import { describe, expect, test } from 'bun:test';
import type { DiscoveryBundle } from '../src/engine/discovery.ts';
import { collectFindings } from '../src/engine/findings.ts';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { httpsReadinessOfPage } from '../src/engine/httpsReadiness.ts';
import { computeAuditScores } from '../src/engine/scoring.ts';
import { bundleFromHtml, cruxGoodFixture, PAGE_HTML } from './engine-fixtures.ts';

const LOOPBACK = 'http://localhost:3000/x';

function bundleOn(html: string, url: string): DiscoveryBundle {
  const bundle = bundleFromHtml(html);
  const parsed = parseHtmlPage(html, url);

  bundle.auditedUrl = url;
  bundle.auditedPage.url = url;
  bundle.auditedPage.mixedContent = parsed.mixedContent;
  bundle.httpsReadiness = httpsReadinessOfPage(url, parsed);

  return bundle;
}

function componentScore(bundle: DiscoveryBundle, component: string): number | null | undefined {
  return computeAuditScores(bundle).breakdown.find((row) => row.component === component)?.score;
}

function httpsFinding(html: string, url: string) {
  return collectFindings(bundleOn(html, url), []).find(
    (finding) => finding.id === 'discovery:https',
  );
}

const READINESS_HTML = `<html><head>
  <link rel="canonical" href="http://example.com/x">
  <meta property="og:url" content="http://localhost:3000/x">
  <script src="http://cdn.example/app.js"></script>
  <img src="http://cdn.example/a.png">
</head><body><h1>Dev</h1></body></html>`;

describe('loopback E-E-A-T', () => {
  test('content quality on loopback equals the same page on https', () => {
    const https = bundleFromHtml(PAGE_HTML);
    const loopback = bundleFromHtml(PAGE_HTML);

    loopback.auditedPage.url = LOOPBACK;

    expect(componentScore(loopback, 'content_quality')).toBe(
      componentScore(https, 'content_quality'),
    );
  });
});

describe('loopback HSTS', () => {
  test('technical score ignores HSTS on loopback', () => {
    const headers = { csp: true, x_frame: true, x_content_type: true, referrer_policy: true };
    const withoutHsts = bundleFromHtml(PAGE_HTML);
    const withHsts = bundleFromHtml(PAGE_HTML);

    for (const bundle of [withoutHsts, withHsts]) {
      bundle.auditedPage.url = LOOPBACK;
      bundle.crux = cruxGoodFixture(LOOPBACK);
      bundle.securityHeaders = { ...bundle.securityHeaders, ...headers, x_robots_tag: null };
    }

    withoutHsts.securityHeaders.hsts = false;
    withHsts.securityHeaders.hsts = true;

    expect(componentScore(withoutHsts, 'technical_foundations')).toBe(
      componentScore(withHsts, 'technical_foundations'),
    );
  });
  test('the HSTS security finding is info on loopback and judged on https', () => {
    const loopback = collectFindings(bundleOn(PAGE_HTML, LOOPBACK), []).find(
      (finding) => finding.id === 'security:strict-transport-security',
    );
    const https = collectFindings(bundleFromHtml(PAGE_HTML), []).find(
      (finding) => finding.id === 'security:strict-transport-security',
    );

    expect(loopback).toMatchObject({
      severity: 'info',
      detail: 'not judged on a loopback URL',
    });
    expect(https?.severity).toBe('warn');
  });
});

describe('httpsReadinessOfPage', () => {
  test('lists active insecure subresources, insecure URLs and dev-host URLs', () => {
    const readiness = httpsReadinessOfPage(LOOPBACK, parseHtmlPage(READINESS_HTML, LOOPBACK));

    expect(readiness).toEqual({
      insecureSubresources: ['http://cdn.example/app.js', 'http://cdn.example/a.png'],
      insecureUrls: [{ field: 'canonical', url: 'http://example.com/x' }],
      devHostUrls: [{ field: 'og:url', url: 'http://localhost:3000/x' }],
    });
  });
  test('checks JSON-LD url and @id fields', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Organization","url":"http://example.com","@id":"http://localhost:3000/#org"}
    </script></head><body></body></html>`;
    const readiness = httpsReadinessOfPage(LOOPBACK, parseHtmlPage(html, LOOPBACK));

    expect(readiness?.insecureUrls).toEqual([{ field: 'jsonld.url', url: 'http://example.com' }]);

    expect(readiness?.devHostUrls).toEqual([
      { field: 'jsonld.@id', url: 'http://localhost:3000/#org' },
    ]);
  });
  test('is null for a non-loopback URL', () => {
    const url = 'https://example.com/x';

    expect(httpsReadinessOfPage(url, parseHtmlPage(READINESS_HTML, url))).toBeNull();
  });
  test('an http subresource on a plain http page is not mixed content', () => {
    const parsed = parseHtmlPage(READINESS_HTML, 'http://example.com/x');

    expect(parsed.mixedContent.activeCount).toBe(0);
    expect(parsed.mixedContent.passiveCount).toBe(0);
  });
});

describe('discovery:https severity on loopback', () => {
  test.each([
    ['an active http subresource', '<script src="http://cdn.example/app.js"></script>', 'warn'],
    ['an insecure canonical', '<link rel="canonical" href="http://example.com/x">', 'warn'],
    ['only a passive http image', '<img src="http://cdn.example/a.png">', 'info'],
    [
      'only a dev-host og:url',
      '<meta property="og:url" content="http://localhost:3000/x">',
      'info',
    ],
    ['no http reference', '<h1>Dev</h1>', 'pass'],
  ])('%s gives %s', (_name, markup, severity) => {
    const html = `<html><head></head><body>${markup}<h1>Dev</h1></body></html>`;

    expect(httpsFinding(html, LOOPBACK)).toMatchObject({ severity });
  });
  test('https pages keep the plain info note', () => {
    expect(httpsFinding(PAGE_HTML, 'https://example.com/')).toMatchObject({
      severity: 'info',
      detail: 'checked on the audited URL',
    });
  });
});
