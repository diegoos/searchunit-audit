import { classifyRobotsHttp, fetchPublicUrl, type FetchOutcome } from '../lib/fetch.ts';
import type { SitemapParseResult } from './types.ts';

function normalizeUrlForMatch(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '') || '/';

    return `${u.host.toLowerCase()}${path}`;
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function locInnerText(inner: string): string {
  const trimmed = inner.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(trimmed);

  return (cdata?.[1] ?? trimmed).trim();
}

/** XML namespace prefixes are short; a huge capture is not a real prefix. */
const MAX_NS_PREFIX = 64;

/** Same-length ASCII A–Z fold so tag search indexes stay aligned with `xml`. */
function foldAsciiAtoZ(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/** Closed `<prefix:local>` inners. Stops at the first unclosed open (linear in body length). */
function elementInners(xml: string, localName: string, limit = Infinity): string[] {
  const folded = foldAsciiAtoZ(xml);
  const openRe = new RegExp(`<(?:(\\w+):)?${localName}\\b[^>]*>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;

  while (out.length < limit && (m = openRe.exec(xml)) !== null) {
    const prefix = m[1];

    if (prefix && prefix.length > MAX_NS_PREFIX) {
      continue;
    }

    const innerFrom = m.index + m[0].length;
    const close = prefix ? `</${prefix}:${localName}>` : `</${localName}>`;
    const closeIdx = folded.indexOf(foldAsciiAtoZ(close), innerFrom);

    if (closeIdx < 0) {
      break;
    }

    out.push(xml.slice(innerFrom, closeIdx));
    openRe.lastIndex = closeIdx + close.length;
  }

  return out;
}

function firstInner(xml: string, localName: string): string | null {
  return elementInners(xml, localName, 1)[0] ?? null;
}

const SITEMAP_MARKUP = /<(?:\w+:)?(?:urlset|sitemapindex|url)\b/i;

/** Counts urlset entries and whether `auditedUrl` is listed (query/fragment ignored). */
export function inspectUrlset(
  xml: string,
  auditedUrl: string,
): Pick<SitemapParseResult, 'url_count' | 'audited_url_listed' | 'audited_url_lastmod'> {
  const target = normalizeUrlForMatch(auditedUrl);
  let url_count = 0;
  let audited_url_listed = false;
  let audited_url_lastmod: string | null = null;

  for (const chunk of elementInners(xml, 'url')) {
    const locRaw = firstInner(chunk, 'loc');
    const loc = locRaw ? locInnerText(locRaw) : '';

    if (!loc) {
      continue;
    }

    url_count += 1;

    if (!audited_url_listed && normalizeUrlForMatch(loc) === target) {
      audited_url_listed = true;
      const lastmodRaw = firstInner(chunk, 'lastmod');

      audited_url_lastmod = lastmodRaw ? locInnerText(lastmodRaw) : null;
    }
  }

  return { url_count, audited_url_listed, audited_url_lastmod };
}

function isSitemapIndex(xml: string): boolean {
  return /<(?:\w+:)?sitemapindex\b/i.test(xml);
}

export function extractChildSitemaps(xml: string, limit = 3): string[] {
  const urls: string[] = [];

  for (const raw of elementInners(xml, 'loc')) {
    const loc = locInnerText(raw);

    if (loc) {
      urls.push(loc);
    }

    if (urls.length >= limit) {
      break;
    }
  }

  return urls;
}

/** Resolves a child sitemap loc against the index URL. Non-http(s) is dropped. */
export function resolveSitemapChildUrl(loc: string, sitemapUrl: string): string | null {
  try {
    const resolved = new URL(loc, sitemapUrl);

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }

    return resolved.href;
  } catch {
    return null;
  }
}

/** First usable declared sitemap (robots, then HTML), else origin /sitemap.xml. */
export function sitemapUrlFromRobots(sitemaps: readonly string[], pageUrl: string): string {
  for (const loc of sitemaps) {
    const resolved = resolveSitemapChildUrl(loc, pageUrl);

    if (resolved) {
      return resolved;
    }
  }

  return new URL('/sitemap.xml', pageUrl).href;
}

function mergeUrlset(
  into: ReturnType<typeof inspectUrlset>,
  xml: string,
  auditedUrl: string,
): void {
  const next = inspectUrlset(xml, auditedUrl);

  into.url_count += next.url_count;

  if (!into.audited_url_listed && next.audited_url_listed) {
    into.audited_url_listed = true;
    into.audited_url_lastmod = next.audited_url_lastmod;
  }
}

function looksLikeSitemapXml(body: string, contentType: string): boolean {
  if (SITEMAP_MARKUP.test(body)) {
    return true;
  }

  return contentType.toLowerCase().includes('xml');
}

/** HTTP + XML body/type. Path redirects (wp-sitemap.xml) stay present; homepage HTML is missing. */
export function classifySitemapFetch(response: FetchOutcome): 'present' | 'missing' | 'error' {
  const kind = classifyRobotsHttp(response.ok, response.status);

  if (kind !== 'present' || !response.ok) {
    return kind;
  }

  return looksLikeSitemapXml(response.body, response.contentType) ? 'present' : 'missing';
}

function unavailableSitemap(fetchStatus: SitemapParseResult['fetchStatus']): SitemapParseResult {
  return {
    present: false,
    fetchStatus,
    url_count: 0,
    audited_url_listed: false,
    audited_url_lastmod: null,
  };
}

/** Builds a sitemap result from child urlset bodies. Empty strings are failed fetches. */
export function sitemapFromIndexChildBodies(
  childBodies: readonly string[],
  auditedUrl: string,
): SitemapParseResult {
  if (childBodies.length === 0) {
    return {
      present: true,
      fetchStatus: 'present',
      url_count: 0,
      audited_url_listed: false,
      audited_url_lastmod: null,
    };
  }

  const listed = { url_count: 0, audited_url_listed: false, audited_url_lastmod: null };
  let fetched = 0;

  for (const body of childBodies) {
    if (!body) {
      continue;
    }

    fetched += 1;
    mergeUrlset(listed, body, auditedUrl);
  }

  if (fetched === 0) {
    return unavailableSitemap('error');
  }

  return {
    present: true,
    fetchStatus: 'present',
    url_count: listed.url_count,
    audited_url_listed: listed.audited_url_listed,
    audited_url_lastmod: listed.audited_url_lastmod,
  };
}

/**
 * Parses a sitemap (or the first three child sitemaps of an index) for the audited URL.
 */
export async function parseSitemapForUrl(
  sitemapUrl: string,
  auditedUrl: string,
): Promise<SitemapParseResult> {
  const res = await fetchPublicUrl(sitemapUrl, { allowHttpErrors: true });
  const kind = classifySitemapFetch(res);

  if (kind !== 'present' || !res.ok) {
    return unavailableSitemap(kind === 'present' ? 'missing' : kind);
  }

  const xml = res.body;

  if (!SITEMAP_MARKUP.test(xml)) {
    return unavailableSitemap('missing');
  }

  if (isSitemapIndex(xml)) {
    const children = extractChildSitemaps(xml, 3)
      .map((loc) => resolveSitemapChildUrl(loc, sitemapUrl))
      .filter((url): url is string => Boolean(url));
    const childResults = await Promise.all(
      children.map(async (child) => {
        const childRes = await fetchPublicUrl(child, { allowHttpErrors: true });

        if (classifySitemapFetch(childRes) === 'present' && childRes.ok) {
          return childRes.body;
        }

        return '';
      }),
    );

    return sitemapFromIndexChildBodies(childResults, auditedUrl);
  }

  const listed = inspectUrlset(xml, auditedUrl);

  return {
    present: true,
    fetchStatus: 'present',
    url_count: listed.url_count,
    audited_url_listed: listed.audited_url_listed,
    audited_url_lastmod: listed.audited_url_lastmod,
  };
}
