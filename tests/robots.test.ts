import { describe, expect, test } from 'bun:test';
import {
  analyzeAbsentRobots,
  analyzeRobots,
  analyzeRobotsFetchError,
} from '../src/tools/robots/analyzeRobots.ts';
import { parseRobots } from '../src/tools/robots/parseRobots.ts';
import { analysisForRobotsOutcome } from '../src/commands/robots-check.ts';
import { robotsPathMatches, resolveRobotsAccess } from '../src/lib/robotsAccess.ts';

describe('parseRobots', () => {
  test('parses allow disallow user-agent and empty syntax errors', () => {
    const result = parseRobots(`User-agent: *\nDisallow: /admin/\nAllow: /`);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.userAgents).toEqual(['*']);
    expect(result.groups[0]?.disallow).toContain('/admin/');
    expect(result.groups[0]?.allow).toContain('/');
    expect(result.sitemaps).toEqual([]);
    expect(result.syntaxErrors).toEqual([]);
  });
  test('parses sitemap and crawl-delay', () => {
    const result = parseRobots(
      `Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nCrawl-delay: 5\nDisallow:`,
    );
    expect(result.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(result.groups[0]?.crawlDelay).toBe(5);
  });
  test('ignores comments', () => {
    const result = parseRobots(`# Main rules\nUser-agent: *\nDisallow: /private/`);

    expect(result.groups).toHaveLength(1);
    expect(result.syntaxErrors).toEqual([]);
  });
  test('records syntax errors for missing colons', () => {
    const result = parseRobots(`Useragent *\nDisallow /admin`);

    expect(result.syntaxErrors.length).toBeGreaterThan(0);
  });
  test('keeps rules after a blank line inside a group', () => {
    const content = `User-agent: *\n\nAllow: /\nDisallow: /500/\nDisallow: /busca/\nDisallow: /api/\n\nUser-agent: OAI-SearchBot\nAllow: /`;
    const result = parseRobots(content);

    expect(result.syntaxErrors).toEqual([]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.userAgents).toEqual(['*']);
    expect(result.groups[0]?.allow).toContain('/');
    expect(result.groups[0]?.disallow).toEqual(['/500/', '/busca/', '/api/']);
    expect(result.groups[1]?.userAgents).toEqual(['OAI-SearchBot']);
  });
  test('merges consecutive User-agent lines into one group', () => {
    const result = parseRobots(`User-agent: GPTBot\n\nUser-agent: ChatGPT-User\nDisallow: /`);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.userAgents).toEqual(['GPTBot', 'ChatGPT-User']);
    expect(result.groups[0]?.disallow).toContain('/');
  });
  test('starts a new group when a User-agent follows rules', () => {
    const result = parseRobots(`User-agent: *\nDisallow: /\nUser-agent: Googlebot\nDisallow:`);

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.userAgents).toEqual(['*']);
    expect(result.groups[1]?.userAgents).toEqual(['Googlebot']);
    expect(result.groups[1]?.disallow).toHaveLength(0);
  });
});

describe('robotsPathMatches', () => {
  test('empty Allow/Disallow does not match any path', () => {
    expect(robotsPathMatches('', '/')).toBe(false);
    expect(robotsPathMatches('   ', '/admin')).toBe(false);
    expect(resolveRobotsAccess([], [''], '/')).toBe('allowed');
  });
  test('Google * and $ wildcards match', () => {
    expect(robotsPathMatches('/*', '/')).toBe(true);
    expect(robotsPathMatches('/*', '/foo')).toBe(true);
    expect(robotsPathMatches('/*.php$', '/page.php')).toBe(true);
    expect(robotsPathMatches('/*.php$', '/page.php/extra')).toBe(false);
    expect(resolveRobotsAccess([], ['/*'], '/')).toBe('blocked');
    expect(resolveRobotsAccess([], ['/secret'], '/secret')).toBe('restricted');
  });
  test('non-wildcard rules are RFC 9309 prefixes', () => {
    expect(robotsPathMatches('/fish', '/fish.html')).toBe(true);
    expect(robotsPathMatches('/fish', '/fishheads')).toBe(true);
    expect(robotsPathMatches('/fish/', '/fish.html')).toBe(false);
    expect(robotsPathMatches('/admin', '/administrator')).toBe(true);
  });
  test('many * wildcards match in linear time', () => {
    const rule = `/a${'*a'.repeat(20)}x`;
    const path = `/${'a'.repeat(40)}x`;

    expect(robotsPathMatches(rule, path)).toBe(true);
  });
});

