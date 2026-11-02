export interface RobotsGroup {
  userAgents: string[];
  disallow: string[];
  allow: string[];
  crawlDelay?: number;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  syntaxErrors: string[];
}

const KNOWN_DIRECTIVES = new Set([
  'user-agent',
  'disallow',
  'allow',
  'crawl-delay',
  'sitemap',
  'host',
  'noindex',
  'nofollow',
  'clean-param',
  'request-rate',
]);

/** Applies a disallow, allow, or crawl-delay directive to the open group. */
function applyRuleDirective(group: RobotsGroup, directive: string, value: string): void {
  if (directive === 'disallow') {
    if (value !== '') {
      group.disallow.push(value);
    }
  } else if (directive === 'allow') {
    if (value !== '') {
      group.allow.push(value);
    }
  } else if (directive === 'crawl-delay') {
    const delay = parseFloat(value);

    if (!isNaN(delay)) {
      group.crawlDelay = delay;
    }
  }
}

/** Parses robots.txt into agent groups, rules, and sitemap directives (RFC 9309 groups). */
export function parseRobots(content: string): ParsedRobots {
  const lines = content.split(/\r?\n/);
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const syntaxErrors: string[] = [];

  let currentGroup: RobotsGroup | null = null;
  // True while reading User-agent lines at the top of a group. A rule directive
  // clears it, so the next User-agent starts a fresh group even without a blank line.
  let acceptingAgents = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trim();

    // Blank lines do not end a group (RFC 9309): rules after an empty line still
    // belong to the open group. Only a User-agent line after rules starts a new one.

    if (!line) {
      continue;
    }

    const colonIdx = line.indexOf(':');

    if (colonIdx === -1) {
      syntaxErrors.push(`Line ${i + 1}: missing colon — "${raw.trim()}"`);
      continue;
    }

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (!KNOWN_DIRECTIVES.has(directive)) {
      syntaxErrors.push(`Line ${i + 1}: unknown directive "${directive}"`);
      continue;
    }

    if (directive === 'sitemap') {
      if (value) {
        sitemaps.push(value);
      }

      continue;
    }

    if (directive === 'user-agent') {
      // If we already have a group and have moved past its User-agent header
      // (i.e. seen at least one rule), close it before starting the new one.
      if (currentGroup && !acceptingAgents) {
        groups.push(currentGroup);
        currentGroup = null;
      }

      if (!currentGroup) {
        currentGroup = { userAgents: [], disallow: [], allow: [] };
        acceptingAgents = true;
      }

      if (value) {
        currentGroup.userAgents.push(value);
      }

      continue;
    }

    if (!currentGroup) {
      syntaxErrors.push(`Line ${i + 1}: directive "${directive}" without User-agent block`);
      continue;
    }

    // Any rule directive means we're no longer in the User-agent header phase.

    acceptingAgents = false;
    applyRuleDirective(currentGroup, directive, value);
  }

  if (currentGroup) {
    groups.push(currentGroup);
  }

  return { groups, sitemaps, syntaxErrors };
}
