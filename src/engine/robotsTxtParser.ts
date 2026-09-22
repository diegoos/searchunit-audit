import { resolveRobotsAccess, type RobotsAccess } from '../lib/robotsAccess.ts';
import { parseRobots, type ParsedRobots } from '../tools/robots/parseRobots.ts';

export type CrawlerAccessStatus = RobotsAccess;

interface CrawlerAccessEntry {
  bot: string;
  status: CrawlerAccessStatus;
  crawl_delay_seconds: number | null;
}

export interface RobotsTxtParseResult {
  crawlers: CrawlerAccessEntry[];
  sitemaps: string[];
  raw_present: boolean;
}

const CANONICAL_AI_CRAWLERS = [
  'Googlebot',
  'Bingbot',
  'GPTBot',
  'Google-Extended',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'PerplexityBot',
  'CCBot',
  'Bytespider',
  'Applebot-Extended',
  'Applebot',
  'Amazonbot',
  'cohere-ai',
  'meta-externalagent',
  'DuckAssistBot',
] as const;

interface AgentRules {
  allow: string[];
  disallow: string[];
  crawl_delay: number | null;
}

function resolveStatus(rules: AgentRules, requestPath: string): CrawlerAccessStatus {
  return resolveRobotsAccess(rules.allow, rules.disallow, requestPath);
}

function emptyRules(): AgentRules {
  return { allow: [], disallow: [], crawl_delay: null };
}

function agentKey(name: string): string {
  return name.trim().toLowerCase();
}

function rulesFromParsed(parsed: ParsedRobots): {
  agents: Map<string, AgentRules>;
  sitemaps: string[];
} {
  const agents = new Map<string, AgentRules>();

  for (const group of parsed.groups) {
    for (const ua of group.userAgents) {
      const key = agentKey(ua);
      const rules = agents.get(key) ?? emptyRules();

      rules.allow.push(...group.allow);
      rules.disallow.push(...group.disallow);

      if (group.crawlDelay !== undefined) {
        rules.crawl_delay = group.crawlDelay;
      }

      agents.set(key, rules);
    }
  }

  return { agents, sitemaps: parsed.sitemaps };
}

function pickRules(agents: Map<string, AgentRules>, bot: string): AgentRules {
  const exact = agents.get(agentKey(bot));

  if (exact) {
    return exact;
  }

  const wildcard = agents.get('*');

  if (wildcard) {
    return wildcard;
  }

  return emptyRules();
}

/** Fetch/parse unknown: no crawler rows (scored as 50, not allow-all). */
export function unknownCrawlerAccess(): RobotsTxtParseResult {
  return { crawlers: [], sitemaps: [], raw_present: false };
}

export function crawlerAccessFromParsed(
  parsed: ParsedRobots,
  requestPath = '/',
): RobotsTxtParseResult {
  const { agents, sitemaps } = rulesFromParsed(parsed);
  const crawlers = CANONICAL_AI_CRAWLERS.map((bot) => {
    const rules = pickRules(agents, bot);

    return {
      bot,
      status: resolveStatus(rules, requestPath),
      crawl_delay_seconds: rules.crawl_delay,
    };
  });

  return { crawlers, sitemaps, raw_present: true };
}

export function parseRobotsTxt(body: string | null, requestPath = '/'): RobotsTxtParseResult {
  if (!body?.trim()) {
    return {
      crawlers: CANONICAL_AI_CRAWLERS.map((bot) => ({
        bot,
        status: 'allowed' as const,
        crawl_delay_seconds: null,
      })),
      sitemaps: [],

      raw_present: false,
    };
  }

  return crawlerAccessFromParsed(parseRobots(body), requestPath);
}
