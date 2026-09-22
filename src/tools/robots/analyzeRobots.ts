import type { Check, CheckStatus } from '../types';
import { scoreToCheckStatus } from '../types';
import type { ParsedRobots, RobotsGroup } from './parseRobots';
import { AI_CRAWLERS } from './aiCrawlers';
import type { AICrawler } from './aiCrawlers';
import { resolveRobotsAccess, type RobotsAccess } from '../../lib/robotsAccess';

interface CrawlerResult extends AICrawler {
  allowed: boolean;
  access: RobotsAccess;
}

export interface RobotsAnalysis {
  /** False when the origin returned HTTP 404 for `/robots.txt`. */
  present: boolean;
  score: number;
  overallStatus: CheckStatus;
  checks: Check[];
  crawlers: CrawlerResult[];
  sitemaps: string[];
}

/** Collects groups for `agent` (all blocks), else all `*` groups. */
function groupsForAgent(groups: RobotsGroup[], agent: string): RobotsGroup[] {
  const lower = agent.toLowerCase();
  const specific = groups.filter((g) => g.userAgents.some((ua) => ua.toLowerCase() === lower));

  if (specific.length > 0) {
    return specific;
  }

  return groups.filter((g) => g.userAgents.some((ua) => ua === '*'));
}

/** Longest-match access for `path` (merged specific groups, else `*`). */
function agentAccess(groups: RobotsGroup[], agent: string, path: string): RobotsAccess {
  const matched = groupsForAgent(groups, agent);

  if (matched.length === 0) {
    return 'allowed';
  }

  const allow = matched.flatMap((g) => g.allow);
  const disallow = matched.flatMap((g) => g.disallow);

  return resolveRobotsAccess(allow, disallow, path);
}

/** Scores robots.txt syntax, sitemap, crawl-delay, and AI crawler access. */
export function analyzeRobots(parsed: ParsedRobots, requestPath = '/'): RobotsAnalysis {
  const { groups, sitemaps, syntaxErrors } = parsed;
  const checks: Check[] = [];

  // Syntax check
  const hasSyntaxErrors = syntaxErrors.length > 0;

  checks.push({
    id: 'syntax',
    label: 'syntax',
    status: hasSyntaxErrors ? 'warn' : 'pass',
    detail: hasSyntaxErrors ? syntaxErrors.slice(0, 3).join('; ') : 'valid',
    value: hasSyntaxErrors ? String(syntaxErrors.length) : undefined,
  });
  // Default User-agent rule

  const hasDefault = groups.some((g) => g.userAgents.includes('*'));

  checks.push({
    id: 'default_rule',
    label: 'default_rule',
    status: hasDefault ? 'pass' : 'warn',
    detail: hasDefault ? 'present' : 'missing',
  });
  // Sitemap declared

  checks.push({
    id: 'sitemap',
    label: 'sitemap',
    status: sitemaps.length > 0 ? 'pass' : 'warn',
    detail: sitemaps.length > 0 ? sitemaps[0] : 'missing',
  });
  // Crawl-delay check

  const highDelay = groups.find((g) => g.crawlDelay !== undefined && g.crawlDelay > 10);

  checks.push({
    id: 'crawl_delay',
    label: 'crawl_delay',
    status: highDelay ? 'warn' : 'pass',
    detail: highDelay ? `${highDelay.crawlDelay}s` : 'ok',
    value: highDelay ? String(highDelay.crawlDelay) : undefined,
  });
  // Crawler results

  const crawlers: CrawlerResult[] = AI_CRAWLERS.map((crawler) => {
    const access = agentAccess(groups, crawler.userAgent, requestPath);

    return { ...crawler, access, allowed: access === 'allowed' };
  });
  // Score calculation

  const passWeight: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0 };
  const baseScore = (checks.reduce((sum, c) => sum + passWeight[c.status], 0) / checks.length) * 60;

  const criticalCrawlers = crawlers.filter((c) => c.geoImpact === 'critical');
  const highCrawlers = crawlers.filter((c) => c.geoImpact === 'high');
  const criticalBlocked = criticalCrawlers.filter((c) => c.access === 'blocked').length;
  const highBlocked = highCrawlers.filter((c) => c.access === 'blocked').length;

  const crawlerScore = Math.max(0, 40 - criticalBlocked * 15 - highBlocked * 5);
  const score = Math.round(Math.min(100, baseScore + crawlerScore));

  const criticalAllBlocked = criticalCrawlers.every((c) => c.access === 'blocked');
  const overallStatus: CheckStatus = criticalAllBlocked ? 'fail' : scoreToCheckStatus(score);

  return { present: true, score, overallStatus, checks, crawlers, sitemaps };
}

/** Returns analysis when `/robots.txt` is missing (HTTP 404). Crawlers are implicitly allowed. */
export function analyzeAbsentRobots(): RobotsAnalysis {
  const base = analyzeRobots({ groups: [], sitemaps: [], syntaxErrors: [] });
  const checks: RobotsAnalysis['checks'] = [
    {
      id: 'presence',
      label: 'presence',
      status: 'fail',
      detail: 'not_found',
    },
    ...base.checks,
  ];
  const passWeight: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0 };
  const baseScore = (checks.reduce((sum, c) => sum + passWeight[c.status], 0) / checks.length) * 60;
  const score = Math.round(Math.min(100, baseScore + 40));

  return {
    ...base,
    present: false,
    score,
    overallStatus: 'fail',
    checks,
  };
}

/** Fetch failed: crawler access unknown (not implicit allow-all). */
export function analyzeRobotsFetchError(): RobotsAnalysis {
  return {
    present: false,
    score: 50,
    overallStatus: 'warn',
    checks: [
      {
        id: 'presence',
        label: 'presence',
        status: 'warn',
        detail: 'fetch_error',
      },
    ],
    crawlers: [],
    sitemaps: [],
  };
}
