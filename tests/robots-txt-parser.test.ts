import { describe, expect, test } from 'bun:test';
import { parseRobotsTxt, unknownCrawlerAccess } from '../src/engine/robotsTxtParser.ts';

describe('parseRobotsTxt', () => {
  test('treats a missing body as all crawlers allowed', () => {
    const empty = parseRobotsTxt(null);

    expect(empty.raw_present).toBe(false);
    expect(empty.sitemaps).toEqual([]);
    expect(empty.crawlers.every((crawler) => crawler.status === 'allowed')).toBe(true);
    expect(empty.crawlers[0]).toEqual(
      expect.objectContaining({
        bot: expect.any(String),
        status: 'allowed',
        crawl_delay_seconds: null,
      }),
    );
  });
  test('equal-length Allow wins over Disallow', () => {
    const parsed = parseRobotsTxt('User-agent: *\nAllow: /foo\nDisallow: /foo\n', '/foo');
    const star = parsed.crawlers.find((crawler) => crawler.bot === 'Googlebot');

    expect(star?.status).toBe('allowed');
  });
  test('Disallow /* is site-wide blocked', () => {
    const parsed = parseRobotsTxt('User-agent: *\nDisallow: /*\n', '/');
    const google = parsed.crawlers.find((crawler) => crawler.bot === 'Googlebot');

    expect(google?.status).toBe('blocked');
  });
  test('Disallow /admin matches /administrator as a prefix', () => {
    const parsed = parseRobotsTxt('User-agent: *\nDisallow: /admin\n', '/administrator');
    const google = parsed.crawlers.find((crawler) => crawler.bot === 'Googlebot');

    expect(google?.status).toBe('restricted');
  });
  test('matches User-agent case-insensitively', () => {
    const parsed = parseRobotsTxt('User-agent: googlebot\nDisallow: /\n', '/');
    const google = parsed.crawlers.find((crawler) => crawler.bot === 'Googlebot');

    expect(google?.status).toBe('blocked');
  });
  test('empty Disallow is allow-all, not restricted', () => {
    const parsed = parseRobotsTxt('User-agent: *\nDisallow:\n', '/');

    expect(parsed.crawlers.every((crawler) => crawler.status === 'allowed')).toBe(true);
  });
  test('copies User-agent * allow and disallow and drops crawl-delay', () => {
    const parsed = parseRobotsTxt(
      'User-agent: *\nAllow: /public\nDisallow: /admin\nCrawl-delay: 10\n',
    );

    expect(parsed.wildcardRules).toEqual({ allow: ['/public'], disallow: ['/admin'] });
  });
  test('empty bodies, missing star groups, and unknown access have empty wildcard rules', () => {
    expect(parseRobotsTxt(null).wildcardRules).toEqual({ allow: [], disallow: [] });
    expect(parseRobotsTxt('   ').wildcardRules).toEqual({ allow: [], disallow: [] });
    expect(parseRobotsTxt('User-agent: Googlebot\nDisallow: /\n').wildcardRules).toEqual({
      allow: [],
      disallow: [],
    });
    expect(unknownCrawlerAccess().wildcardRules).toEqual({ allow: [], disallow: [] });
  });
  test('lists Claude-SearchBot next to ClaudeBot', () => {
    const bots = parseRobotsTxt(null).crawlers.map((crawler) => crawler.bot);
    const claude = bots.indexOf('ClaudeBot');

    expect(bots[claude + 1]).toBe('Claude-SearchBot');
  });
});
