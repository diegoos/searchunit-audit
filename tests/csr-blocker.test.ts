import { describe, expect, test } from 'bun:test';
import { BLOCKERS_BY_KIND } from '../src/engine/findings.ts';
import { computeAuditScores, type CriticalBlocker } from '../src/engine/scoring.ts';
import { bundleFromHtml, cruxGoodFixture } from './engine-fixtures.ts';

const URL = 'https://example.com/app';

const SHELL_HTML = `<html><body><div id="root"></div>${'<script src="/a.js"></script>'.repeat(5)}</body></html>`;

function shellBundle() {
  const bundle = bundleFromHtml(SHELL_HTML);

  bundle.auditedUrl = URL;
  bundle.auditedPage.url = URL;
  bundle.crux = cruxGoodFixture(URL);

  return bundle;
}

function technicalScore(bundle: ReturnType<typeof shellBundle>): number | null | undefined {
  return computeAuditScores(bundle).breakdown.find(
    (row) => row.component === 'technical_foundations',
  )?.score;
}

describe('csr_only_rendering', () => {
  test('caps AI citability at 40 and is reported as a critical blocker', () => {
    const bundle = shellBundle();
    const blockers: CriticalBlocker[] = [];
    const scores = computeAuditScores(bundle, blockers);
    const citability = scores.breakdown.find((row) => row.component === 'ai_citability_visibility');

    expect(blockers).toContainEqual({
      id: 'csr_only_rendering',
      component: 'ai_citability_visibility',
      cap: 40,
    });
    expect(citability?.score).toBeLessThanOrEqual(40);
  });
  test('belongs to the GEO blockers, not the SEO blockers', () => {
    expect(BLOCKERS_BY_KIND.geo.has('csr_only_rendering')).toBe(true);
    expect(BLOCKERS_BY_KIND.seo.has('csr_only_rendering')).toBe(false);
  });
  test('does not cap technical foundations', () => {
    const shell = shellBundle();
    const notShell = shellBundle();

    notShell.auditedPage.jsRenderingRisk = { isLikelyCsr: false, reason: null };

    expect(technicalScore(shell)).toBe(technicalScore(notShell));
  });
});
