import { isLoopbackHost } from '../ip-policy.ts';

const DEFAULT_SCHEME = 'https://';

function isLoopbackInput(input: string): boolean {
  try {
    return isLoopbackHost(new URL(`http://${input}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Prepends https:// when the user omits a scheme.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (isLoopbackInput(trimmed)) {
    return `http://${trimmed}`;
  }

  return `${DEFAULT_SCHEME}${trimmed}`;
}

/**
 * Returns true when input parses as http(s) with a hostname.
 */
export function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(normalizeUrl(input));

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clears URL userinfo so credentials never appear in hrefs or reports.
 */
export function stripUserinfo(url: URL): URL {
  url.username = '';
  url.password = '';

  return url;
}

const TRACKING_PARAMS = new Set(['gclid', 'fbclid']);

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();

  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
}

/** Locale-independent order, so the same URL gives the same key on any ICU build. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

/**
 * Host, path, and non-tracking query used to match the same page.
 * Lowercase host, no leading www, the port when it is not the scheme default, no trailing
 * slash. Drops `utm_*`, `gclid`, and `fbclid`.
 */
export function pageKey(value: string): string | null {
  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    const path = url.pathname.replace(/\/$/, '') || '/';
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    // URL already drops the scheme default port, so an empty `port` means default.
    const host = url.port ? `${hostname}:${url.port}` : hostname;
    const params = [...url.searchParams.entries()]
      .filter(([name]) => !isTrackingParam(name))
      .toSorted((a, b) => compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]));

    if (params.length === 0) {
      return `${host}${path}`;
    }

    const query = params
      .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
      .join('&');

    return `${host}${path}?${query}`;
  } catch {
    return null;
  }
}

export interface LinkHeaderFacts {
  canonical: string | null;
  hreflang: { lang: string; href: string }[];
}

function headerUrl(raw: string, base: string): string | null {
  try {
    return hrefWithoutUserinfo(new URL(raw.trim(), base).href);
  } catch {
    return null;
  }
}

function quotedParam(part: string, name: string): string | null {
  const start = part.toLowerCase().indexOf(`${name.toLowerCase()}=`);

  if (start === -1) {
    return null;
  }

  const raw = part.slice(start + name.length + 1);
  const close = raw.startsWith('"') ? raw.indexOf('"', 1) : -1;
  const value = close > 1 ? raw.slice(1, close) : raw.split(/[;\s]/, 1)[0]!;

  return value.trim() || null;
}

/** Reads canonical and hreflang from an HTTP `Link` header. */
export function parseLinkHeader(value: string | null, base: string): LinkHeaderFacts {
  const hreflang: { lang: string; href: string }[] = [];
  let canonical: string | null = null;

  if (!value) {
    return { canonical, hreflang };
  }

  for (const part of value.split(',')) {
    const hrefMatch = /<([^>]+)>/.exec(part);
    const href = hrefMatch?.[1] ? headerUrl(hrefMatch[1], base) : null;
    const rels = (quotedParam(part, 'rel') ?? '').toLowerCase().split(/\s+/);

    if (!href) {
      continue;
    }

    if (rels.includes('canonical') && !canonical) {
      canonical = href;
    }

    const lang = quotedParam(part, 'hreflang');

    if (rels.includes('alternate') && lang) {
      hreflang.push({ lang, href });
    }
  }

  return { canonical, hreflang };
}

export function hrefWithoutUserinfo(value: string): string | null {
  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return stripUserinfo(url).href;
  } catch {
    return null;
  }
}

/**
 * Requires a non-empty http(s) URL and returns the normalized href.
 */
export function requireHttpUrl(input: string | undefined): string {
  if (!input || !input.trim()) {
    throw new Error('A URL is required. Example: searchunit schema-check https://example.com');
  }

  if (!isValidHttpUrl(input)) {
    throw new Error(`Invalid URL: ${redactUserinfo(input)}`);
  }

  return stripUserinfo(new URL(normalizeUrl(input))).href;
}

/** Drops userinfo from a parse-failed URL so secrets do not reach stderr. */
function redactUserinfo(input: string): string {
  try {
    return stripUserinfo(new URL(normalizeUrl(input))).href;
  } catch {
    return input.replace(/\/\/[^/?#]*@/u, '//');
  }
}
