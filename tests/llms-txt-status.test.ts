import { describe, expect, test } from 'bun:test';
import { deriveLlmsTxtStatus } from '../src/engine/llmsTxtStatus.ts';
import { cappedLlmsLinks } from '../src/engine/llms.ts';
import type { LlmsTxtStatus } from '../src/engine/types.ts';
import { llmsTxtFixture } from './engine-fixtures.ts';

const FULL_VERSION = { url: 'https://example.com/llms-full.txt', exists: true, contentType: '' };

describe('deriveLlmsTxtStatus', () => {
  test.each<[string, Parameters<typeof llmsTxtFixture>[0], LlmsTxtStatus]>([
    ['absent when llms.txt is missing', {}, 'absent'],
    ['error when the fetch failed', { fetchStatus: 'error' as const }, 'error'],
    ['malformed when the file is not valid', { exists: true }, 'malformed'],
    ['limited without a title', { exists: true, format_valid: true }, 'limited'],
    [
      'useful with a title, links and one section',
      { exists: true, format_valid: true, has_title: true, has_links: true, section_count: 1 },
      'useful',
    ],
    [
      'comprehensive with two sections, five links and llms-full.txt',
      {
        exists: true,
        format_valid: true,
        has_title: true,
        has_links: true,
        section_count: 2,
        link_count: 5,
        full_version: FULL_VERSION,
      },
      'comprehensive',
    ],
  ])('%s', (_name, over, status) => {
    expect(deriveLlmsTxtStatus(llmsTxtFixture(over))).toBe(status);
  });
  test('derives comprehensive from llms-full.txt when llms.txt is missing', () => {
    const fullBody = [
      '# Site',
      '> Summary',
      '## Docs',
      '- [A](https://example.com/a.md)',
      '- [B](https://example.com/b.md)',
      '- [C](https://example.com/c.md)',
      '## More',
      '- [D](https://example.com/d.md)',
      '- [E](https://example.com/e.md)',
    ].join('\n\n');

    expect(
      deriveLlmsTxtStatus(llmsTxtFixture({ full_version: FULL_VERSION, full_content: fullBody })),
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
