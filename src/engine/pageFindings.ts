import { pageKey } from '../lib/url.ts';
import type { DiscoveryBundle } from './discovery.ts';
import { hreflangIssues } from './hreflang.ts';
import { firstHeadingSkip } from './parsers/pageHygiene.ts';
import { directiveIsNoindex } from './robotsDirective.ts';
import { crawlerAccessFromParsed } from './robotsTxtParser.ts';
import { SEARCH_BOTS } from './scoring.ts';
import type { Finding, FindingSeverity, PageLink } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_LIST_CAP = 5;

export function makeFinding(
  source: string,
  id: string,
  severity: FindingSeverity,
  title: string,
  detail: string,
): Finding {
  return { id: `${source}:${id}`, source, severity, title, detail };
}

function listed(items: readonly string[], cap = DETAIL_LIST_CAP): string {
  const head = items.slice(0, cap).join(', ');

  return items.length > cap ? `${head} (+${items.length - cap} more)` : head;
}

/** Drops the `null` slots of checks that did not apply. */
function presentFindings(items: (Finding | null)[]): Finding[] {
  return items.filter((item): item is Finding => item !== null);
}

function heroImageOf(bundle: DiscoveryBundle) {
  return bundle.auditedPage.images.items.find((item) => item.hero);
}

/** Googlebot and Bingbot access to the audited path in robots.txt. Gate finding. */
export function searchCrawlerFinding(bundle: DiscoveryBundle): Finding {
  const rows = bundle.crawlerAccess.crawlers.filter((c) =>
    (SEARCH_BOTS as readonly string[]).includes(c.bot),
  );
  const title = 'Search crawlers on this path';

  if (rows.length === 0) {
    return makeFinding('discovery', 'search-crawlers', 'info', title, 'robots.txt not read');
  }

  const detail = rows.map((c) => `${c.bot}=${c.status}`).join(' ');
  const blocked = rows.some((c) => c.status === 'blocked');

  return makeFinding('discovery', 'search-crawlers', blocked ? 'fail' : 'pass', title, detail);
}

/** Googlebot's access to a resource URL, from the same robots.txt rules as the page. */
function googlebotAccess(parsed: NonNullable<DiscoveryBundle['parsedRobots']>, url: string) {
  const resource = new URL(url);
  const path = `${resource.pathname}${resource.search}`;

  return crawlerAccessFromParsed(parsed, path).crawlers.find((c) => c.bot === 'Googlebot')?.status;
}

/**
 * Scripts and stylesheets that robots.txt blocks or restricts for Googlebot.
 * Googlebot cannot render the page without them. Independent of Chrome.
 */
export function blockedResourcesFinding(bundle: DiscoveryBundle): Finding {
  const title = 'Render resources for Googlebot';
  const resources = bundle.auditedPage.sameHostResources;
  const parsed = bundle.parsedRobots;

  if (parsed === null) {
    return bundle.auditedPage.robotsStatus === 'error'
      ? makeFinding('robots', 'blocked-resources', 'info', title, 'robots.txt not read')
      : makeFinding('robots', 'blocked-resources', 'pass', title, 'no robots.txt rules');
  }

  const blocked = resources.filter((url) => {
    const status = googlebotAccess(parsed, url);

    return status !== undefined && status !== 'allowed';
  });
  if (blocked.length > 0) {
    return makeFinding(
      'robots',
      'blocked-resources',
      'warn',
      title,
      `${blocked.length} of ${resources.length} blocked or restricted: ${listed(blocked)}`,
    );
  }

  return makeFinding(
    'robots',
    'blocked-resources',
    'pass',
    title,
    `${resources.length} same-host script/stylesheet(s), none blocked`,
  );
}

