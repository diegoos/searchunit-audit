import { describe, expect, test } from 'bun:test';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import { cappedLlmsLinks } from '../src/engine/llms.ts';
import type { LlmsTxtResult } from '../src/engine/types.ts';

function llmsFixture(over: Partial<LlmsTxtResult> = {}): LlmsTxtResult {
  return {
    url: 'https://example.com/llms.txt',
    exists: false,
    fetchStatus: 'missing',
    fetchError: null,
    format_valid: false,
    has_title: false,
    has_sections: false,
    has_links: false,
    section_count: 0,
    link_count: 0,
    links: [],
    linksTruncated: false,
    issues: [],
    content: null,
    full_content: null,
    contentType: '',
    full_version: { url: 'https://example.com/llms-full.txt', exists: false, contentType: '' },
    ...over,
    linksToAuditedUrl: over.linksToAuditedUrl ?? false,
  };
}

describe('deriveLlmsTxtStatus', () => {
  test('maps absent malformed limited useful and comprehensive', () => {
    expect(deriveLlmsTxtStatus(llmsFixture())).toBe('absent');
    expect(deriveLlmsTxtStatus(llmsFixture({ exists: true, format_valid: false }))).toBe(
      'malformed',
    );
    expect(
      deriveLlmsTxtStatus(llmsFixture({ exists: true, format_valid: true, has_title: false })),
    ).toBe('limited');
    expect(
      deriveLlmsTxtStatus(
        llmsFixture({
          exists: true,
          format_valid: true,
          has_title: true,
          has_links: true,
          section_count: 1,
        }),
      ),
    ).toBe('useful');
    expect(
      deriveLlmsTxtStatus(
        llmsFixture({
          exists: true,
          format_valid: true,
          has_title: true,
          has_links: true,
          section_count: 2,
          link_count: 5,
          full_version: { url: 'https://example.com/llms-full.txt', exists: true, contentType: '' },
        }),
      ),
    ).toBe('comprehensive');
  });
  test('maps fetchStatus error to error, not absent', () => {
    expect(deriveLlmsTxtStatus(llmsFixture({ fetchStatus: 'error' }))).toBe('error');
  });
  test('derives status from llms-full.txt when llms.txt is missing', () => {
    const fullBody =
      '# Site\n\n> Summary\n\n## Docs\n\n- [A](https://example.com/a.md)\n- [B](https://example.com/b.md)\n- [C](https://example.com/c.md)\n\n## More\n\n- [D](https://example.com/d.md)\n- [E](https://example.com/e.md)\n';

    expect(
      deriveLlmsTxtStatus(
        llmsFixture({
          full_version: { url: 'https://example.com/llms-full.txt', exists: true, contentType: '' },
          full_content: fullBody,
        }),
      ),
    ).toBe('comprehensive');
  });
  test('matches the audited page before the link cap', () => {
    const links = Array.from({ length: 101 }, (_, index) => ({
      title: String(index),
      url: `https://example.com/p/${index}`,
    }));
    links.push({ title: 'page', url: 'https://www.example.com/target/' });
    const capped = cappedLlmsLinks(links, 'https://example.com/target');

    expect(capped.linksTruncated).toBe(true);
    expect(capped.linksToAuditedUrl).toBe(true);
    expect(capped.links.some((link) => link.url.includes('/target'))).toBe(false);
  });
});
