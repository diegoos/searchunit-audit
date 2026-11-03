import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import type { ScoreLabel } from '../src/engine/types.ts';
import { citabilityWordCount } from '../src/engine/citabilityBlocks.ts';
import {
  computeAuditScores,
  scoreCitabilityTexts,
  scoreForKind,
  scoreLabel,
  type CriticalBlocker,
} from '../src/engine/scoring.ts';
import { PAGE_HTML, bundleFromHtml } from './engine-fixtures.ts';

describe('scoreLabel', () => {
  test.each<[number | null, ScoreLabel | null]>([
    [null, null],
    [85, 'Excellent'],
    [70, 'Good'],
    [55, 'Moderate'],
    [40, 'Below Average'],
    [39, 'Needs Attention'],
  ])('maps %p to %p', (value, label) => {
    expect(scoreLabel(value)).toBe(label);
  });
});

describe('computeAuditScores', () => {
  test('scores the PAGE_HTML fixture with known values', () => {
    const scores = computeAuditScores(bundleFromHtml(PAGE_HTML));

    expect(scores.overall).toBe(54);
    expect(scores.label).toBe('Below Average');
    expect(scores.confidence).toBe('low');
    expect(scores.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'content_quality',
      'technical_foundations',
      'structured_data',
      'platform_optimization',
    ]);
  });
  test('CrUX field data without Search Console caps confidence at medium', () => {
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
  test.each([
    [DEFAULT_MAX_BODY_BYTES, false],
    [DEFAULT_MAX_BODY_BYTES + 1, true],
  ])('HTML of %p bytes gives oversized_html blocker: %p', (byteLength, blocked) => {
    const bundle = bundleFromHtml(PAGE_HTML);
    const blockers: CriticalBlocker[] = [];

    bundle.auditedPage.byteLength = byteLength;
    computeAuditScores(bundle, blockers);

    const oversized = blockers.find((blocker) => blocker.id === 'oversized_html');

    expect(oversized !== undefined).toBe(blocked);

    if (blocked) {
      expect(oversized).toEqual({
        id: 'oversized_html',
        component: 'technical_foundations',
        cap: 60,
      });
    }
  });
});

describe('scoreForKind', () => {
  test('geo uses citability and platform components from PAGE_HTML', () => {
    const geo = scoreForKind('geo', computeAuditScores(bundleFromHtml(PAGE_HTML)));

    expect(geo.value).toBe(52);
    expect(geo.label).toBe('Below Average');
    expect(geo.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'platform_optimization',
    ]);
  });
  test('seo uses content, technical and structured components from PAGE_HTML', () => {
    const seo = scoreForKind('seo', computeAuditScores(bundleFromHtml(PAGE_HTML)));

    expect(seo.value).toBe(56);
    expect(seo.breakdown.map((row) => row.component)).toEqual([
      'content_quality',
      'technical_foundations',
      'structured_data',
    ]);
  });
  test('a blocked Claude-SearchBot does not move overall or geo', () => {
    const allowed = bundleFromHtml(PAGE_HTML);
    const blocked = bundleFromHtml(PAGE_HTML);
    const setStatus = (bundle: typeof allowed, status: 'allowed' | 'blocked') => {
      bundle.crawlerAccess = {
        ...bundle.crawlerAccess,
        crawlers: bundle.crawlerAccess.crawlers.map((crawler) =>
          crawler.bot === 'Claude-SearchBot' ? { ...crawler, status } : crawler,
        ),
      };
    };
    const blockers: CriticalBlocker[] = [];

    setStatus(allowed, 'allowed');
    setStatus(blocked, 'blocked');

    const allowedScores = computeAuditScores(allowed);
    const blockedScores = computeAuditScores(blocked, blockers);

    expect(blockedScores.overall).toBe(54);
    expect(blockedScores.overall).toBe(allowedScores.overall);
    expect(scoreForKind('geo', blockedScores).value).toBe(scoreForKind('geo', allowedScores).value);
    expect(blockers.some((blocker) => blocker.id === 'live_retrieval_blocked')).toBe(false);
  });
});

describe('scoreCitabilityTexts', () => {
  test('caps block text at 1500 characters and keeps a 120 character preview', () => {
    const text = 'alpha '.repeat(400);
    const summary = scoreCitabilityTexts([text]);
    const block = summary.blocks[0];

    expect(text.length).toBeGreaterThan(1500);
    expect(block?.text).toBe(text.slice(0, 1500));
    expect(block?.text_preview).toBe(text.slice(0, 120));
    expect(block?.word_count).toBe(citabilityWordCount(text));
    expect(summary.blocksTruncated).toBe(false);
  });
  test('keeps the full block text when the cap is infinite', () => {
    const text = 'alpha '.repeat(400);

    expect(scoreCitabilityTexts([text], Number.POSITIVE_INFINITY).blocks[0]?.text).toBe(text);
  });
  test('ranks the highest scoring block first', () => {
    const weak = 'word '.repeat(30);
    const strong = `${'word '.repeat(40)} In 2024, according to our study, 12 percent stayed.`;
    const summary = scoreCitabilityTexts([weak, strong]);

    expect(summary.blocks[0]?.text).toContain('2024');
    expect(summary.blocks[0]?.score).toBeGreaterThan(summary.blocks[1]?.score ?? 0);
  });
  test('keeps 12 high and 12 low blocks, and marks truncation only past both lists', () => {
    const uniform = Array.from({ length: 13 }, () => 'word '.repeat(25));
    const small = scoreCitabilityTexts(uniform);

    expect(small.blocks).toHaveLength(12);
    expect(small.weakBlocks).toHaveLength(1);
    expect(small.blocksTruncated).toBe(false);

    const varied = Array.from({ length: 25 }, (_, index) => {
      const marker = index === 0 ? 'In 2024, according to our study, 12 percent stayed.' : 'note';

      return `${marker} ${'word '.repeat(30 + index)}`;
    });
    const large = scoreCitabilityTexts(varied);

    expect(large.blocks).toHaveLength(12);
    expect(large.weakBlocks).toHaveLength(12);
    expect(large.blocksTruncated).toBe(true);
    expect(large.blocks[0]?.score).toBeGreaterThanOrEqual(large.weakBlocks[0]?.score ?? 0);
  });
});
