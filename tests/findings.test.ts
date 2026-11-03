import { describe, expect, test } from 'bun:test';
import { auditThresholdStatus, kindExtras, kindThresholdStatus } from '../src/engine/findings.ts';
import { findingGroupLabel, groupFindings } from '../src/render/audit.ts';
import type { CriticalBlocker } from '../src/engine/scoring.ts';
import type { Finding } from '../src/engine/types.ts';
import { bundleFromHtml } from './engine-fixtures.ts';

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'x',
    source: 'meta',
    severity: 'pass',
    title: 't',
    detail: 'd',
    ...over,
  };
}

const NO_HTTPS: CriticalBlocker = { id: 'no_https', component: 'technical_foundations', cap: 40 };
const LIVE_BLOCKED: CriticalBlocker = {
  id: 'live_retrieval_blocked',
  component: 'ai_citability_visibility',
  cap: 30,
};

describe('content H1', () => {
  test('an H1 element with no text is a warning, and no H1 element is a failure', () => {
    const empty = bundleFromHtml('<html><body><h1> </h1><p>Some words here.</p></body></html>');
    const absent = bundleFromHtml('<html><body><p>Some words here.</p></body></html>');

    expect(empty.auditedPage.headings.h1ElementCount).toBe(1);
    expect(empty.auditedPage.headings.h1Count).toBe(0);
    expect(kindExtras('seo', empty).find((item) => item.id === 'content:h1')).toMatchObject({
      severity: 'warn',
      detail: 'H1 element with no text',
    });
    expect(absent.auditedPage.headings.h1ElementCount).toBe(0);
    expect(kindExtras('seo', absent).find((item) => item.id === 'content:h1')).toMatchObject({
      severity: 'fail',
      detail: 'missing',
    });
  });
});

describe('finding groups', () => {
  test.each([
    ['schema:Organization', 'Schema'],
    ['critical-blocker', 'Critical blockers'],
    ['crawlers', 'Crawlers'],
  ])('findingGroupLabel maps %p to %p', (source, heading) => {
    expect(findingGroupLabel(source)).toBe(heading);
  });
  test('groupFindings buckets consecutive sources', () => {
    const groups = groupFindings([
      finding({ id: 'a', source: 'meta' }),
      finding({ id: 'b', source: 'meta', severity: 'warn' }),
      finding({ id: 'c', source: 'schema', severity: 'fail' }),
    ]);

    expect(groups.map((group) => [group.heading, group.findings.length])).toEqual([
      ['Meta', 2],
      ['Schema', 1],
    ]);
  });
  test('groupFindings splits schema blocks and names them by type', () => {
    const groups = groupFindings([
      finding({ source: 'schema:0', title: 'valid_json', detail: 'valid' }),
      finding({ source: 'schema:0', title: 'type', detail: 'CollectionPage' }),
      finding({ source: 'schema:1', title: 'valid_json', detail: 'JSON-LD node is not an object' }),
    ]);

    expect(groups.map((group) => [group.heading, group.findings.length])).toEqual([
      ['Schema: CollectionPage', 2],
      ['Schema', 1],
    ]);
  });
});

describe('--fail-on thresholds', () => {
  test.each<[string, CriticalBlocker[], Finding[], ReturnType<typeof auditThresholdStatus>]>([
    ['audit: no findings', [], [], 'pass'],
    [
      'audit: advisory tool fail is ignored',
      [],
      [finding({ source: 'meta', severity: 'fail' })],
      'pass',
    ],
    [
      'audit: discovery info is ignored',
      [],
      [finding({ source: 'discovery', severity: 'info' })],
      'pass',
    ],
    ['audit: discovery warn', [], [finding({ source: 'discovery', severity: 'warn' })], 'warn'],
    [
      'audit: critical blocker',
      [NO_HTTPS],
      [finding({ source: 'discovery', severity: 'pass' })],
      'fail',
    ],
  ])('%s', (_name, blockers, findings, status) => {
    expect(auditThresholdStatus(blockers, findings)).toBe(status);
  });
  test.each<
    [string, 'seo' | 'geo', CriticalBlocker[], Finding[], ReturnType<typeof kindThresholdStatus>]
  >([
    [
      'seo ignores geo blockers and llms discovery',
      'seo',
      [LIVE_BLOCKED],
      [finding({ source: 'discovery', id: 'discovery:llms', severity: 'warn' })],
      'pass',
    ],
    [
      'seo fails on a technical blocker',
      'seo',
      [NO_HTTPS],
      [finding({ source: 'discovery', id: 'discovery:robots', severity: 'pass' })],
      'fail',
    ],
    [
      'seo warns on its own discovery warn',
      'seo',
      [],
      [finding({ source: 'discovery', id: 'discovery:robots', severity: 'warn' })],
      'warn',
    ],
    [
      'geo ignores seo blockers and sitemap discovery',
      'geo',
      [NO_HTTPS],
      [finding({ source: 'discovery', id: 'discovery:sitemap', severity: 'warn' })],
      'pass',
    ],
    ['geo fails on a live retrieval blocker', 'geo', [LIVE_BLOCKED], [], 'fail'],
  ])('kind: %s', (_name, kind, blockers, findings, status) => {
    expect(kindThresholdStatus(kind, blockers, findings)).toBe(status);
  });
});
