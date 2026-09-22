import { describe, expect, test, beforeAll } from 'bun:test';
import chalk from 'chalk';
import { googleProfileFromAuditedUrl } from '../src/lib/googleProfile.ts';
import { buildAuditReport, buildKindReport } from '../src/engine/report.ts';
import { renderAudit, renderKindReport } from '../src/render/audit.ts';
import { computeAuditScores, scoreForKind } from '../src/engine/scoring.ts';
import { PAGE_HTML, bundleFromHtml } from './engine-fixtures.ts';

beforeAll(() => {
  chalk.level = 0;
});

describe('kind reports', () => {
  test('geo-check headline is kindScores.geo, not overall', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const audit = buildAuditReport(bundle);
    const geo = buildKindReport(bundle, 'geo-check', 'geo');
    const expected = scoreForKind('geo', computeAuditScores(bundle));

    expect(geo.command).toBe('geo-check');
    expect(geo.kind).toBe('geo');
    expect(geo.scores.overall).toBe(expected.value ?? 0);
    expect(geo.scores.overall).not.toBe(audit.scores.overall);
    expect(geo.scores.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'platform_optimization',
    ]);
  });
  test('seo-check headline is kindScores.seo and omits brand and llms', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const seo = buildKindReport(bundle, 'seo-check', 'seo');
    const expected = scoreForKind('seo', computeAuditScores(bundle));

    expect(seo.command).toBe('seo-check');
    expect(seo.scores.overall).toBe(expected.value ?? 0);
    expect(seo.findings.some((f) => f.source === 'brand')).toBe(false);
    expect(seo.findings.some((f) => f.source === 'llms' || f.id === 'discovery:llms')).toBe(false);
    expect(seo.findings.some((f) => f.source === 'meta')).toBe(true);
    expect(seo.findings.some((f) => f.source === 'content')).toBe(true);
    expect(seo.findings.some((f) => f.id === 'content:h1')).toBe(true);
    expect(seo.findings.some((f) => f.source === 'discover')).toBe(true);
  });
  test('geo-check omits meta and CSP and adds citability and crawlers', () => {
    const geo = buildKindReport(bundleFromHtml(PAGE_HTML), 'geo-check', 'geo');

    expect(geo.findings.some((f) => f.source === 'meta')).toBe(false);
    expect(geo.findings.some((f) => f.source === 'security-headers')).toBe(false);
    expect(geo.findings.some((f) => f.source === 'citability')).toBe(true);
    expect(geo.findings.some((f) => f.source === 'crawlers')).toBe(true);
    expect(geo.findings.some((f) => f.source === 'brand')).toBe(false);
  });
  test('kind markdown has no Kind scores table', () => {
    const geo = buildKindReport(bundleFromHtml(PAGE_HTML), 'geo-check', 'geo');
    const markdown = renderKindReport(geo, 'markdown');
    const table = renderKindReport(geo, 'table');

    expect(markdown).toContain('# GEO Check');
    expect(markdown).not.toContain('## Kind scores');
    expect(markdown).toContain('Citability');
    expect(markdown).toContain('## Crawlers');
    expect(table).toContain('GEO Check');
    expect(table).not.toContain('Kind scores');
    expect(table).toContain('Googlebot');
    expect(table).not.toContain('content-security-policy');
    expect([...table.matchAll(/Crawlers/g)].length).toBe(1);
    expect([...markdown.matchAll(/## Crawlers/g)].length).toBe(1);

    const seo = renderKindReport(
      buildKindReport(bundleFromHtml(PAGE_HTML), 'seo-check', 'seo'),
      'markdown',
    );

    expect(seo).toContain('# SEO Check');
    expect(seo).toContain('## Meta');
    expect(seo).not.toContain('## Brand');
    expect(seo).not.toContain('## llms.txt');
    expect(seo).not.toContain('## Crawlers');
  });
  test('audit embeds seo-check, geo-check, and google-profile', () => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const audit = buildAuditReport(bundle);
    const seo = buildKindReport(bundle, 'seo-check', 'seo');
    const geo = buildKindReport(bundle, 'geo-check', 'geo');

    expect(audit.seo.scores.overall).toBe(seo.scores.overall);
    expect(audit.geo.scores.overall).toBe(geo.scores.overall);
    expect(audit.seo.findings.map((f) => f.id)).toEqual(seo.findings.map((f) => f.id));
    expect(audit.geo.findings.map((f) => f.id)).toEqual(geo.findings.map((f) => f.id));
    expect(audit.googleProfile.domain).toBe('example.com');
    expect(audit.findings.some((f) => f.id === 'content:h1')).toBe(true);
    expect(audit.findings.some((f) => f.source === 'citability')).toBe(true);

    const table = renderAudit(audit, 'table');

    expect(table).toContain('SEO Check');
    expect(table).toContain('GEO Check');
    expect(table).toContain('Google Profile');
    expect(table).toContain(audit.googleProfile.profileUrl);
  });
  test('audit google profile matches google-profile host (www preserved)', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.domain = 'example.com';
    bundle.auditedUrl = 'https://www.example.com/';

    const audit = buildAuditReport(bundle);

    expect(audit.googleProfile).toEqual(googleProfileFromAuditedUrl(bundle.auditedUrl));
  });
  test('audit and kind reports say whether CRUX_API_KEY is set', () => {
    const previous = process.env.CRUX_API_KEY;

    delete process.env.CRUX_API_KEY;

    try {
      const missing = buildAuditReport(bundleFromHtml(PAGE_HTML));

      expect(missing.cruxApiKeyAvailable).toBe(false);
      expect(renderAudit(missing, 'markdown')).toContain('CRUX_API_KEY missing');
      process.env.CRUX_API_KEY = 'test-key';

      const audit = buildAuditReport(bundleFromHtml(PAGE_HTML));
      const seo = buildKindReport(bundleFromHtml(PAGE_HTML), 'seo-check', 'seo');

      expect(audit.cruxApiKeyAvailable).toBe(true);
      expect(seo.cruxApiKeyAvailable).toBe(true);
      expect(renderAudit(audit, 'table')).toContain('CRUX_API_KEY available');
      expect(renderKindReport(seo, 'html')).toContain('CRUX_API_KEY available');
    } finally {
      if (previous === undefined) {
        delete process.env.CRUX_API_KEY;
      } else {
        process.env.CRUX_API_KEY = previous;
      }
    }
  });
});
