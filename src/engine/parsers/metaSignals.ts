import * as cheerio from 'cheerio';
import { metaContentByName } from '../../tools/meta/parseMeta.ts';
import type { StructuredDataSummary } from './structuredData.ts';

export interface PageDates {
  published: string | null;
  modified: string | null;
}

export interface PageAuthor {
  hasAuthor: boolean;
  names: string[];
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

/** Reads published/modified dates from meta tags then falls back to JSON-LD datePublished/dateModified. */
export function extractDates($: cheerio.CheerioAPI, jsonLdBlocks?: unknown[]): PageDates {
  const dates = {
    published: $('meta[property="article:published_time"]').attr('content')?.trim() || null,
    modified: $('meta[property="article:modified_time"]').attr('content')?.trim() || null,
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

/** Collects author names from meta tags and JSON-LD `author`, cross-checking Person blocks. */
export function extractAuthors(
  $: cheerio.CheerioAPI,
  structured: StructuredDataSummary,
  jsonLdBlocks?: unknown[],
): PageAuthor {
  const names = new Set<string>();
  const metaAuthor = metaContentByName($, 'author');

  if (metaAuthor) {
    names.add(metaAuthor);
  }

  const blocks = jsonLdBlocks ?? [];

  for (const parsed of blocks) {
    try {
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const n of node) {
            visit(n);
          }

          return;
        }

        if (!node || typeof node !== 'object') {
          return;
        }

        const obj = node as Record<string, unknown>;

        collectAuthorNames(obj.author, names);

        if (Array.isArray(obj['@graph'])) {
          visit(obj['@graph']);
        }
      };
      visit(parsed);
    } catch {
      // ignore
    }
  }

  const hasAuthor =
    names.size > 0 || structured.blocks.some((b) => b.type?.toLowerCase().includes('person'));
  return { hasAuthor, names: [...names] };
}
