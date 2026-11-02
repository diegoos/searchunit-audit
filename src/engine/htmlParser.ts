import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { PageLink, SnippetDirectives } from './types.ts';
import { pageKey, stripUserinfo } from '../lib/url.ts';
import { extractCitabilityOpening, extractCitabilityTexts } from './citabilityBlocks.ts';
import { extractExternalResources, type ExternalResources } from './parsers/externalResources.ts';
import {
  detectJsRenderingRisk,
  extractContentSignals,
  type ContentSignals,
  type JsRenderingRisk,
} from './parsers/contentSignals.ts';

import {
  extractAuthors,
  extractDates,
  type MetaRobotsByBot,
  type PageAuthor,
  type PageDates,
} from './parsers/metaSignals.ts';

import {
  detectSpeakable,
  extractMarkupFormats,
  extractStructuredData,
  type MarkupFormats,
  type StructuredDataSummary,
} from './parsers/structuredData.ts';

import {
  extractDiscoverSignals,
  extractImageSignals,
  extractVideoSignals,
  type DiscoverSignals,
  type ImageSignals,
  type VideoSignal,
} from './parsers/imageDiscover.ts';
import {
  parseJsonLdScripts,
  parseSchemaFromScripts,
  type ParsedSchemaBlock,
} from '../tools/schema/parseSchema.ts';
import { parseMetaFromDom, type MetaTags } from '../tools/meta/parseMeta.ts';
import { collapseWhitespace, extractMainContent } from './parsers/mainContent.ts';
import {
  extractCharset,
  extractHeadingOutline,
  extractHiddenText,
  extractMixedContent,
  extractSameHostResources,
  extractTrustPages,
  sameSite,
  type HeadingOutlineItem,
  type HiddenText,
  type MixedContent,
  type TrustPages,
} from './parsers/pageHygiene.ts';

export type { StructuredDataSummary };

export interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsDirective: string | null;
  lang: string | null;
  internalLinks: PageLink[];
  internalLinkCount: number;
  internalLinksTruncated: boolean;
  outboundLinks: PageLink[];
  outboundLinksTruncated: boolean;
  snippetDirectives: SnippetDirectives;
  internalLinkIndex: string[];
  internalLinkIndexTruncated: boolean;
  sitemapUrls: string[];
  /** Words in the main content root (see `extractMainContent`). */
  wordCount: number;
  /** Words in the whole visible body, page chrome included. */
  bodyWordCount: number;
  /** Full main content text (see `extractMainContent`). */
  mainText: string;
  /** Main content tables as rows of cell texts. */
  tables: string[][][];
  mixedContent: MixedContent;
  hiddenText: HiddenText;
  charset: string | null;
  trustPages: TrustPages;
  externalResources: ExternalResources;
  structuredData: StructuredDataSummary;
  headings: {
    h1: string[];
    h1Count: number;
    h1ElementCount: number;
    h2: string[];
    h2Count: number;
    h2NonEmpty: number;
    h3: string[];
    h3Count: number;
    h3NonEmpty: number;
    /** H1–H6 in document order, at most 60. */
    outline: HeadingOutlineItem[];
  };
  viewport: boolean;
  hreflang: string[];
  hreflangLinks: { lang: string; href: string }[];
  pagination: { next: string | null; prev: string | null };
  breadcrumbParent: string | null;
  visibleTextSha256: string;
  visibleTextExcerpt: string;
  dates: PageDates;
  author: PageAuthor;
  social: {
    openGraph: {
      title: string | null;
      description: string | null;
      image: string | null;
      type: string | null;
      url: string | null;
      locale: string | null;
    };
    twitter: { card: string | null };
  };
  contentSignals: ContentSignals;
  markupFormats: MarkupFormats;
  metaRobotsByBot: MetaRobotsByBot;
  jsRenderingRisk: JsRenderingRisk;
  images: ImageSignals;
  videos: VideoSignal[];
  discover: DiscoverSignals;
  citabilityTexts: string[];
  citabilityOpening: string | null;
  hasSpeakable: boolean;
  visibleText: string;
  schemaBlocks: ParsedSchemaBlock[];
  metaTags: MetaTags;
  sameHostResources: string[];
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** `link[rel=sitemap]` plus same-document anchors whose path looks like a sitemap file. */
function extractSitemapUrls($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const add = (href: string | undefined): void => {
    const trimmed = href?.trim();

    if (!trimmed) {
      return;
    }

    try {
      const resolved = new URL(trimmed, baseUrl);

      if (!isHttpUrl(resolved)) {
        return;
      }

      if (seen.has(resolved.href)) {
        return;
      }

      seen.add(resolved.href);
      urls.push(resolved.href);
    } catch {
      // skip invalid URLs
    }
  };
  $('link[href]').each((_, el) => {
    const rel = $(el).attr('rel') ?? '';

    if (rel.split(/\s+/).some((token) => token.toLowerCase() === 'sitemap')) {
      add($(el).attr('href'));
    }
  });
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');

    if (!href) {
      return;
    }

    try {
      if (/sitemap[^/]*\.(xml|txt)(\.gz)?$/i.test(new URL(href, baseUrl).pathname)) {
        add(href);
      }
    } catch {
      // skip invalid URLs
    }
  });

  return urls;
}

