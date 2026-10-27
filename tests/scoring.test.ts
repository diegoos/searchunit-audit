import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import { citabilityWordCount } from '../src/engine/citabilityBlocks.ts';
import {
  LIVE_RETRIEVAL_BOTS,
  computeAuditScores,
  scoreCitabilityTexts,
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

    expect(scores.overall).toBe(54);
    expect(scores.breakdown.map((row) => row.component)).toEqual([
      'ai_citability_visibility',
      'content_quality',
      'technical_foundations',
      'structured_data',
      'platform_optimization',
    ]);
    expect(scores.label).toBe('Below Average');
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

    expect(geo.value).toBe(52);
    expect(geo.label).toBe('Below Average');
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
  test('a blocked Claude-SearchBot does not move overall or geo', () => {
    const allowed = bundleFromHtml(PAGE_HTML);
    const blocked = bundleFromHtml(PAGE_HTML);

    allowed.crawlerAccess = {
      ...allowed.crawlerAccess,
      crawlers: allowed.crawlerAccess.crawlers.map((crawler) => {
        return crawler.bot === 'Claude-SearchBot' ? { ...crawler, status: 'allowed' } : crawler;
      }),
    };
    blocked.crawlerAccess = {
      ...blocked.crawlerAccess,
      crawlers: blocked.crawlerAccess.crawlers.map((crawler) => {
        return crawler.bot === 'Claude-SearchBot' ? { ...crawler, status: 'blocked' } : crawler;
      }),
    };
    expect(
      blocked.crawlerAccess.crawlers.some((crawler) => crawler.bot === 'Claude-SearchBot'),
    ).toBe(true);
    const allowedScores = computeAuditScores(allowed);
    const blockedScores = computeAuditScores(blocked);
    const blockers: CriticalBlocker[] = [];

    computeAuditScores(blocked, blockers);
    expect(blockedScores.overall).toBe(allowedScores.overall);
    expect(blockedScores.overall).toBe(54);
    expect(scoreForKind('geo', blockedScores).value).toBe(scoreForKind('geo', allowedScores).value);
    expect(blockers.some((blocker) => blocker.id === 'live_retrieval_blocked')).toBe(false);
  });
  test('cli-facts names the same live retrieval bots the score gate uses', () => {
    const facts = readFileSync(
      new URL('../skills/searchunit-audit/references/cli-facts.md', import.meta.url),
      'utf8',
    );
    const section = facts.split('## Live retrieval bots')[1]?.split('\n## ')[0] ?? '';
    const bullets = [...section.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);

    expect(bullets.toSorted()).toEqual([...LIVE_RETRIEVAL_BOTS].toSorted());
  });
});

describe('scoreCitabilityTexts', () => {
  test('caps text at 1500 characters and keeps the 120 character preview', () => {
    const text = `${'alpha '.repeat(400)}`;
    const block = scoreCitabilityTexts([text]).blocks[0];

    expect(text.length).toBeGreaterThan(1500);
    expect(block?.text).toBe(text.slice(0, 1500));
    expect(block?.text).toHaveLength(1500);
    expect(block?.text_preview).toBe(text.slice(0, 120));
    expect(block?.text_preview).toHaveLength(120);
    expect(block?.word_count).toBe(citabilityWordCount(text));
    expect(scoreCitabilityTexts([text]).blocksTruncated).toBe(false);
  });
  test('keeps the full block text when the cap is infinite', () => {
    const text = `${'alpha '.repeat(400)}`;
    const block = scoreCitabilityTexts([text], Number.POSITIVE_INFINITY).blocks[0];

    expect(block?.text).toBe(text);
  });
  test('returns the highest scoring citability blocks first', () => {
    const weak = `${'word '.repeat(30)}`;
    const strong = `${'word '.repeat(40)} In 2024, according to our study, 12 percent stayed.`;
    const summary = scoreCitabilityTexts([weak, strong]);

    expect(summary.blocks[0]?.score).toBeGreaterThan(summary.blocks[1]?.score ?? 0);
    expect(summary.blocks[0]?.text).toContain('2024');
  });
  test('keeps the lowest scoring blocks beside the highest 12', () => {
    const text = Array.from({ length: 25 }, () => 'word').join(' ');
    const summary = scoreCitabilityTexts(Array.from({ length: 13 }, () => text));

    expect(summary.blocks).toHaveLength(12);
    expect(summary.weakBlocks).toHaveLength(1);
    expect(summary.blocksTruncated).toBe(false);
  });
  test('marks citability blocks truncated past the high and low lists', () => {
    const blocks = Array.from({ length: 25 }, (_, index) => {
      const marker = index === 0 ? 'In 2024, according to our study, 12 percent stayed.' : 'note';

      return `${marker} ${'word '.repeat(30 + index)}`;
    });
    const summary = scoreCitabilityTexts(blocks);

    expect(summary.blocks).toHaveLength(12);
    expect(summary.weakBlocks).toHaveLength(12);
    expect(summary.blocksTruncated).toBe(true);
    expect(summary.weakBlocks[0]?.score).toBeLessThanOrEqual(summary.weakBlocks[11]?.score ?? 0);
    expect(summary.blocks[0]?.score).toBeGreaterThanOrEqual(summary.weakBlocks[0]?.score ?? 0);
  });
});