function mobileDiffs(bundle: DiscoveryBundle): { fail: string[]; warn: string[] } {
  const desk = bundle.auditedPage;
  const mobile = bundle.mobilePage!;
  const fail: string[] = [];
  const warn: string[] = [];

  if (directiveIsNoindex(mobile.effectiveRobotsDirective)) {
    fail.push('mobile noindex');
  }

  const deskCanonical = desk.canonicalUrl ? pageKey(desk.canonicalUrl) : null;
  const mobileCanonical = mobile.canonicalUrl ? pageKey(mobile.canonicalUrl) : null;

  if (deskCanonical !== mobileCanonical) {
    fail.push(`canonical ${mobileCanonical ?? 'missing'} vs ${deskCanonical ?? 'missing'}`);
  }

  if (mobile.statusCode !== desk.statusCode) {
    fail.push(`status ${mobile.statusCode} vs ${desk.statusCode}`);
  }

  if (!mobile.viewport) {
    warn.push('no viewport');
  }

  if (mobile.h1.join(' ') !== desk.headings.h1.join(' ')) {
    warn.push('H1 differs');
  }

  if (mobile.visibleTextSha256 !== desk.visibleTextSha256) {
    warn.push(`visible text differs (words ${mobile.wordCount} vs ${desk.wordCount})`);
  }

  return { fail, warn };
}

/** Desktop vs mobile user-agent GET of the same URL. Gate finding. */
export function mobileParityFinding(bundle: DiscoveryBundle): Finding {
  const title = 'Mobile parity';

  if (!bundle.mobilePage) {
    return makeFinding(
      'discovery',
      'mobile',
      'info',
      title,
      `mobile GET failed: ${bundle.mobileFetchError ?? 'unknown'}`,
    );
  }

  const { fail, warn } = mobileDiffs(bundle);

  if (fail.length > 0) {
    return makeFinding('discovery', 'mobile', 'fail', title, listed([...fail, ...warn]));
  }

  if (warn.length > 0) {
    return makeFinding('discovery', 'mobile', 'warn', title, listed(warn));
  }

  return makeFinding(
    'discovery',
    'mobile',
    'pass',
    title,
    'same status, canonical, robots, H1, and text',
  );
}

function headingOrderFinding(bundle: DiscoveryBundle): Finding {
  const outline = bundle.auditedPage.headings.outline;

  if (outline.length === 0) {
    return makeFinding('content', 'heading-order', 'info', 'Heading order', 'no headings');
  }

  const skip = firstHeadingSkip(outline);

  if (skip) {
    return makeFinding(
      'content',
      'heading-order',
      'warn',
      'Heading order',
      `H${skip.from} then H${skip.to}: "${skip.text}"`,
    );
  }

  return makeFinding('content', 'heading-order', 'pass', 'Heading order', 'no skipped level');
}

function parseDay(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const ts = Date.parse(value);

  return Number.isNaN(ts) ? null : ts;
}

/**
 * Date sanity against the fetch time: a future datePublished or dateModified
 * fails; a future visible date alone is info, because a `<time>` on the page
 * can be an event (a match, a webinar). Published after modified, a stale
 * modified date (over 365 days), or a sitemap lastmod far from dateModified warn.
 */
function dateSanityFinding(bundle: DiscoveryBundle): Finding {
  const { published, modified, visible } = bundle.auditedPage.dates;
  const now = parseDay(bundle.fetchedAt) ?? 0;
  const pub = parseDay(published);
  const mod = parseDay(modified);
  const vis = parseDay(visible);
  const lastmod = parseDay(bundle.sitemap.audited_url_lastmod);
  const isFuture = (ts: number | null): boolean => ts !== null && ts > now + DAY_MS;
  const future = (
    [
      ['published', pub],
      ['modified', mod],
    ] as const
  ).filter(([, ts]) => isFuture(ts));
  const title = 'Date sanity';

  if (future.length > 0) {
    return makeFinding(
      'content',
      'date-sanity',
      'fail',
      title,
      `future date: ${future.map(([name]) => name).join(', ')}`,
    );
  }

  const warn: string[] = [];

  if (pub !== null && mod !== null && pub > mod + DAY_MS) {
    warn.push('published after modified');
  }

  if (mod !== null && now - mod > 365 * DAY_MS) {
    warn.push(`modified ${Math.floor((now - mod) / DAY_MS)} days before fetch`);
  }

  if (mod !== null && lastmod !== null && Math.abs(mod - lastmod) > 7 * DAY_MS) {
    warn.push(`sitemap lastmod ${bundle.sitemap.audited_url_lastmod} vs modified ${modified}`);
  }

  if (warn.length > 0) {
    return makeFinding('content', 'date-sanity', 'warn', title, listed(warn));
  }

  if (isFuture(vis)) {
    return makeFinding(
      'content',
      'date-sanity',
      'info',
      title,
      `visible date ${visible} is after the fetch (an event date, or a wrong publication date)`,
    );
  }

  if (pub === null && mod === null && vis === null) {
    return makeFinding('content', 'date-sanity', 'info', title, 'no parseable date');
  }

  return makeFinding('content', 'date-sanity', 'pass', title, 'dates are consistent');
}

