import { describe, expect, test } from 'bun:test';
import { auditedBodySha256 } from '../src/engine/discovery.ts';
import { discoveryForReport } from '../src/engine/report.ts';
import { computeAuditScores } from '../src/engine/scoring.ts';
import { PAGE_HTML, bundleFromHtml } from './engine-fixtures.ts';

describe('discoveryForReport', () => {
  test('drops fetch-only fields', () => {
    const discovery = discoveryForReport(bundleFromHtml(PAGE_HTML));

    expect(discovery.auditedUrl).toBe('https://example.com/');

    expect(discovery.domain).toBe('example.com');
    expect('pageHeaders' in discovery).toBe(false);
    expect('parsedRobots' in discovery).toBe(false);
    expect(discovery.llmsTxt.content).toBeNull();
    expect(discovery.llmsTxt.full_content).toBeNull();
    expect(discovery.llmsTxt.links).toEqual([]);
    expect(discovery.llmsTxt.linksTruncated).toBe(false);
    expect(discovery.sitemap.urlsTruncated).toBe(false);
    expect(discovery.mobilePage).toBeNull();
    expect(discovery.crawlerAccess.wildcardRules).toEqual({ allow: ['/'], disallow: [] });
    expect(discovery.pagesSampled).toBe(1);
    expect(discovery.auditedPage.bodySha256).toBe(auditedBodySha256(PAGE_HTML));
  });
  test('body hash is the UTF-8 SHA-256 of the html and does not change scores', () => {
    expect(auditedBodySha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );

    const bundle = bundleFromHtml(PAGE_HTML);
    const before = computeAuditScores(bundle);

    bundle.auditedPage.bodySha256 = '0'.repeat(64);
    const after = computeAuditScores(bundle);

    expect(after.overall).toBe(before.overall);
    expect(after.breakdown).toEqual(before.breakdown);
  });
});