function visibleBodyText($: cheerio.CheerioAPI): string {
  const clone = $('body').clone();

  clone.find('script, style, noscript, template').remove();

  return collapseWhitespace(clone.text());
}

function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

const HEADING_TEXT_CAP = 40;
const INTERNAL_LINK_CAP = 50;
const INTERNAL_LINK_INDEX_CAP = 2000;
const OUTBOUND_LINK_CAP = 40;
const ANCHOR_TEXT_CAP = 160;
const VISIBLE_TEXT_EXCERPT = 240;

function skipLinkHref(href: string): boolean {
  return !href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:');
}

/** `href` resolved against `base` without userinfo, or null when it is not an http(s) URL. */
function parseHttpUrl(href: string, base: URL): URL | null {
  try {
    const resolved = stripUserinfo(new URL(href, base));

    return isHttpUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function resolvedHttpUrl(href: string, base: URL): URL | null {
  return skipLinkHref(href) ? null : parseHttpUrl(href, base);
}

function pushLink(links: PageLink[], seen: Set<string>, link: PageLink, cap: number): void {
  if (seen.has(link.href)) {
    return;
  }

  seen.add(link.href);

  if (links.length < cap) {
    links.push(link);
  }
}

/** Accessible name parts of an anchor: its `aria-label`, and the first non-empty `img` alt inside it. */
function anchorNameParts(
  $: cheerio.CheerioAPI,
  el: Parameters<cheerio.CheerioAPI>[0],
): { ariaLabel: string | null; imgAlt: string | null } {
  const ariaLabel = $(el).attr('aria-label')?.trim().slice(0, ANCHOR_TEXT_CAP) || null;
  const alts = $(el)
    .find('img[alt]')
    .toArray()
    .map((img) => $(img).attr('alt')?.trim().slice(0, ANCHOR_TEXT_CAP) ?? '');
  const imgAlt = alts.find((alt) => alt.length > 0) ?? null;

  return { ariaLabel, imgAlt };
}

function directiveToken(text: string, token: string): boolean {
  return new RegExp(`(?:^|[\\s,])${token}(?:$|[\\s,])`, 'i').test(text);
}

function readSnippetDirectives(contents: string[], dataNosnippet: boolean): SnippetDirectives {
  const text = contents.filter((item) => item.trim()).join(', ');
  const maxSnippet = text.match(/max-snippet:\s*([^,\s]+)/i);
  const unavailableAfter = text.match(/unavailable_after:\s*([^,]+)/i);

  return {
    nosnippet: directiveToken(text, 'nosnippet'),
    maxSnippet: maxSnippet?.[1] ?? null,
    noarchive: directiveToken(text, 'noarchive'),
    unavailableAfter: unavailableAfter?.[1]?.trim() ?? null,
    dataNosnippet,
  };
}

function headingTexts(
  $: cheerio.CheerioAPI,
  selector: string,
  cap: number,
): { texts: string[]; nonEmpty: number } {
  const texts: string[] = [];
  let nonEmpty = 0;

  $(selector).each((_, el) => {
    const text = $(el).text().trim();

    if (!text) {
      return;
    }

    nonEmpty++;

    if (texts.length < cap) {
      texts.push(text);
    }
  });

  return { texts, nonEmpty };
}

function readHreflang(
  $: cheerio.CheerioAPI,
  base: URL,
): { hreflang: string[]; hreflangLinks: { lang: string; href: string }[] } {
  const hreflang: string[] = [];
  const hreflangLinks: { lang: string; href: string }[] = [];

  $('link[hreflang]').each((_, el) => {
    const rel = $(el).attr('rel') ?? '';

    if (!rel.split(/\s+/).some((token) => token.toLowerCase() === 'alternate')) {
      return;
    }

    const code = $(el).attr('hreflang')?.trim();

    if (code) {
      hreflang.push(code);
    }

    const hrefAttr = $(el).attr('href');

    if (!code || hrefAttr === undefined) {
      return;
    }

    const href = httpUrl(hrefAttr, base);

    if (!href) {
      return;
    }

    hreflangLinks.push({ lang: code, href });
  });

  return { hreflang, hreflangLinks };
}

function readPageLinks(
  $: cheerio.CheerioAPI,
  base: URL,
): {
  internalLinks: PageLink[];
  internalLinkCount: number;
  internalLinksTruncated: boolean;
  internalLinkIndex: string[];
  internalLinkIndexTruncated: boolean;
  outboundLinks: PageLink[];
  outboundLinksTruncated: boolean;
} {
  const internalSeen = new Set<string>();
  const outboundSeen = new Set<string>();
  const index = new Set<string>();
  const internalLinks: PageLink[] = [];
  const outboundLinks: PageLink[] = [];
  const internalLinkIndex: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');

    if (!href) {
      return;
    }

    const resolved = resolvedHttpUrl(href, base);

    if (!resolved) {
      return;
    }

    const value = resolved.toString();
    const text = collapseWhitespace($(el).text()).slice(0, ANCHOR_TEXT_CAP);
    const link: PageLink = { href: value, text, ...anchorNameParts($, el) };

    if (!sameSite(resolved, base)) {
      pushLink(outboundLinks, outboundSeen, link, OUTBOUND_LINK_CAP);

      return;
    }

    pushLink(internalLinks, internalSeen, link, INTERNAL_LINK_CAP);

    const key = pageKey(value);

    if (key && !index.has(key)) {
      index.add(key);

      if (internalLinkIndex.length < INTERNAL_LINK_INDEX_CAP) {
        internalLinkIndex.push(key);
      }
    }
  });

  return {
    internalLinks,
    internalLinkCount: internalSeen.size,
    internalLinksTruncated: internalSeen.size > INTERNAL_LINK_CAP,
    internalLinkIndex,
    internalLinkIndexTruncated: index.size > INTERNAL_LINK_INDEX_CAP,
    outboundLinks,
    outboundLinksTruncated: outboundSeen.size > OUTBOUND_LINK_CAP,
  };
}

