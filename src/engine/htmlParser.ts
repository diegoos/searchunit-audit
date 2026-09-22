import * as cheerio from 'cheerio';
import { extractCitabilityTexts } from './citabilityBlocks.ts';
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
  type DiscoverSignals,
  type ImageSignals,
} from './parsers/imageDiscover.ts';
import {
  parseJsonLdScripts,
  parseSchemaFromScripts,
  type ParsedSchemaBlock,
} from '../tools/schema/parseSchema.ts';
import { parseMetaFromDom, type MetaTags } from '../tools/meta/parseMeta.ts';

export type { StructuredDataSummary };

export interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsDirective: string | null;
  lang: string | null;
  internalLinks: string[];
  sitemapUrls: string[];
  wordCount: number;
  structuredData: StructuredDataSummary;
  headings: {
    h1: string[];
    h1Count: number;
    h1ElementCount: number;
    h2Count: number;
    h3Count: number;
  };
  viewport: boolean;
  hreflang: string[];
  dates: PageDates;
  author: PageAuthor;
  social: {
    openGraph: { title: boolean; image: boolean; type: string | null };
    twitter: { card: boolean };
  };
  contentSignals: ContentSignals;
  markupFormats: MarkupFormats;
  metaRobotsByBot: MetaRobotsByBot;
  jsRenderingRisk: JsRenderingRisk;
  images: ImageSignals;
  discover: DiscoverSignals;
  citabilityTexts: string[];
  hasSpeakable: boolean;
  visibleText: string;
  schemaBlocks: ParsedSchemaBlock[];
  metaTags: MetaTags;
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

      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
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

  return clone.text().replace(/\s+/g, ' ').trim();
}

function countWords(text: string): number {
  if (!text) {
    return 0;
  }

  let wordCount = 0;

  text.replace(/\S+/g, () => {
    wordCount++;

    return '';
  });

  return wordCount;
}

function httpUrl(href: string, base: URL): string | null {
  try {
    const resolved = new URL(href, base);

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

/** Loads the HTML and extracts the full {@link ParsedPage} by orchestrating the sub-parsers. */
export function parseHtmlPage(html: string, baseUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  const tags = parseMetaFromDom($);
  const title = tags.title ?? null;
  const lang = tags.lang ?? null;
  const metaDescription = tags.description ?? null;
  const canonical = tags.canonical ?? null;
  const robots = tags.robotsMeta ?? null;

  const hreflang: string[] = [];

  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const code = $(el).attr('hreflang')?.trim();

    if (code) {
      hreflang.push(code);
    }
  });
  const h1ElementCount = $('h1').length;
  const h1: string[] = [];

  $('h1').each((_, el) => {
    const t = $(el).text().trim();

    if (t) {
      h1.push(t);
    }
  });
  const internalLinks = new Set<string>();

  $('a[href]').each((_, el) => {
    if (internalLinks.size >= 50) {
      return false;
    }

    const href = $(el).attr('href');

    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    try {
      const resolved = new URL(href, base);

      if (resolved.hostname === base.hostname) {
        internalLinks.add(resolved.toString());
      }
    } catch {
      // skip invalid URLs
    }
  });
  const text = visibleBodyText($);
  const wordCount = countWords(text);

  let canonicalUrl: string | null = null;

  if (canonical) {
    canonicalUrl = httpUrl(canonical, base);
  }

  const jsonLdScripts = parseJsonLdScripts($);
  const jsonLdBlocks = jsonLdScripts.map((script) => script.json);
  const schemaBlocks = parseSchemaFromScripts(jsonLdScripts);
  const structuredData = extractStructuredData(schemaBlocks, jsonLdScripts.length);
  const dates = extractDates($, jsonLdBlocks);
  const author = extractAuthors($, structuredData, jsonLdBlocks);
  const markupFormats = extractMarkupFormats($, structuredData);
  const hasSpeakable = detectSpeakable(structuredData, schemaBlocks);
  const contentSignals = extractContentSignals($, text);
  const citabilityTexts = extractCitabilityTexts($);

  return {
    title,
    metaDescription,
    canonicalUrl,
    robotsDirective: robots,
    lang,
    internalLinks: [...internalLinks],
    sitemapUrls: extractSitemapUrls($, baseUrl),
    wordCount,
    structuredData,
    headings: {
      h1,
      h1Count: h1.length,
      h1ElementCount,
      h2Count: $('h2').length,
      h3Count: $('h3').length,
    },
    viewport: Boolean(tags.viewport),

    hreflang,

    dates,

    author,

    social: {
      openGraph: {
        title: Boolean(tags.ogTitle),
        image: Boolean(tags.ogImage),
        type: tags.ogType ?? null,
      },
      twitter: {
        card: Boolean(tags.twitterCard),
      },
    },
    contentSignals,

    jsRenderingRisk: detectJsRenderingRisk($, wordCount),

    images: extractImageSignals($),

    discover: extractDiscoverSignals($),

    citabilityTexts,

    hasSpeakable,

    markupFormats,

    metaRobotsByBot: tags.botRobots ?? {},

    visibleText: text,

    schemaBlocks,

    metaTags: tags,
  };
}