function hiddenTextFinding(bundle: DiscoveryBundle): Finding {
  const { elementCount, samples } = bundle.auditedPage.hiddenText;

  if (elementCount === 0) {
    return makeFinding(
      'content',
      'hidden-text',
      'pass',
      'Hidden text',
      'none in inline CSS or hidden attribute',
    );
  }

  return makeFinding(
    'content',
    'hidden-text',
    'warn',
    'Hidden text',
    `${elementCount} element(s), verify tabs or accordions: ${samples.map((text) => `"${text}"`).join('; ')}`,
  );
}

function mixedContentFinding(bundle: DiscoveryBundle): Finding {
  const { activeCount, passiveCount, samples } = bundle.auditedPage.mixedContent;
  const title = 'Mixed content';

  if (!bundle.auditedUrl.startsWith('https://')) {
    return makeFinding('content', 'mixed-content', 'info', title, 'page is not https');
  }

  if (activeCount + passiveCount === 0) {
    return makeFinding('content', 'mixed-content', 'pass', title, 'no http subresources');
  }

  return makeFinding(
    'content',
    'mixed-content',
    activeCount > 0 ? 'fail' : 'warn',
    title,
    `active=${activeCount} passive=${passiveCount}: ${listed(samples)}`,
  );
}

/** Hero image loading: lazy or missing `fetchpriority="high"` warns. No hero image gives no finding. */
function heroImageFinding(bundle: DiscoveryBundle): Finding | null {
  const hero = heroImageOf(bundle);

  if (!hero) {
    return null;
  }

  const lazy = hero.loading?.toLowerCase() === 'lazy';
  const prioritized = hero.fetchPriority?.toLowerCase() === 'high';
  const title = 'Hero image';

  if (lazy || !prioritized) {
    const reasons = [
      lazy ? 'loading="lazy"' : null,
      prioritized ? null : 'no fetchpriority="high"',
    ].filter((reason): reason is string => reason !== null);

    return makeFinding(
      'content',
      'hero-image',
      'warn',
      title,
      `${hero.src}: ${reasons.join(', ')}`,
    );
  }

  return makeFinding(
    'content',
    'hero-image',
    'pass',
    title,
    `${hero.src}: fetchpriority="high", eager`,
  );
}

function trustPagesFinding(bundle: DiscoveryBundle): Finding {
  const pages = bundle.auditedPage.trustPages;
  const missing = Object.entries(pages)
    .filter(([, href]) => href === null)
    .map(([name]) => name);
  const title = 'Trust pages linked';

  if (missing.length === 0) {
    return makeFinding('content', 'trust-pages', 'pass', title, 'about, contact, privacy, terms');
  }

  return makeFinding(
    'content',
    'trust-pages',
    missing.length >= 3 ? 'warn' : 'info',
    title,
    `not linked: ${missing.join(', ')}`,
  );
}