function anchorByRel($: cheerio.CheerioAPI, rel: string, base: URL): string | null {
  let found: string | null = null;

  $('a[href]').each((_, el) => {
    const tokens = ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/);
    const matches = tokens.includes(rel) || (rel === 'prev' && tokens.includes('previous'));

    if (!matches) {
      return;
    }

    found = httpUrl($(el).attr('href') ?? '', base);

    return false;
  });

  return found;
}

function readPagination(
  $: cheerio.CheerioAPI,
  base: URL,
): { next: string | null; prev: string | null } {
  const next = $('link[rel~="next"]').attr('href');
  const prev = $('link[rel~="prev"], link[rel~="previous"]').attr('href');

  return {
    next: (next ? httpUrl(next, base) : null) ?? anchorByRel($, 'next', base),
    prev: (prev ? httpUrl(prev, base) : null) ?? anchorByRel($, 'prev', base),
  };
}

function resolveAuthorUrls(author: PageAuthor, base: URL): PageAuthor {
  const urls: string[] = [];

  for (const href of author.urls) {
    const resolved = httpUrl(href, base);

    if (resolved && !urls.includes(resolved)) {
      urls.push(resolved);
    }

    if (urls.length >= 5) {
      break;
    }
  }

  return { ...author, urls };
}

function listItemUrl(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const item = record.item ?? record.url ?? record['@id'];

  if (typeof item === 'string') {
    return item;
  }

  if (!item || typeof item !== 'object') {
    return null;
  }

  const nested = item as Record<string, unknown>;

  if (typeof nested.url === 'string') {
    return nested.url;
  }

  if (typeof nested['@id'] === 'string') {
    return nested['@id'];
  }

  return null;
}

