import { hasNoindexDirective, INDEXER_BOTS } from '../tools/meta/robotsTokens.ts';

/** Joins meta robots and X-Robots-Tag tokens. A token repeated in either source appears once, first case kept. */
export function mergeRobotsDirectives(
  metaRobots: string | null,
  xRobotsTag: string | null,
): string | null {
  const tokens = [metaRobots, xRobotsTag]
    .filter((p): p is string => Boolean(p?.trim()))
    .flatMap((p) => p.split(','))
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique = tokens.filter((token) => {
    const key = token.toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  return unique.length > 0 ? unique.join(', ') : null;
}

/** Which source carries `noindex`. Meta wins over the header, then an indexer bot meta. */
export function noindexSource(
  metaRobots: string | null,
  xRobotsTag: string | null,
  metaRobotsByBot: Record<string, string> = {},
): 'meta' | 'header' | 'bot' | null {
  if (hasNoindexDirective(metaRobots)) {
    return 'meta';
  }

  if (hasNoindexDirective(xRobotsTag)) {
    return 'header';
  }

  for (const [bot, content] of Object.entries(metaRobotsByBot)) {
    if (INDEXER_BOTS.has(bot.toLowerCase()) && hasNoindexDirective(content)) {
      return 'bot';
    }
  }

  return null;
}

export function isNoindexCombined(
  metaRobots: string | null,
  xRobotsTag: string | null,
  metaRobotsByBot?: Record<string, string>,
): boolean {
  const merged = mergeRobotsDirectives(metaRobots, xRobotsTag);

  if (hasNoindexDirective(merged)) {
    return true;
  }

  if (!metaRobotsByBot) {
    return false;
  }

  for (const [bot, content] of Object.entries(metaRobotsByBot)) {
    if (INDEXER_BOTS.has(bot.toLowerCase()) && hasNoindexDirective(content)) {
      return true;
    }
  }

  return false;
}

/** True for 2xx pages that are not noindex (same rule as technical indexability). */
export function isPageIndexable(
  statusCode: number,
  metaRobots: string | null,
  xRobotsTag: string | null,
  metaRobotsByBot?: Record<string, string>,
): boolean {
  return (
    statusCode >= 200 &&
    statusCode < 300 &&
    !isNoindexCombined(metaRobots, xRobotsTag, metaRobotsByBot)
  );
}
