import { hasNoindexDirective, INDEXER_BOTS } from '../tools/meta/robotsTokens.ts';

export function mergeRobotsDirectives(
  metaRobots: string | null,
  xRobotsTag: string | null,
): string | null {
  const parts = [metaRobots, xRobotsTag].filter((p): p is string => Boolean(p?.trim()));

  if (parts.length === 0) {
    return null;
  }

  return parts.join(', ');
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