function listItemPosition(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const raw = (entry as Record<string, unknown>).position;

  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return null;
  }

  const position = Number(raw);

  return Number.isFinite(position) ? position : null;
}

/** Sorts by `position` only when every entry has one; otherwise keeps document order. */
function orderedListItems(items: unknown[]): unknown[] {
  const positions = items.map((entry) => listItemPosition(entry));

  if (positions.some((position) => position === null)) {
    return items;
  }

  return items
    .map((entry, index) => ({ entry, position: positions[index] ?? 0 }))
    .toSorted((a, b) => a.position - b.position)
    .map((item) => item.entry);
}

function breadcrumbParent(blocks: unknown[], base: URL): string | null {
  // Entries without a URL stay in the list so the parent index counts the current page too.
  const hrefs: (string | null)[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }

      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    const record = node as Record<string, unknown>;
    const type = record['@type'];
    const types = Array.isArray(type) ? type : [type];
    const isCrumb = types.some((item) => String(item).toLowerCase() === 'breadcrumblist');

    if (isCrumb && Array.isArray(record.itemListElement)) {
      for (const entry of orderedListItems(record.itemListElement)) {
        const href = listItemUrl(entry);

        hrefs.push(href ? httpUrl(href, base) : null);
      }
    }

    if (Array.isArray(record['@graph'])) {
      visit(record['@graph']);
    }
  };
  for (const block of blocks) {
    visit(block);
  }

  return parentCrumbHref(hrefs);
}

function htmlBreadcrumbParent($: cheerio.CheerioAPI, base: URL): string | null {
  const hrefs: string[] = [];

  $('nav[aria-label] a[href], [class*="breadcrumb"] a[href]').each((_, el) => {
    const label = $(el).closest('nav').attr('aria-label') ?? '';
    const className = $(el).closest('[class*="breadcrumb"]').attr('class') ?? '';

    if (!/breadcrumb/i.test(label) && !/breadcrumb/i.test(className)) {
      return;
    }

    const href = httpUrl($(el).attr('href') ?? '', base);

    if (href) {
      hrefs.push(href);
    }
  });

  return parentCrumbHref(hrefs);
}

/** The parent is the second-to-last crumb; a single crumb has no parent. */
function parentCrumbHref(hrefs: readonly (string | null)[]): string | null {
  return hrefs.length >= 2 ? (hrefs[hrefs.length - 2] ?? null) : null;
}

function resolvedBreadcrumb($: cheerio.CheerioAPI, blocks: unknown[], base: URL): string | null {
  return breadcrumbParent(blocks, base) ?? htmlBreadcrumbParent($, base);
}

function visibleTextFacts(text: string): { visibleTextSha256: string; visibleTextExcerpt: string } {
  const collapsed = collapseWhitespace(text);

  return {
    visibleTextSha256: createHash('sha256').update(collapsed).digest('hex'),
    visibleTextExcerpt: collapsed.slice(0, VISIBLE_TEXT_EXCERPT),
  };
}

function pageSocial(tags: MetaTags, base: URL): ParsedPage['social'] {
  return {
    openGraph: {
      title: tags.ogTitle?.trim() || null,
      description: tags.ogDescription?.trim() || null,
      image: tags.ogImage ? httpUrl(tags.ogImage, base) : null,
      type: tags.ogType ?? null,
      url: tags.ogUrl ? httpUrl(tags.ogUrl, base) : null,
      locale: tags.ogLocale?.trim() || null,
    },
    twitter: {
      card: tags.twitterCard?.trim() || null,
    },
  };
}

function httpUrl(href: string, base: URL): string | null {
  return parseHttpUrl(href, base)?.toString() ?? null;
}

