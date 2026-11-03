import * as cheerio from 'cheerio';
import { metaContentByName } from '../../tools/meta/parseMeta.ts';
import type { StructuredDataSummary } from './structuredData.ts';

export interface PageDates {
  published: string | null;
  modified: string | null;
  visible: string | null;
}

export interface PageAuthor {
  hasAuthor: boolean;
  names: string[];
  urls: string[];
}

export type MetaRobotsByBot = Record<string, string>;

function collectDatesFromJsonLd(
  node: unknown,
  dates: { published: string | null; modified: string | null },
): void {
  if (Array.isArray(node)) {
    for (const n of node) {
      collectDatesFromJsonLd(n, dates);
    }

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  const obj = node as Record<string, unknown>;

  if (!dates.published && typeof obj.datePublished === 'string') {
    dates.published = obj.datePublished;
  }

  if (!dates.modified && typeof obj.dateModified === 'string') {
    dates.modified = obj.dateModified;
  }

  if (Array.isArray(obj['@graph'])) {
    collectDatesFromJsonLd(obj['@graph'], dates);
  }
}

const CONTENT_TIME = 'main time, [role="main"] time, article time';

/** First `<time>` in main content, else the first `<time>` on the page. Sidebar dates lose to article dates. */
function visibleDate($: cheerio.CheerioAPI): string | null {
  const inContent = $(CONTENT_TIME);
  const times = inContent.length > 0 ? inContent : $('time');

  return (
    times.filter('[datetime]').first().attr('datetime')?.trim() ||
    times.first().text().trim() ||
    null
  );
}

/** Reads published/modified dates from meta tags then falls back to JSON-LD datePublished/dateModified. */
export function extractDates($: cheerio.CheerioAPI, jsonLdBlocks?: unknown[]): PageDates {
  const dates = {
    published: $('meta[property="article:published_time"]').attr('content')?.trim() || null,
    modified: $('meta[property="article:modified_time"]').attr('content')?.trim() || null,
    visible: visibleDate($),
  };
  for (const parsed of jsonLdBlocks ?? []) {
    try {
      collectDatesFromJsonLd(parsed, dates);
    } catch {
      // ignore
    }
  }

  return dates;
}

function collectAuthorUrls(author: unknown, urls: Set<string>): void {
  if (!author) {
    return;
  }

  if (typeof author === 'string') {
    if (/^https?:\/\//i.test(author)) {
      urls.add(author);
    }

    return;
  }

  if (Array.isArray(author)) {
    for (const entry of author) {
      collectAuthorUrls(entry, urls);
    }

    return;
  }

  if (typeof author === 'object') {
    const record = author as { url?: unknown; '@id'?: unknown };

    collectAuthorUrls(record.url, urls);
    collectAuthorUrls(record['@id'], urls);
  }
}

function collectAuthorNames(author: unknown, names: Set<string>): void {
  if (typeof author === 'string') {
    names.add(author);

    return;
  }

  if (Array.isArray(author)) {
    for (const item of author) {
      collectAuthorNames(item, names);
    }

    return;
  }

  if (author && typeof author === 'object') {
    const name = (author as { name?: unknown }).name;

    if (typeof name === 'string') {
      names.add(name);
    }
  }
}

/** Walks a JSON-LD tree (arrays and `@graph`) and collects `author` names and URLs. */
function collectJsonLdAuthors(node: unknown, names: Set<string>, urls: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonLdAuthors(item, names, urls);
    }

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  const obj = node as Record<string, unknown>;

  collectAuthorNames(obj.author, names);
  collectAuthorUrls(obj.author, urls);

  if (Array.isArray(obj['@graph'])) {
    collectJsonLdAuthors(obj['@graph'], names, urls);
  }
}

/** Collects author names from meta tags and JSON-LD `author`, cross-checking Person blocks. */
export function extractAuthors(
  $: cheerio.CheerioAPI,
  structured: StructuredDataSummary,
  jsonLdBlocks?: unknown[],
): PageAuthor {
  const names = new Set<string>();
  const urls = new Set<string>();
  const metaAuthor = metaContentByName($, 'author');

  if (metaAuthor) {
    names.add(metaAuthor);
  }

  const blocks = jsonLdBlocks ?? [];

  for (const parsed of blocks) {
    try {
      collectJsonLdAuthors(parsed, names, urls);
    } catch {
      // ignore
    }
  }

  $('a[rel~="author"], link[rel~="author"]').each((_, el) => {
    const href = $(el).attr('href')?.trim();

    if (href) {
      urls.add(href);
    }
  });
  const hasAuthor =
    names.size > 0 || structured.blocks.some((b) => b.type?.toLowerCase().includes('person'));

  return { hasAuthor, names: [...names], urls: [...urls] };
}
