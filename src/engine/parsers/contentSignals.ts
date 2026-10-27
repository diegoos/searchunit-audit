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

const STATISTIC_SNIPPET_SOURCE = String.raw`\d+(?:[.,]\d+)?\s?%|[$€£]\s?\d|R\$\s?\d|\b\d+(?:[.,]\d+)?\s*(?:mg|g|kg|km|mi|ms|gb|mb|users|clients|customers|clientes|usuários|x)\b`;

/** A number with a unit, percent, or currency. A bare year is not a statistic. */
export const STATISTIC_SNIPPET_RE = new RegExp(STATISTIC_SNIPPET_SOURCE, 'i');

/** Global form of `STATISTIC_SNIPPET_RE` for counting matches. */
export const STATISTIC_SNIPPET_GLOBAL_RE = new RegExp(STATISTIC_SNIPPET_SOURCE, 'gi');

/** FAQ heading words in EN/PT/ES/FR. "perguntas" also covers "perguntas frequentes". */
const FAQ_HEADING_RE =
  /faq|perguntas|preguntas frecuentes|frequently asked|questions fr[ée]quentes/i;

/**
 * A question opener is a wh-word or auxiliary followed by a question form, or a
 * "how to" / "como" phrase. A bare "Why" in a statement ("Why choose Acme") is not
 * a question. Headings that end in "?" always count.
 */
const QUESTION_OPENER_RE =
  /^(how (do|does|can|should|to)|what (is|are|does|do|can)|why (do|does|is|are|should)|when (do|does|is|are)|where (do|does|is|are)|who (is|are|can)|which (is|are|should)|can|does|is|are|should|will|do|o que|como|por que|quando|onde|quem|quais|qual|quanto)\b/i;

function isQuestionHeading(text: string): boolean {
  return text.includes('?') || QUESTION_OPENER_RE.test(text);
}

/** Counts h2/h3 headings phrased as questions (heuristic across EN/PT). */
function countQuestionHeadings($: cheerio.CheerioAPI): number {
  return $('h2, h3').filter((_, el) => isQuestionHeading($(el).text().trim())).length;
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

/** Byline and date lines are at most this many words. */
const BYLINE_MAX_WORDS = 25;
const BYLINE_START_RE = /^(?:[Pp]or|[Bb]y)(?::\s*|\s+)\p{Lu}/u;
const BYLINE_WORD_RE = /\b(?:published|publicado|updated|atualizado|atualizada)\b/i;
const MONTH_NAMES =
  'janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE_RE = new RegExp(
  String.raw`\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:\s+de)?\s+(?:${MONTH_NAMES})\.?(?:\s+de)?,?\s+\d{4}\b|\b(?:${MONTH_NAMES})\.?\s+\d{1,2},?\s+\d{4}\b`,
  'i',
);

/**
 * A byline or date line, such as "Por Ana Souza, publicado em 10/03/2026." It is short and
 * names an author, a date, or a publish or update word. It is not an answer.
 */
export function isBylineParagraph(text: string): boolean {
  const trimmed = text.trim();

  if (trimmed.split(/\s+/).length > BYLINE_MAX_WORDS) {
    return false;
  }

  return BYLINE_START_RE.test(trimmed) || DATE_RE.test(trimmed) || BYLINE_WORD_RE.test(trimmed);
}

/**
 * The first paragraph after the leading byline or date lines, or '' when none is left.
 * It is the answer candidate for `citability.opening` and `hasTopSummary`.
 */
export function summaryParagraph(paragraphs: string[]): string {
  let index = 0;

  while (index < paragraphs.length && isBylineParagraph(paragraphs[index])) {
    index++;
  }

  return paragraphs[index] ?? '';
}

/** Extracts content-shape signals used for citability and content scoring. */
export function extractContentSignals($: cheerio.CheerioAPI, paragraphs: string[]): ContentSignals {
  const paragraphCount = $('p').length;
  const lists = $('ul, ol').length;
  const tables = $('table').length;
  const summary = summaryParagraph(paragraphs);
  const openingWords = summary ? summary.split(/\s+/).length : 0;
  const hasTopSummary = openingWords >= 8 && openingWords <= 80 && /^[^.!?]+[.!?]/.test(summary);
  // A FAQ heading alone is not enough: the section must hold a question heading.
  // A FAQPage microdata block counts as visible markup.
  const questionHeadingCount = countQuestionHeadings($);
  const hasFaqPattern =
    $('[itemtype*="FAQPage"]').length > 0 ||
    ($('h2, h3').filter((_, el) => FAQ_HEADING_RE.test($(el).text())).length > 0 &&
      questionHeadingCount > 0);
  const hasDefinitionPattern =
    $('dl').length > 0 ||
    $('h2, h3').filter((_, el) => /o que é|what is|definição/i.test($(el).text())).length > 0;

  const articleCards = $('article, [class*="card"], .post, .entry').length;
  const listingPattern = articleCards >= 4 || $('main a[href]').length >= 15;

  return {
    paragraphs: paragraphCount,
    lists,
    tables,
    hasTopSummary,
    hasFaqPattern,
    hasDefinitionPattern,
    listingPattern,
    question_heading_count: questionHeadingCount,
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
