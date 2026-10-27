import { pageKey } from '../lib/url.ts';
import type { DiscoveryBundle } from './discovery.ts';
import { hreflangIssues } from './hreflang.ts';
import { firstHeadingSkip } from './parsers/pageHygiene.ts';
import { SEARCH_BOTS } from './scoring.ts';
import type { Finding, FindingSeverity, PageLink } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_LIST_CAP = 5;

function finding(
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

/** Googlebot and Bingbot access to the audited path in robots.txt. Gate finding. */
export function searchCrawlerFinding(bundle: DiscoveryBundle): Finding {
  const rows = bundle.crawlerAccess.crawlers.filter((c) =>
    (SEARCH_BOTS as readonly string[]).includes(c.bot),
  );
  const title = 'Search crawlers on this path';

  if (rows.length === 0) {
    return finding('discovery', 'search-crawlers', 'info', title, 'robots.txt not read');
  }

  const detail = rows.map((c) => `${c.bot}=${c.status}`).join(' ');
  const blocked = rows.some((c) => c.status === 'blocked');

  return finding('discovery', 'search-crawlers', blocked ? 'fail' : 'pass', title, detail);
}

function mobileDiffs(bundle: DiscoveryBundle): { fail: string[]; warn: string[] } {
  const desk = bundle.auditedPage;
  const mobile = bundle.mobilePage!;
  const fail: string[] = [];
  const warn: string[] = [];

  if (/\bnoindex\b|\bnone\b/i.test(mobile.effectiveRobotsDirective ?? '')) {
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
    return finding(
      'discovery',
      'mobile',
      'info',
      title,
      `mobile GET failed: ${bundle.mobileFetchError ?? 'unknown'}`,
    );
  }

  const { fail, warn } = mobileDiffs(bundle);

  if (fail.length > 0) {
    return finding('discovery', 'mobile', 'fail', title, listed([...fail, ...warn]));
  }

  if (warn.length > 0) {
    return finding('discovery', 'mobile', 'warn', title, listed(warn));
  }

  return finding(
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
    return finding('content', 'heading-order', 'info', 'Heading order', 'no headings');
  }

  const skip = firstHeadingSkip(outline);

  if (skip) {
    return finding(
      'content',
      'heading-order',
      'warn',
      'Heading order',
      `H${skip.from} then H${skip.to}: "${skip.text}"`,
    );
  }

  return finding('content', 'heading-order', 'pass', 'Heading order', 'no skipped level');
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
    return finding(
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
    return finding('content', 'date-sanity', 'warn', title, listed(warn));
  }

  if (isFuture(vis)) {
    return finding(
      'content',
      'date-sanity',
      'info',
      title,
      `visible date ${visible} is after the fetch (an event date, or a wrong publication date)`,
    );
  }

  if (pub === null && mod === null && vis === null) {
    return finding('content', 'date-sanity', 'info', title, 'no parseable date');
  }

  return finding('content', 'date-sanity', 'pass', title, 'dates are consistent');
}

function hiddenTextFinding(bundle: DiscoveryBundle): Finding {
  const { elementCount, samples } = bundle.auditedPage.hiddenText;

  if (elementCount === 0) {
    return finding(
      'content',
      'hidden-text',
      'pass',
      'Hidden text',
      'none in inline CSS or hidden attribute',
    );
  }

  return finding(
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
    return finding('content', 'mixed-content', 'info', title, 'page is not https');
  }

  if (activeCount + passiveCount === 0) {
    return finding('content', 'mixed-content', 'pass', title, 'no http subresources');
  }

  return finding(
    'content',
    'mixed-content',
    activeCount > 0 ? 'fail' : 'warn',
    title,
    `active=${activeCount} passive=${passiveCount}: ${listed(samples)}`,
  );
}

/** Hero image loading: lazy or missing `fetchpriority="high"` warns. No hero image gives no finding. */
function heroImageFinding(bundle: DiscoveryBundle): Finding | null {
  const hero = bundle.auditedPage.images.items.find((item) => item.hero);

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

    return finding('content', 'hero-image', 'warn', title, `${hero.src}: ${reasons.join(', ')}`);
  }

  return finding(
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
    return finding('content', 'trust-pages', 'pass', title, 'about, contact, privacy, terms');
  }

  return finding(
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
    return finding('meta', 'snippet-limits', 'warn', title, listed([...warn, ...info]));
  }

  if (info.length > 0) {
    return finding('meta', 'snippet-limits', 'info', title, listed(info));
  }

  return finding('meta', 'snippet-limits', 'pass', title, 'no snippet limits');
}

