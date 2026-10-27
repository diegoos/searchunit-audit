import { classifyRobotsHttp, fetchPublicUrl, type FetchOutcome } from '../lib/fetch.ts';
import { hrefWithoutUserinfo, pageKey } from '../lib/url.ts';
import type { SitemapParseResult } from './types.ts';

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => {
    if (entity === '&lt;') {
      return '<';
    }

    if (entity === '&gt;') {
      return '>';
    }

    if (entity === '&quot;') {
      return '"';
    }

    if (entity === '&apos;') {
      return "'";
    }

    return '&';
  });
}

function locInnerText(inner: string): string {
  const trimmed = inner.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(trimmed);

  return decodeXmlEntities((cdata?.[1] ?? trimmed).trim());
}

/** Absolute http(s) loc, or a scheme-less loc a child resolver can still join. */
function childSitemapLoc(loc: string): string | null {
  const absolute = hrefWithoutUserinfo(loc);

  if (absolute) {
    return absolute;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(loc)) {
    return null;
  }

  return loc;
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
const SITEMAP_URL_CAP = 200;

const TEMPLATE_ORDER = ['commercial', 'article', 'category', 'about', 'contact'] as const;

type SitemapTemplate = (typeof TEMPLATE_ORDER)[number];

const SEGMENT_TEMPLATE = new Map<string, SitemapTemplate>([
  ['product', 'commercial'],
  ['products', 'commercial'],
  ['shop', 'commercial'],
  ['store', 'commercial'],
  ['pricing', 'commercial'],
  ['checkout', 'commercial'],
  ['cart', 'commercial'],
  ['produto', 'commercial'],
  ['produtos', 'commercial'],
  ['loja', 'commercial'],
  ['sku', 'commercial'],
  ['blog', 'article'],
  ['news', 'article'],
  ['article', 'article'],
  ['articles', 'article'],
  ['post', 'article'],
  ['posts', 'article'],
  ['story', 'article'],
  ['noticia', 'article'],
  ['noticias', 'article'],
  ['journal', 'article'],
  ['category', 'category'],
  ['categories', 'category'],
  ['collection', 'category'],
  ['collections', 'category'],
  ['tag', 'category'],
  ['tags', 'category'],
  ['categoria', 'category'],
  ['categorias', 'category'],
  ['catalog', 'category'],
  ['catalogue', 'category'],
  ['about', 'about'],
  ['about-us', 'about'],
  ['sobre', 'about'],
  ['quem-somos', 'about'],
  ['contact', 'contact'],
  ['contact-us', 'contact'],
  ['contato', 'contact'],
  ['fale-conosco', 'contact'],
]);

const INSTITUTIONAL_SEGMENTS = new Set([
  'about',
  'about-us',
  'sobre',
  'quem-somos',
  'contact',
  'contact-us',
  'contato',
  'fale-conosco',
  'privacy',
  'privacy-policy',
  'privacidade',
  'politica-de-privacidade',
  'terms',
  'terms-of-service',
  'terms-of-use',
  'termos',
  'termos-de-uso',
]);

type SitemapUrl = SitemapParseResult['urls'][number];

interface UrlsetListing {
  url_count: number;
  audited_url_listed: boolean;
  audited_url_lastmod: string | null;
  entries: SitemapUrl[];
}

function emptyListing(): UrlsetListing {
  return {
    url_count: 0,
    audited_url_listed: false,
    audited_url_lastmod: null,
    entries: [],
  };
}

function pathnameSegments(loc: string): string[] | null {
  try {
    return new URL(loc).pathname.split('/').filter((segment) => segment.length > 0);
  } catch {
    return null;
  }
}

function isPrioritySitemapLoc(loc: string): boolean {
  const segments = pathnameSegments(loc);

  if (segments === null) {
    return false;
  }

  if (segments.length <= 2) {
    return true;
  }

  return segments.some((segment) => INSTITUTIONAL_SEGMENTS.has(segment.toLowerCase()));
}

function sitemapTemplate(loc: string): SitemapTemplate | null {
  const segments = pathnameSegments(loc);

  if (segments === null) {
    return null;
  }

  for (const segment of segments) {
    const kind = SEGMENT_TEMPLATE.get(segment.toLowerCase());

    if (kind) {
      return kind;
    }
  }

  return null;
}

function mostRecentSitemapUrl(entries: readonly SitemapUrl[]): SitemapUrl | undefined {
  let best: SitemapUrl | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (!entry.lastmod) {
      continue;
    }

    const time = Date.parse(entry.lastmod);

    if (Number.isNaN(time) || time <= bestTime) {
      continue;
    }

    best = entry;
    bestTime = time;
  }

  return best;
}

