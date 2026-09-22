export type RobotsAccess = 'allowed' | 'blocked' | 'restricted';

function normalizePath(path: string): string {
  if (!path || path === '/') {
    return '/';
  }

  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Google / RFC 9309 path match: prefix, `*` any run, `$` end anchor.
 * Linear scan (no RegExp) so a hostile `*` rule cannot backtrack.
 */
export function robotsPathMatches(rulePath: string, requestPath: string): boolean {
  const trimmed = rulePath.trim();

  // Empty Allow/Disallow is a no-op (Google: `Disallow:` means allow all).

  if (!trimmed) {
    return false;
  }

  const target = normalizePath(requestPath);
  let rule = normalizePath(trimmed);
  let endAnchor = false;

  if (rule.endsWith('$')) {
    endAnchor = true;
    rule = rule.slice(0, -1) || '/';
  }

  if (!rule.includes('*')) {
    if (endAnchor) {
      return target === rule;
    }

    if (rule === '/') {
      return true;
    }

    return target === rule || target.startsWith(rule);
  }

  return wildcardPathMatches(rule, target, endAnchor);
}

function wildcardPathMatches(rule: string, target: string, endAnchor: boolean): boolean {
  const parts = rule.split('*');
  let pos = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const isLast = i === parts.length - 1;

    if (i === 0) {
      if (!target.startsWith(part)) {
        return false;
      }

      pos = part.length;
      continue;
    }

    if (isLast && endAnchor) {
      if (part.length === 0) {
        return true;
      }

      const start = target.length - part.length;

      return start >= pos && target.endsWith(part);
    }

    if (part.length === 0) {
      if (isLast) {
        return true;
      }

      continue;
    }

    const idx = target.indexOf(part, pos);

    if (idx === -1) {
      return false;
    }

    pos = idx + part.length;
  }

  return !endAnchor || pos === target.length;
}

/**
 * Longest-match robots access. Equal-length Allow and Disallow: Allow wins
 * (Google / RFC 9309).
 */
export function resolveRobotsAccess(
  allow: readonly string[],
  disallow: readonly string[],
  requestPath: string,
): RobotsAccess {
  let bestAllow: string | null = null;
  let bestDisallow: string | null = null;

  for (const p of allow) {
    if (robotsPathMatches(p, requestPath) && (!bestAllow || p.length > bestAllow.length)) {
      bestAllow = p;
    }
  }

  for (const p of disallow) {
    if (robotsPathMatches(p, requestPath) && (!bestDisallow || p.length > bestDisallow.length)) {
      bestDisallow = p;
    }
  }

  if (bestDisallow && (!bestAllow || bestDisallow.length > bestAllow.length)) {
    return isSiteWideDisallow(bestDisallow) ? 'blocked' : 'restricted';
  }

  return 'allowed';
}

/** True when the rule matches `/` and a distinct path (covers `/` and `/*`). */
function isSiteWideDisallow(rule: string): boolean {
  return robotsPathMatches(rule, '/') && robotsPathMatches(rule, '/_');
}