/** Snippet limits from meta robots, per-bot meta, `data-nosnippet`, and `X-Robots-Tag`. */
function snippetFinding(bundle: DiscoveryBundle): Finding {
  const page = bundle.auditedPage;
  const header = bundle.securityHeaders.x_robots_tag ?? '';
  const snippet = page.snippetDirectives;
  const headerMax = header.match(/max-snippet:\s*([^,\s]+)/i)?.[1] ?? null;
  const warn: string[] = [];
  const info: string[] = [];

  if (snippet.nosnippet || /\bnosnippet\b/i.test(header)) {
    warn.push('nosnippet');
  }

  if (snippet.maxSnippet === '0' || headerMax === '0') {
    warn.push('max-snippet:0');
  } else if (snippet.maxSnippet ?? headerMax) {
    info.push(`max-snippet:${snippet.maxSnippet ?? headerMax}`);
  }

  if (snippet.dataNosnippet) {
    info.push('data-nosnippet on part of the page');
  }

  if (snippet.noarchive || /\bnoarchive\b/i.test(header)) {
    info.push('noarchive');
  }

  if (snippet.unavailableAfter || /unavailable_after/i.test(header)) {
    info.push(`unavailable_after ${snippet.unavailableAfter ?? '(header)'}`);
  }

  const title = 'Snippet limits';

  if (warn.length > 0) {
    return makeFinding('meta', 'snippet-limits', 'warn', title, listed([...warn, ...info]));
  }

  if (info.length > 0) {
    return makeFinding('meta', 'snippet-limits', 'info', title, listed(info));
  }

  return makeFinding('meta', 'snippet-limits', 'pass', title, 'no snippet limits');
}

function charsetFinding(bundle: DiscoveryBundle): Finding {
  const contentType = bundle.pageHeaders['content-type'] ?? '';
  const header = contentType.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase() ?? null;
  const meta = bundle.auditedPage.charset;
  const charset = header ?? meta;

  if (!charset) {
    return makeFinding('meta', 'charset', 'warn', 'Charset', 'no header or meta charset');
  }

  if (header && meta && header !== meta) {
    return makeFinding('meta', 'charset', 'warn', 'Charset', `header ${header} vs meta ${meta}`);
  }

  return makeFinding('meta', 'charset', charset === 'utf-8' ? 'pass' : 'info', 'Charset', charset);
}

function headerCanonicalFinding(bundle: DiscoveryBundle): Finding | null {
  const page = bundle.auditedPage;

  if (!page.headerCanonical) {
    return null;
  }

  const expected = pageKey(page.canonicalUrl ?? page.url);
  const actual = pageKey(page.headerCanonical);
  const matches = actual === expected;

  return makeFinding(
    'meta',
    'header-canonical',
    matches ? 'pass' : 'warn',
    'Link header canonical',
    matches ? page.headerCanonical : `${page.headerCanonical} vs ${page.canonicalUrl ?? page.url}`,
  );
}

function hreflangFinding(bundle: DiscoveryBundle): Finding | null {
  const page = bundle.auditedPage;

  if (page.hreflangLinks.length === 0 && page.headerHreflang.length === 0) {
    return null;
  }

  const issues = hreflangIssues(page);
  const count = Math.max(page.hreflangLinks.length, page.headerHreflang.length);

  return makeFinding(
    'meta',
    'hreflang',
    issues.length > 0 ? 'warn' : 'pass',
    'hreflang',
    issues.length > 0 ? issues.join('; ') : `${count} alternates, self and x-default ok`,
  );
}

/** A path segment or file-name part that is a logo or an icon, such as `site-logo.png` or `/icons/`. */
const LOGO_PATH = /(?:^|[/_.-])(?:logo|icons?|favicon)(?:[/_.-]|$)/i;

/** og:image whose path names a logo or icon, while the page has a hero image. Warns only in that case. */
function ogImageHeroFinding(bundle: DiscoveryBundle): Finding | null {
  const ogImage = bundle.auditedPage.social.openGraph.image;
  const hero = heroImageOf(bundle);

  if (!ogImage || !hero) {
    return null;
  }

  if (!LOGO_PATH.test(new URL(ogImage).pathname)) {
    return null;
  }

  return makeFinding(
    'meta',
    'og-image-hero',
    'warn',
    'og:image hero',
    `og:image ${ogImage} looks like a logo or icon; hero image ${hero.src}`,
  );
}

