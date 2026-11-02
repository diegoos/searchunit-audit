import { describe, expect, test } from 'bun:test';
import { parseRobotsTxt, unknownCrawlerAccess } from '../src/engine/robotsTxtParser.ts';
import type { RobotsAccess } from '../src/lib/robotsAccess.ts';

const EMPTY_RULES = { allow: [], disallow: [] };

function statusOf(parsed: ReturnType<typeof parseRobotsTxt>, bot: string) {
  return parsed.crawlers.find((crawler) => crawler.bot === bot)?.status;
}

describe('parseRobotsTxt', () => {
  test('a missing body allows every crawler and has no wildcard rules', () => {
    const parsed = parseRobotsTxt(null);

    expect(parsed.raw_present).toBe(false);
    expect(parsed.sitemaps).toEqual([]);
    expect(parsed.crawlers.every((crawler) => crawler.status === 'allowed')).toBe(true);
    expect(parsed.crawlers[0]).toEqual(
      expect.objectContaining({
        bot: expect.any(String),
        status: 'allowed',
        crawl_delay_seconds: null,
      }),
    );
    expect(parsed.wildcardRules).toEqual(EMPTY_RULES);
    expect(unknownCrawlerAccess().wildcardRules).toEqual(EMPTY_RULES);
  });
  test.each<[string, string, string, RobotsAccess]>([
    [
      'equal-length Allow wins over Disallow',
      'User-agent: *\nAllow: /foo\nDisallow: /foo\n',
      '/foo',
      'allowed',
    ],
    ['Disallow /* blocks the site', 'User-agent: *\nDisallow: /*\n', '/', 'blocked'],
    [
      'Disallow /admin is a prefix match',
      'User-agent: *\nDisallow: /admin\n',
      '/administrator',
      'restricted',
    ],
    [
      'User-agent matching is case-insensitive',
      'User-agent: googlebot\nDisallow: /\n',
      '/',
      'blocked',
    ],
    ['an empty Disallow allows everything', 'User-agent: *\nDisallow:\n', '/', 'allowed'],
  ])('%s', (_name, body, path, status) => {
    expect(statusOf(parseRobotsTxt(body, path), 'Googlebot')).toBe(status);
  });
  test('copies User-agent * allow and disallow rules and drops crawl-delay', () => {
    const parsed = parseRobotsTxt(
      'User-agent: *\nAllow: /public\nDisallow: /admin\nCrawl-delay: 10\n',
    );

    expect(parsed.wildcardRules).toEqual({ allow: ['/public'], disallow: ['/admin'] });
  });
  test('wildcard rules are empty when there is no * group', () => {
    expect(parseRobotsTxt('   ').wildcardRules).toEqual(EMPTY_RULES);
    expect(parseRobotsTxt('User-agent: Googlebot\nDisallow: /\n').wildcardRules).toEqual(
      EMPTY_RULES,
    );
  });
});