describe('analyzeRobots', () => {
  test('returns present score overallStatus checks crawlers and sitemaps', () => {
    const analysis = analyzeRobots(
      parseRobots(`User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n`),
    );
    expect(analysis.present).toBe(true);
    expect(analysis.score).toBeGreaterThanOrEqual(80);
    expect(analysis.overallStatus).toBe('pass');
    expect(analysis.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(analysis.checks.map((check) => check.id)).toEqual([
      'syntax',
      'default_rule',
      'sitemap',
      'crawl_delay',
    ]);
    expect(analysis.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(analysis.crawlers.length).toBeGreaterThan(0);
    expect(analysis.crawlers.every((crawler) => crawler.allowed)).toBe(true);
    expect(analysis.crawlers[0]).toEqual(
      expect.objectContaining({
        userAgent: expect.any(String),
        allowed: true,
      }),
    );
  });
  test('warns when the wildcard User-agent is missing', () => {
    const analysis = analyzeRobots(parseRobots(`User-agent: Googlebot\nAllow: /\n`));

    expect(analysis.checks.find((check) => check.id === 'default_rule')).toEqual(
      expect.objectContaining({ status: 'warn', detail: 'missing' }),
    );
  });
  test('treats Disallow / as blocking the wildcard group', () => {
    const analysis = analyzeRobots(parseRobots(`User-agent: *\nDisallow: /\n`));

    expect(analysis.crawlers.every((crawler) => crawler.allowed === false)).toBe(true);
    expect(analysis.overallStatus).toBe('fail');
  });
  test('evaluates crawler access at the requested path', () => {
    const body = `User-agent: *\nAllow: /\nDisallow: /admin\n`;
    const root = analyzeRobots(parseRobots(body), '/');
    const admin = analyzeRobots(parseRobots(body), '/admin');
    const administrator = analyzeRobots(parseRobots(body), '/administrator');

    expect(root.crawlers.every((crawler) => crawler.allowed)).toBe(true);
    expect(admin.crawlers.every((crawler) => crawler.allowed)).toBe(false);
    expect(administrator.crawlers.every((crawler) => crawler.allowed)).toBe(false);
    expect(admin.crawlers.every((crawler) => crawler.access === 'restricted')).toBe(true);
  });
  test('equal-length Allow and Disallow treat the path as allowed', () => {
    const analysis = analyzeRobots(
      parseRobots(`User-agent: *\nAllow: /foo\nDisallow: /foo\n`),
      '/foo',
    );

    expect(analysis.crawlers.every((crawler) => crawler.allowed)).toBe(true);
  });
  test('merges later User-agent blocks for the same crawler', () => {
    const analysis = analyzeRobots(
      parseRobots(`User-agent: Googlebot\nDisallow: /\nUser-agent: Googlebot\nAllow: /\n`),
    );
    const google = analysis.crawlers.find((crawler) => crawler.userAgent === 'Googlebot');

    expect(google?.allowed).toBe(true);
  });
});

describe('analysisForRobotsOutcome', () => {
  test('HTTP 403 is fetch_error, not not_found', () => {
    const analysis = analysisForRobotsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/robots.txt',
        finalUrl: 'https://example.com/robots.txt',
        status: 403,
        contentType: 'text/plain',
        body: '',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        headers: {},
        redirectChain: [],
        responseTimeMs: 1,
      },
      '/',
    );

    expect(analysis.present).toBe(false);
    expect(analysis.crawlers).toEqual([]);
    expect(analysis.overallStatus).toBe('warn');
    expect(analysis.score).toBe(50);
    expect(analysis.checks[0]).toEqual(
      expect.objectContaining({ id: 'presence', status: 'warn', detail: 'fetch_error' }),
    );
  });
  test('homepage HTML at 200 is missing, not present', () => {
    const analysis = analysisForRobotsOutcome(
      {
        ok: true,
        requestedUrl: 'https://example.com/robots.txt',
        finalUrl: 'https://example.com/',
        status: 200,
        contentType: 'text/html',
        body: '<html><body>Home</body></html>',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        headers: {},
        redirectChain: ['https://example.com/robots.txt', 'https://example.com/'],
        responseTimeMs: 1,
      },
      '/',
    );

    expect(analysis.present).toBe(false);
    expect(analysis.checks[0]).toEqual(
      expect.objectContaining({ id: 'presence', status: 'fail', detail: 'not_found' }),
    );
  });
});

describe('analyzeAbsentRobots', () => {
  test('marks the file missing and prepends a presence fail', () => {
    const analysis = analyzeAbsentRobots();

    expect(analysis.present).toBe(false);
    expect(analysis.checks[0]).toEqual(
      expect.objectContaining({ id: 'presence', status: 'fail', detail: 'not_found' }),
    );
    expect(analysis.crawlers.every((crawler) => crawler.allowed)).toBe(true);
    expect(analysis.overallStatus).toBe('fail');
  });
});

describe('analyzeRobotsFetchError', () => {
  test('marks fetch failure with warn presence and unknown crawlers', () => {
    const analysis = analyzeRobotsFetchError();

    expect(analysis.present).toBe(false);
    expect(analysis.crawlers).toEqual([]);
    expect(analysis.overallStatus).toBe('warn');
    expect(analysis.score).toBe(50);
    expect(analysis.checks).toEqual([
      expect.objectContaining({ id: 'presence', status: 'warn', detail: 'fetch_error' }),
    ]);
  });
});