/** Page-level meta findings that need headers or parsed page facts. */
export function pageMetaFindings(bundle: DiscoveryBundle): Finding[] {
  return presentFindings([
    snippetFinding(bundle),
    charsetFinding(bundle),
    headerCanonicalFinding(bundle),
    hreflangFinding(bundle),
    ogImageHeroFinding(bundle),
  ]);
}

const MISSING_PAGE_TEXT =
  /not found|página não encontrada|page not found|não existe|^\s*404\b|\b(?:erro|error) 404\b/i;
/** In a title segment or an H1, a 404 counts only at the start, so "Top 404 errors" is not a missing page. */
const MISSING_PAGE_HEADING =
  /not found|página não encontrada|page not found|não existe|^\s*(?:404|erro 404|error 404)\b/i;
/** Title segments: "404 - Página não encontrada | Loja" has three. A colon does not split. */
const TITLE_SEPARATOR = /\s+[-–—|]\s+|[|–—]/;
/** A missing-page heading is short. "Erro 404: como corrigir no WordPress" is an article title. */
const SOFT_404_SEGMENT_WORD_CAP = 5;
const SOFT_404_WORD_CAP = 50;
/** A title or H1 that names a missing page counts only on a short page; articles about 404 errors do not. */
const SOFT_404_HEADING_WORD_CAP = 300;

function namesMissingPage(text: string): boolean {
  return text.split(TITLE_SEPARATOR).some((segment) => {
    const words = segment.trim().split(/\s+/).filter(Boolean);

    return (
      words.length > 0 &&
      words.length <= SOFT_404_SEGMENT_WORD_CAP &&
      MISSING_PAGE_HEADING.test(words.join(' '))
    );
  });
}

/**
 * A 2xx page whose title or H1 says it is missing, or whose thin text does.
 * Google reads these as soft 404s. The score does not change (D3).
 */
function soft404Finding(bundle: DiscoveryBundle): Finding | null {
  const page = bundle.auditedPage;

  if (page.statusCode < 200 || page.statusCode >= 300) {
    return null;
  }

  const title = 'Soft 404';
  const headingSays =
    page.wordCount < SOFT_404_HEADING_WORD_CAP &&
    ((page.title !== null && namesMissingPage(page.title)) ||
      page.headings.h1.some(namesMissingPage));
  const thinSays = page.wordCount < SOFT_404_WORD_CAP && MISSING_PAGE_TEXT.test(page.mainText);

  if (headingSays) {
    return makeFinding(
      'content',
      'soft-404',
      'fail',
      title,
      'title or H1 says the page is missing',
    );
  }

  if (thinSays) {
    return makeFinding(
      'content',
      'soft-404',
      'fail',
      title,
      `${page.wordCount} words and missing-page text on a 2xx page`,
    );
  }

  return makeFinding('content', 'soft-404', 'pass', title, 'no missing-page text on a 2xx page');
}

const SESSION_PARAMS = new Set(['jsessionid', 'phpsessid', 'sid', 'sessionid']);
const URL_QUERY_CAP = 3;
const URL_DEPTH_CAP = 4;

function hasSessionId(url: URL): boolean {
  const inPath = /;jsessionid=/i.test(url.pathname);
  const inQuery = [...url.searchParams.keys()].some((key) => SESSION_PARAMS.has(key.toLowerCase()));

  return inPath || inQuery;
}

/**
 * URL shape from the technical KB: uppercase in the path, `_` in the slug, a
 * session id (warn), more than 3 query parameters, or depth above 4 (info).
 */