/** Loads the HTML and extracts the full {@link ParsedPage} by orchestrating the sub-parsers. */
export function parseHtmlPage(
  html: string,
  baseUrl: string,
  headingCap = HEADING_TEXT_CAP,
): ParsedPage {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  const tags = parseMetaFromDom($);
  const title = tags.title ?? null;
  const lang = tags.lang ?? null;
  const metaDescription = tags.description ?? null;
  const canonical = tags.canonical ?? null;
  const robots = tags.robotsMeta ?? null;

  const { hreflang, hreflangLinks } = readHreflang($, base);
  const pagination = readPagination($, base);
  const h1ElementCount = $('h1').length;
  const h1 = headingTexts($, 'h1', Number.POSITIVE_INFINITY);
  const h2 = headingTexts($, 'h2', headingCap);
  const h3 = headingTexts($, 'h3', headingCap);
  const {
    internalLinks,
    internalLinkCount,
    internalLinksTruncated,
    internalLinkIndex,
    internalLinkIndexTruncated,
    outboundLinks,
    outboundLinksTruncated,
  } = readPageLinks($, base);
  const snippetDirectives = readSnippetDirectives(
    [tags.robotsMeta ?? '', ...Object.values(tags.botRobots ?? {})],
    $('[data-nosnippet]').length > 0,
  );
  const text = visibleBodyText($);
  const mainContent = extractMainContent($);
  const wordCount = countWords(mainContent.text);
  const visible = visibleTextFacts(text);

  const canonicalUrl = canonical ? httpUrl(canonical, base) : null;
  const jsonLdScripts = parseJsonLdScripts($);
  const jsonLdBlocks = jsonLdScripts.map((script) => script.json);
  const schemaBlocks = parseSchemaFromScripts(jsonLdScripts);
  const structuredData = extractStructuredData(schemaBlocks, jsonLdScripts.length);
  const dates = extractDates($, jsonLdBlocks);
  const author = resolveAuthorUrls(extractAuthors($, structuredData, jsonLdBlocks), base);
  const breadcrumb = resolvedBreadcrumb($, jsonLdBlocks, base);
  const markupFormats = extractMarkupFormats($, structuredData);
  const hasSpeakable = detectSpeakable(structuredData, schemaBlocks);
  const contentSignals = extractContentSignals($, mainContent.paragraphs);
  const citabilityTexts = extractCitabilityTexts(mainContent);

  return {
    title,
    metaDescription,
    canonicalUrl,
    robotsDirective: robots,
    lang,
    internalLinks,
    internalLinkCount,
    internalLinksTruncated,
    outboundLinks,
    outboundLinksTruncated,
    snippetDirectives,
    internalLinkIndex,
    internalLinkIndexTruncated,
    sitemapUrls: extractSitemapUrls($, baseUrl),
    wordCount,
    bodyWordCount: countWords(text),
    mainText: mainContent.text,
    tables: mainContent.tables,
    mixedContent: extractMixedContent($, base),
    sameHostResources: extractSameHostResources($, base),
    hiddenText: extractHiddenText($),
    charset: extractCharset($),
    trustPages: extractTrustPages($, base),
    externalResources: extractExternalResources($, base),
    structuredData,
    headings: {
      h1: h1.texts,
      h1Count: h1.texts.length,
      h1ElementCount,
      h2: h2.texts,
      h2Count: $('h2').length,
      h2NonEmpty: h2.nonEmpty,
      h3: h3.texts,
      h3Count: $('h3').length,
      h3NonEmpty: h3.nonEmpty,
      outline: extractHeadingOutline($),
    },
    viewport: Boolean(tags.viewport),

    hreflang,
    hreflangLinks,
    pagination,
    breadcrumbParent: breadcrumb,
    visibleTextSha256: visible.visibleTextSha256,
    visibleTextExcerpt: visible.visibleTextExcerpt,

    dates,

    author,

    social: pageSocial(tags, base),
    contentSignals,

    jsRenderingRisk: detectJsRenderingRisk($, wordCount),

    images: extractImageSignals($),

    videos: extractVideoSignals($, base),

    discover: extractDiscoverSignals($),

    citabilityTexts,

    citabilityOpening: extractCitabilityOpening(mainContent),

    hasSpeakable,

    markupFormats,

    metaRobotsByBot: tags.botRobots ?? {},

    visibleText: text,

    schemaBlocks,

    metaTags: tags,
  };
}
