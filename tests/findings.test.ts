import { describe, expect, test } from 'bun:test';
import { findingGroupLabel, groupFindings } from '../src/render/audit.ts';
import { auditThresholdStatus, kindThresholdStatus } from '../src/engine/findings.ts';
import type { Finding } from '../src/engine/types.ts';

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

describe('finding groups', () => {
  test('findingGroupLabel maps sources to headings', () => {
    expect(findingGroupLabel('schema:Organization')).toBe('Schema');
    expect(findingGroupLabel('critical-blocker')).toBe('Critical blockers');
    expect(findingGroupLabel('security-headers')).toBe('Security headers');
    expect(findingGroupLabel('llms-full')).toBe('llms-full.txt');
    expect(findingGroupLabel('llms')).toBe('llms.txt');
    expect(findingGroupLabel('crawlers')).toBe('Crawlers');
    expect(findingGroupLabel('citability')).toBe('Citability');
    expect(findingGroupLabel('content')).toBe('Content');
  });
  test('groupFindings buckets consecutive sources', () => {
    const groups = groupFindings([
      finding({ id: 'a', source: 'meta', severity: 'pass', title: 'A', detail: 'a' }),
      finding({ id: 'b', source: 'meta', severity: 'warn', title: 'B', detail: 'b' }),
      finding({ id: 'c', source: 'schema', severity: 'fail', title: 'C', detail: 'c' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.heading).toBe('Meta');
    expect(groups[0]?.findings).toHaveLength(2);
    expect(groups[1]?.heading).toBe('Schema');
  });
  test('groupFindings splits schema blocks and names them by type', () => {
    const groups = groupFindings([
      finding({ source: 'schema:0', title: 'valid_json', detail: 'valid' }),
      finding({ source: 'schema:0', title: 'type', detail: 'CollectionPage' }),
      finding({ source: 'schema:1', title: 'valid_json', detail: 'JSON-LD node is not an object' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.heading).toBe('Schema: CollectionPage');
    expect(groups[0]?.findings).toHaveLength(2);
    expect(groups[1]?.heading).toBe('Schema');
    expect(groups[1]?.findings).toHaveLength(1);
  });
});

describe('audit --fail-on', () => {
  test('keys off blockers and discovery findings, not advisory tool fails', () => {
    expect(auditThresholdStatus([], [])).toBe('pass');
    expect(auditThresholdStatus([], [finding({ source: 'meta', severity: 'fail' })])).toBe('pass');
    expect(auditThresholdStatus([], [finding({ source: 'discovery', severity: 'info' })])).toBe(
      'pass',
    );
    expect(auditThresholdStatus([], [finding({ source: 'discovery', severity: 'warn' })])).toBe(
      'warn',
    );
    expect(
      auditThresholdStatus(
        [{ id: 'no_https', component: 'technical_foundations', cap: 40 }],
        [finding({ source: 'discovery', severity: 'pass' })],
      ),
    ).toBe('fail');
  });
});

describe('kind --fail-on', () => {
  test('seo ignores geo blockers and llms discovery', () => {
    expect(
      kindThresholdStatus(
        'seo',
        [{ id: 'live_retrieval_blocked', component: 'ai_citability_visibility', cap: 30 }],
        [finding({ source: 'discovery', id: 'discovery:llms', severity: 'warn' })],
      ),
    ).toBe('pass');
    expect(
      kindThresholdStatus(
        'seo',
        [{ id: 'no_https', component: 'technical_foundations', cap: 40 }],
        [finding({ source: 'discovery', id: 'discovery:robots', severity: 'pass' })],
      ),
    ).toBe('fail');
    expect(
      kindThresholdStatus(
        'seo',
        [],
        [finding({ source: 'discovery', id: 'discovery:robots', severity: 'warn' })],
      ),
    ).toBe('warn');
  });
  test('geo ignores seo blockers and sitemap discovery', () => {
    expect(
      kindThresholdStatus(
        'geo',
        [{ id: 'no_https', component: 'technical_foundations', cap: 40 }],
        [finding({ source: 'discovery', id: 'discovery:sitemap', severity: 'warn' })],
      ),
    ).toBe('pass');
    expect(
      kindThresholdStatus(
        'geo',
        [{ id: 'live_retrieval_blocked', component: 'ai_citability_visibility', cap: 30 }],
        [],
      ),
    ).toBe('fail');
  });
});