function urlStructureFinding(bundle: DiscoveryBundle): Finding {
  const url = new URL(bundle.auditedPage.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const queryCount = url.searchParams.size;
  const hasUppercase = /[A-Z]/.test(url.pathname.replace(/%[0-9a-f]{2}/gi, ''));
  const sessionId = hasSessionId(url);
  const notes: string[] = [];

  if (sessionId) {
    notes.push('session id in URL');
  }

  if (hasUppercase) {
    notes.push('uppercase in path');
  }

  if ((segments.at(-1) ?? '').includes('_')) {
    notes.push('underscore in slug');
  }

  if (queryCount > URL_QUERY_CAP) {
    notes.push(`${queryCount} query parameters`);
  }

  if (segments.length > URL_DEPTH_CAP) {
    notes.push(`depth ${segments.length}`);
  }

  const title = 'URL structure';

  if (notes.length === 0) {
    return makeFinding('content', 'url-structure', 'pass', title, 'clean URL');
  }

  const severity = sessionId ? 'warn' : 'info';

  return makeFinding('content', 'url-structure', severity, title, notes.join(', '));
}

/** Page-level content findings for the SEO kind. */
export function pageContentFindings(bundle: DiscoveryBundle): Finding[] {
  return presentFindings([
    headingOrderFinding(bundle),
    dateSanityFinding(bundle),
    hiddenTextFinding(bundle),
    mixedContentFinding(bundle),
    trustPagesFinding(bundle),
    heroImageFinding(bundle),
    soft404Finding(bundle),
    urlStructureFinding(bundle),
  ]);
}

const GENERIC_ANCHOR =
  /^(?:click here|here|read more|more|learn more|link|this|saiba mais|clique aqui|aqui|leia mais|ver mais|veja mais)$/i;
const ANCHOR_LIST_CAP = 20;

/** No visible text, and no `aria-label` or non-empty image alt to name the link. */
function unnamedAnchor(link: PageLink): boolean {
  return link.text.trim() === '' && !link.ariaLabel && !link.imgAlt;
}

function genericAnchor(link: PageLink): boolean {
  return unnamedAnchor(link) || GENERIC_ANCHOR.test(link.text.trim());
}

function brokenLinkFinding(bundle: DiscoveryBundle): Finding {
  const results = bundle.linkStatus.results;
  const broken = (scope: string) =>
    results.filter((r) => r.scope === scope && r.status !== null && r.status >= 400);
  const internal = broken('internal');
  const failed = results.filter((r) => r.status === null);
  const describe = (items: typeof results) =>
    items.map((r) => `${r.href} (${r.status ?? r.error})`);
  const title = 'Link status';
  const checked = `${bundle.linkStatus.checked} checked`;

  if (internal.length > 0) {
    return makeFinding(
      'links',
      'status',
      'fail',
      title,
      `${checked}; broken internal: ${listed(describe(internal))}`,
    );
  }

  if (failed.length > 0) {
    return makeFinding(
      'links',
      'status',
      'info',
      title,
      `${checked}; not reached: ${listed(describe(failed))}`,
    );
  }

  return makeFinding('links', 'status', 'pass', title, `${checked}; all 2xx/3xx`);
}

function redirectedLinkFinding(bundle: DiscoveryBundle): Finding {
  const redirected = bundle.linkStatus.results.filter(
    (r) => r.scope === 'internal' && r.redirects > 0 && r.finalUrl,
  );

  if (redirected.length === 0) {
    return makeFinding('links', 'redirects', 'pass', 'Internal link redirects', 'none');
  }

  return makeFinding(
    'links',
    'redirects',
    'warn',
    'Internal link redirects',
    listed(redirected.map((r) => `${r.href} → ${r.finalUrl}`)),
  );
}

function anchorTextFinding(bundle: DiscoveryBundle): Finding {
  const page = bundle.auditedPage;
  const generic = [...page.internalLinks, ...page.outboundLinks]
    .filter(genericAnchor)
    .map((link) =>
      unnamedAnchor(link) ? `(no text) → ${link.href}` : `"${link.text}" → ${link.href}`,
    );

  if (generic.length === 0) {
    return makeFinding('links', 'anchor-text', 'pass', 'Anchor text', 'no generic anchors');
  }

  return makeFinding(
    'links',
    'anchor-text',
    'warn',
    'Anchor text',
    listed(generic, ANCHOR_LIST_CAP),
  );
}

/** Link findings. Status rows only when `audit` ran the probe. */
export function pageLinkFindings(bundle: DiscoveryBundle): Finding[] {
  const anchors = anchorTextFinding(bundle);

  if (bundle.linkStatus.status !== 'completed') {
    return [anchors];
  }

  return [brokenLinkFinding(bundle), redirectedLinkFinding(bundle), anchors];
}
