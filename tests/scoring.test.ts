import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import {
  computeAuditScores,
  scoreForKind,
  scoreLabel,
  type CriticalBlocker,
} from '../src/engine/scoring.ts';
import { PAGE_HTML, bundleFromHtml } from './engine-fixtures.ts';

describe('scoreLabel', () => {
  test('maps the published score bands', () => {
    expect(scoreLabel(null)).toBeNull();
    expect(scoreLabel(85)).toBe('Excellent');
    expect(scoreLabel(70)).toBe('Good');
    expect(scoreLabel(55)).toBe('Moderate');
    expect(scoreLabel(40)).toBe('Below Average');
    expect(scoreLabel(39)).toBe('Needs Attention');
  });
});

describe('computeAuditScores', () => {
  test('scores the PAGE_HTML fixture with known overall and labels', () => {
    const scores = computeAuditScores(bundleFromHtml(PAGE_HTML));

    expect(scores.overall).toBe(67);
    expect(scores.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'content_quality',
      'technical_foundations',
      'structured_data',
      'platform_optimization',
    ]);
    expect(scores.label).toBe('Moderate');
    expect(scores.confidence).toBe('low');
  });
  test('CrUX without Search Console yields medium confidence, never high', () => {
    const bundle = bundleFromHtml(PAGE_HTML);

    bundle.crux = {
      status: 'completed',
      errors: [],
      results: [
        {
          url: bundle.auditedUrl,
          origin: 'https://example.com',
          status: 'ok',
          url_data: { cwv_pass: true, metrics: {} },
          origin_data: null,
          errors: [],
        },
      ],
    };
    expect(computeAuditScores(bundle).confidence).toBe('medium');
  });
  test('HTML over 2 MiB is an oversized_html blocker', () => {
    const atCap = bundleFromHtml(PAGE_HTML);

    atCap.auditedPage.byteLength = DEFAULT_MAX_BODY_BYTES;
    const atCapBlockers: CriticalBlocker[] = [];

    computeAuditScores(atCap, atCapBlockers);
    expect(atCapBlockers.map((blocker) => blocker.id)).not.toContain('oversized_html');

    const over = bundleFromHtml(PAGE_HTML);

    over.auditedPage.byteLength = DEFAULT_MAX_BODY_BYTES + 1;
    const overBlockers: CriticalBlocker[] = [];

    computeAuditScores(over, overBlockers);
    expect(overBlockers).toContainEqual({
      id: 'oversized_html',
      component: 'technical_foundations',
      cap: 60,
    });
  });
});

describe('scoreForKind', () => {
  test('geo uses citability and platform components from PAGE_HTML', () => {
    const geo = scoreForKind('geo', computeAuditScores(bundleFromHtml(PAGE_HTML)));

    expect(geo.value).toBe(65);
    expect(geo.label).toBe('Moderate');
    expect(geo.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'platform_optimization',
    ]);
  });
  test('seo uses content technical and structured components from PAGE_HTML', () => {
    const seo = scoreForKind('seo', computeAuditScores(bundleFromHtml(PAGE_HTML)));

    expect(seo.value).toBeGreaterThan(0);
    expect(seo.value).not.toBe(computeAuditScores(bundleFromHtml(PAGE_HTML)).overall);
    expect(seo.breakdown.map((row) => row.component)).toEqual([
      'content_quality',
      'technical_foundations',
      'structured_data',
    ]);
  });
});
