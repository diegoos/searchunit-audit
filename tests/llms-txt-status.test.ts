import { describe, expect, test } from 'bun:test';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import type { LlmsTxtResult } from '../src/engine/types.ts';

function llmsFixture(over: Partial<LlmsTxtResult> = {}): LlmsTxtResult {
  return {
    url: 'https://example.com/llms.txt',
    exists: false,
    fetchStatus: 'missing',
    format_valid: false,
    has_title: false,
    has_sections: false,
    has_links: false,
    section_count: 0,
    link_count: 0,
    issues: [],
    content: null,
    full_content: null,
    contentType: '',
    full_version: { url: 'https://example.com/llms-full.txt', exists: false, contentType: '' },
    ...over,
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
});