function sliceSitemapUrls(
  entries: readonly SitemapUrl[],
  urlCount: number,
): Pick<SitemapParseResult, 'urls' | 'urlsTruncated'> {
  const urls: SitemapUrl[] = [];
  const seen = new Set<string>();

  const take = (entry: SitemapUrl | undefined): void => {
    if (!entry || seen.has(entry.loc) || urls.length >= SITEMAP_URL_CAP) {
      return;
    }

    seen.add(entry.loc);
    urls.push(entry);
  };
  for (const kind of TEMPLATE_ORDER) {
    take(entries.find((entry) => sitemapTemplate(entry.loc) === kind));
  }

  take(mostRecentSitemapUrl(entries));

  const priority: SitemapUrl[] = [];
  const rest: SitemapUrl[] = [];

  for (const entry of entries) {
    if (seen.has(entry.loc)) {
      continue;
    }

    if (isPrioritySitemapLoc(entry.loc)) {
      priority.push(entry);
    } else {
      rest.push(entry);
    }
  }

  for (const entry of [...priority, ...rest]) {
    take(entry);
  }

  return { urls, urlsTruncated: urlCount > urls.length };
}

function readUrlset(xml: string, auditedUrl: string): UrlsetListing {
  const target = pageKey(auditedUrl);
  const listing = emptyListing();

  for (const chunk of elementInners(xml, 'url')) {
    const locRaw = firstInner(chunk, 'loc');
    const loc = locRaw ? hrefWithoutUserinfo(locInnerText(locRaw)) : null;

    if (!loc) {
      continue;
    }

    listing.url_count += 1;
    const lastmodRaw = firstInner(chunk, 'lastmod');
    const lastmod = lastmodRaw ? locInnerText(lastmodRaw) : null;

    listing.entries.push({ loc, lastmod });

    if (!listing.audited_url_listed && target !== null && pageKey(loc) === target) {
      listing.audited_url_listed = true;
      listing.audited_url_lastmod = lastmod;
    }
  }

  return listing;
}

/** Counts urlset entries and whether `auditedUrl` is listed (matched by `pageKey`). */
export function inspectUrlset(
  xml: string,
  auditedUrl: string,
): Pick<SitemapParseResult, 'url_count' | 'audited_url_listed' | 'audited_url_lastmod'> {
  const listing = readUrlset(xml, auditedUrl);

  return {
    url_count: listing.url_count,
    audited_url_listed: listing.audited_url_listed,
    audited_url_lastmod: listing.audited_url_lastmod,
  };
}

function isSitemapIndex(xml: string): boolean {
  return /<(?:\w+:)?sitemapindex\b/i.test(xml);
}

