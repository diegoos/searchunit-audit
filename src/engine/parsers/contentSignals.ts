import * as cheerio from 'cheerio';

export interface ContentSignals {
  paragraphs: number;
  lists: number;
  tables: number;
  hasTopSummary: boolean;
  hasFaqPattern: boolean;
  hasDefinitionPattern: boolean;
  listingPattern: boolean;
  question_heading_count: number;
  statistic_snippet_count: number;
}

export interface JsRenderingRisk {
  isLikelyCsr: boolean;
  reason: string | null;
}

export const STATISTIC_SNIPPET_RE =
  /\d+([.,]\d+)?%|\$\d|(\d{4})|(\d+\s*(mg|kg|km|mi|users|clients))/i;

/** Counts headings phrased as questions (heuristic across EN/PT). */

function countQuestionHeadings($: cheerio.CheerioAPI): number {
  let count = 0;

  $('h2, h3').each((_, el) => {
    const t = $(el).text().trim();

    if (
      /^(what|how|why|when|where|who|which|can|does|is|are|o que|como|por que|quando|onde|quem)\b/i.test(
        t,
      ) ||
      t.includes('?')
    ) {
      count++;
    }
  });

  return count;
}

/** Counts paragraphs/list items carrying numeric statistics (percentages, currency, years, units). */

function countStatisticSnippets($: cheerio.CheerioAPI): number {
  let count = 0;

  $('p, li').each((_, el) => {
    const t = $(el).text();

    if (STATISTIC_SNIPPET_RE.test(t)) {
      count++;
    }
  });

  return count;
}

/** Extracts content-shape signals used for citability and content scoring. */
export function extractContentSignals($: cheerio.CheerioAPI, bodyText?: string): ContentSignals {
  const paragraphs = $('p').length;
  const lists = $('ul, ol').length;
  const tables = $('table').length;
  const normalizedText = bodyText ?? $('body').text().replace(/\s+/g, ' ').trim();
  const firstChunk = normalizedText.slice(0, 400).toLowerCase();
  const hasTopSummary =
    paragraphs > 0 &&
    ($('main p, article p, .hero p, [class*="summary"] p').first().text().trim().length > 80 ||
      firstChunk.length > 120);
  const hasFaqPattern =
    $('[itemtype*="FAQPage"]').length > 0 ||
    $('h2, h3').filter((_, el) => /faq|perguntas/i.test($(el).text())).length > 0;
  const hasDefinitionPattern =
    $('dl').length > 0 ||
    $('h2, h3').filter((_, el) => /o que é|what is|definição/i.test($(el).text())).length > 0;

  const articleCards = $('article, [class*="card"], .post, .entry').length;
  const listingPattern = articleCards >= 4 || $('main a[href]').length >= 15;

  return {
    paragraphs,
    lists,
    tables,
    hasTopSummary,
    hasFaqPattern,
    hasDefinitionPattern,
    listingPattern,
    question_heading_count: countQuestionHeadings($),
    statistic_snippet_count: countStatisticSnippets($),
  };
}

/** Flags likely client-side rendered pages (SPA root + low word count + many scripts). */
export function detectJsRenderingRisk($: cheerio.CheerioAPI, wordCount: number): JsRenderingRisk {
  const spaRoot = $('#root, #__next, [data-reactroot], #app').length > 0;
  const scriptCount = $('script').length;

  if (wordCount < 120 && spaRoot && scriptCount >= 5) {
    return {
      isLikelyCsr: true,
      reason: 'low_word_count_with_spa_root_and_many_scripts',
    };
  }

  return { isLikelyCsr: false, reason: null };
}
