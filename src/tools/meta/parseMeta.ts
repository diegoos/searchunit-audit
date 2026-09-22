import * as cheerio from 'cheerio';

export interface MetaTags {
  title?: string;
  description?: string;
  canonical?: string;
  robotsMeta?: string;
  viewport?: string;
  lang?: string;
  // Open Graph
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogUrl?: string;
  ogType?: string;
  ogSiteName?: string;
  // Twitter / X
  twitterCard?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  twitterSite?: string;
  botRobots?: Record<string, string>;
}

function firstAttr($: cheerio.CheerioAPI, selector: string, attribute: string): string | undefined {
  const value = $(selector).first().attr(attribute)?.trim();

  return value || undefined;
}

function firstContent($: cheerio.CheerioAPI, selector: string): string | undefined {
  return firstAttr($, selector, 'content');
}

/** First link[rel] href; HTML rel is case-insensitive and may be a token list. */
export function linkHrefByRel($: cheerio.CheerioAPI, rel: string): string | undefined {
  const want = rel.toLowerCase();
  let found: string | undefined;

  $('link').each((_, el) => {
    const attr = $(el).attr('rel') ?? '';

    if (!attr.split(/\s+/).some((token) => token.toLowerCase() === want)) {
      return;
    }

    found = $(el).attr('href')?.trim() || undefined;

    return false;
  });

  return found;
}

/** First meta[name] content, HTML name is case-insensitive. */
export function metaContentByName($: cheerio.CheerioAPI, name: string): string | undefined {
  const want = name.toLowerCase();
  let found: string | undefined;

  $('meta').each((_, el) => {
    const attr = $(el).attr('name');

    if (attr?.toLowerCase() !== want) {
      return;
    }

    found = $(el).attr('content')?.trim() || undefined;

    return false;
  });

  return found;
}

const BOT_META_NAMES = ['googlebot', 'bingbot', 'gptbot', 'google-extended', 'oai-searchbot'];

/** Per-bot robots metas (name match is case-insensitive). */
function extractBotMetaRobots($: cheerio.CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};

  for (const bot of BOT_META_NAMES) {
    const content = metaContentByName($, bot);

    if (content) {
      out[bot] = content;
    }
  }

  return out;
}

/** Extracts title, meta, canonical, OG, and Twitter tags from a loaded document. */
export function parseMetaFromDom($: cheerio.CheerioAPI): MetaTags {
  const title = $('title').first().text().trim();
  const lang = $('html').attr('lang')?.trim();

  return {
    title: title || undefined,
    description:
      metaContentByName($, 'description') ?? firstContent($, 'meta[property="og:description"]'),
    canonical: linkHrefByRel($, 'canonical'),
    robotsMeta: metaContentByName($, 'robots'),
    viewport: metaContentByName($, 'viewport'),
    lang: lang || firstAttr($, 'meta[property="og:locale"]', 'content'),
    ogTitle: firstAttr($, 'meta[property="og:title"]', 'content'),
    ogDescription: firstAttr($, 'meta[property="og:description"]', 'content'),
    ogImage: firstAttr($, 'meta[property="og:image"]', 'content'),
    ogUrl: firstAttr($, 'meta[property="og:url"]', 'content'),
    ogType: firstAttr($, 'meta[property="og:type"]', 'content'),
    ogSiteName: firstAttr($, 'meta[property="og:site_name"]', 'content'),
    twitterCard: metaContentByName($, 'twitter:card'),
    twitterTitle: metaContentByName($, 'twitter:title'),
    twitterDescription: metaContentByName($, 'twitter:description'),
    twitterImage: metaContentByName($, 'twitter:image'),
    twitterSite: metaContentByName($, 'twitter:site'),
    botRobots: extractBotMetaRobots($),
  };
}

/** Extracts title, meta, canonical, OG, and Twitter tags from HTML. */
export function parseMeta(html: string): MetaTags {
  return parseMetaFromDom(cheerio.load(html));
}