export function extractChildSitemaps(xml: string, limit = 3): string[] {
  const urls: string[] = [];

  for (const raw of elementInners(xml, 'loc')) {
    const loc = childSitemapLoc(locInnerText(raw));

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

/** Most declared sitemap roots read per audit (robots `Sitemap:` lines, then HTML hints). */
export const SITEMAP_ROOT_CAP = 5;

/** Most sitemap files (roots, index children, nested indexes) fetched per audit. */
export const SITEMAP_FILE_CAP = 25;

/**
 * Sitemap files fetched at once. Many hosts serve sitemaps one at a time; 25
 * parallel GETs next to the link probe pushed files past the fetch timeout,
 * so coverage changed between runs.
 */
const SITEMAP_CONCURRENCY = 5;

/** Usable declared sitemaps (robots, then HTML), deduped and capped, else origin /sitemap.xml. */
export function sitemapUrlsFromDeclared(sitemaps: readonly string[], pageUrl: string): string[] {
  const out: string[] = [];

  for (const loc of sitemaps) {
    const resolved = resolveSitemapChildUrl(loc, pageUrl);

    if (resolved && !out.includes(resolved)) {
      out.push(resolved);
    }

    if (out.length >= SITEMAP_ROOT_CAP) {
      break;
    }
  }

  return out.length > 0 ? out : [new URL('/sitemap.xml', pageUrl).href];
}

function mergeUrlset(into: UrlsetListing, xml: string, auditedUrl: string): void {
  const next = readUrlset(xml, auditedUrl);

  into.url_count += next.url_count;
  into.entries.push(...next.entries);

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
    urls: [],
    urlsTruncated: false,
    coverage: 'complete',
    filesRead: 0,
  };
}

function presentSitemap(listing: UrlsetListing, filesRead = 1): SitemapParseResult {
  const sliced = sliceSitemapUrls(listing.entries, listing.url_count);

  return {
    present: true,
    fetchStatus: 'present',
    url_count: listing.url_count,
    audited_url_listed: listing.audited_url_listed,
    audited_url_lastmod: listing.audited_url_lastmod,
    urls: sliced.urls,
    urlsTruncated: sliced.urlsTruncated,
    coverage: 'complete',
    filesRead,
  };
}

/** Builds a sitemap result from child urlset bodies. Empty strings are failed fetches. */
export function sitemapFromIndexChildBodies(
  childBodies: readonly string[],
  auditedUrl: string,
  moreChildren = false,
): SitemapParseResult {
  if (childBodies.length === 0) {
    return {
      ...presentSitemap(emptyListing(), 0),
      urlsTruncated: moreChildren,
      coverage: moreChildren ? 'partial' : 'complete',
    };
  }

  const listed = emptyListing();
  let fetched = 0;
  let unexpandedIndex = false;

  for (const body of childBodies) {
    if (!body) {
      continue;
    }

    fetched += 1;

    if (isSitemapIndex(body)) {
      unexpandedIndex = true;
    }

    mergeUrlset(listed, body, auditedUrl);
  }

  if (fetched === 0) {
    return { ...unavailableSitemap('error'), urlsTruncated: moreChildren };
  }

  const result = presentSitemap(listed, fetched);

  if (moreChildren || unexpandedIndex) {
    return { ...result, urlsTruncated: true, coverage: 'partial' };
  }

  return result;
}

type SitemapFile =
  | { kind: 'urlset'; body: string }
  | { kind: 'index'; children: string[] }
  | { kind: 'unavailable'; status: 'missing' | 'error' };

async function fetchSitemapFile(url: string): Promise<SitemapFile> {
  const res = await fetchPublicUrl(url, { allowHttpErrors: true });
  const kind = classifySitemapFetch(res);

  if (kind !== 'present' || !res.ok || !SITEMAP_MARKUP.test(res.body)) {
    return { kind: 'unavailable', status: kind === 'error' ? 'error' : 'missing' };
  }

  if (!isSitemapIndex(res.body)) {
    return { kind: 'urlset', body: res.body };
  }

  const children = extractChildSitemaps(res.body, SITEMAP_FILE_CAP + 1)
    .map((loc) => resolveSitemapChildUrl(loc, url))
    .filter((child): child is string => Boolean(child));

  return { kind: 'index', children };
}

/**
 * Reads declared sitemap roots, follows index children and nested indexes
 * breadth-first, and stops at `SITEMAP_FILE_CAP` files. Files are merged in
 * queue order, so the same sitemaps give the same result.
 */
export async function parseSitemapForUrl(
  sitemapUrls: readonly string[],
  auditedUrl: string,
): Promise<SitemapParseResult> {
  const queue = [...new Set(sitemapUrls)];
  const seen = new Set(queue);
  const listing = emptyListing();
  let rootStatus: 'missing' | 'error' | null = null;
  let filesRead = 0;
  let failedFiles = 0;
  let cursor = 0;

  while (cursor < queue.length) {
    const batch = queue.slice(
      cursor,
      Math.min(queue.length, SITEMAP_FILE_CAP, cursor + SITEMAP_CONCURRENCY),
    );

    if (batch.length === 0) {
      break;
    }

    cursor += batch.length;
    const files = await Promise.all(batch.map(fetchSitemapFile));

    for (const file of files) {
      if (file.kind === 'unavailable') {
        rootStatus ??= file.status;
        failedFiles += 1;
        continue;
      }

      filesRead += 1;

      if (file.kind === 'urlset') {
        mergeUrlset(listing, file.body, auditedUrl);
        continue;
      }

      for (const child of file.children) {
        if (seen.has(child)) {
          continue;
        }

        seen.add(child);
        queue.push(child);
      }
    }
  }

  if (filesRead === 0) {
    return unavailableSitemap(rootStatus ?? 'missing');
  }

  const result = presentSitemap(listing, filesRead);

  if (failedFiles > 0 || queue.length > SITEMAP_FILE_CAP) {
    return { ...result, urlsTruncated: true, coverage: 'partial' };
  }

  return result;
}
