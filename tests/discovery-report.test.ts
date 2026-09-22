import { describe, expect, test } from 'bun:test';
import { discoveryForReport } from '../src/engine/report.ts';
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
  });
});