function charsetFinding(bundle: DiscoveryBundle): Finding {
  const contentType = bundle.pageHeaders['content-type'] ?? '';
  const header = contentType.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase() ?? null;
  const meta = bundle.auditedPage.charset;
  const charset = header ?? meta;

  if (!charset) {
    return finding('meta', 'charset', 'warn', 'Charset', 'no header or meta charset');
  }

  if (header && meta && header !== meta) {
    return finding('meta', 'charset', 'warn', 'Charset', `header ${header} vs meta ${meta}`);
  }

  return finding('meta', 'charset', charset === 'utf-8' ? 'pass' : 'info', 'Charset', charset);
}

function headerCanonicalFinding(bundle: DiscoveryBundle): Finding | null {
  const page = bundle.auditedPage;

  if (!page.headerCanonical) {
    return null;
  }

  const expected = pageKey(page.canonicalUrl ?? page.url);
  const actual = pageKey(page.headerCanonical);

  return finding(
    'meta',
    'header-canonical',
    actual === expected ? 'pass' : 'warn',
    'Link header canonical',
    actual === expected
      ? page.headerCanonical
      : `${page.headerCanonical} vs ${page.canonicalUrl ?? page.url}`,
  );
}

function hreflangFinding(bundle: DiscoveryBundle): Finding | null {
  const page = bundle.auditedPage;

  if (page.hreflangLinks.length === 0 && page.headerHreflang.length === 0) {
    return null;
  }

  const issues = hreflangIssues(page);
  const count = Math.max(page.hreflangLinks.length, page.headerHreflang.length);

  return finding(
    'meta',
    'hreflang',
    issues.length > 0 ? 'warn' : 'pass',
    'hreflang',
    issues.length > 0 ? issues.join('; ') : `${count} alternates, self and x-default ok`,
  );
}

const LOGO_PATH = /logo|icon/i;

/** og:image whose path names a logo or icon, while the page has a hero image. Warns only in that case. */
function ogImageHeroFinding(bundle: DiscoveryBundle): Finding | null {
  const ogImage = bundle.auditedPage.social.openGraph.image;
  const hero = bundle.auditedPage.images.items.find((item) => item.hero);

  if (!ogImage || !hero) {
    return null;
  }

  if (!LOGO_PATH.test(new URL(ogImage).pathname)) {
    return null;
  }

  return finding(
    'meta',
    'og-image-hero',
    'warn',
    'og:image hero',
    `og:image ${ogImage} looks like a logo or icon; hero image ${hero.src}`,
  );
}

/** Page-level meta findings that need headers or parsed page facts. */
export function pageMetaFindings(bundle: DiscoveryBundle): Finding[] {
  return [
    snippetFinding(bundle),
    charsetFinding(bundle),
    headerCanonicalFinding(bundle),
    hreflangFinding(bundle),
    ogImageHeroFinding(bundle),
  ].filter((item): item is Finding => item !== null);
}

/** Page-level content findings for the SEO kind. */
export function pageContentFindings(bundle: DiscoveryBundle): Finding[] {
  return [
    headingOrderFinding(bundle),
    dateSanityFinding(bundle),
    hiddenTextFinding(bundle),
    mixedContentFinding(bundle),
    trustPagesFinding(bundle),
    heroImageFinding(bundle),
  ].filter((item): item is Finding => item !== null);
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
    return finding(
      'links',
      'status',
      'fail',
      title,
      `${checked}; broken internal: ${listed(describe(internal))}`,
    );
  }

  if (failed.length > 0) {
    return finding(
      'links',
      'status',
      'info',
      title,
      `${checked}; not reached: ${listed(describe(failed))}`,
    );
  }

  return finding('links', 'status', 'pass', title, `${checked}; all 2xx/3xx`);
}

function redirectedLinkFinding(bundle: DiscoveryBundle): Finding {
  const redirected = bundle.linkStatus.results.filter(
    (r) => r.scope === 'internal' && r.redirects > 0 && r.finalUrl,
  );

  if (redirected.length === 0) {
    return finding('links', 'redirects', 'pass', 'Internal link redirects', 'none');
  }

  return finding(
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
    return finding('links', 'anchor-text', 'pass', 'Anchor text', 'no generic anchors');
  }

  return finding('links', 'anchor-text', 'warn', 'Anchor text', listed(generic, ANCHOR_LIST_CAP));
}

/** Link findings. Status rows only when `audit` ran the probe. */
export function pageLinkFindings(bundle: DiscoveryBundle): Finding[] {
  const anchors = anchorTextFinding(bundle);

  if (bundle.linkStatus.status !== 'completed') {
    return [anchors];
  }

  return [brokenLinkFinding(bundle), redirectedLinkFinding(bundle), anchors];
}
