import type * as cheerio from 'cheerio';

export interface MainContent {
  /** Collapsed text of the main content root, with a space between block elements and cells. */
  text: string;
  /** Non-empty paragraph texts inside the root, in document order. */
  paragraphs: string[];
  /** Non-empty list item texts inside the root, in document order. */
  listItems: string[];
  /** Tables inside the root as rows of cell texts, capped by `TABLE_CAP`, `ROW_CAP`, and `CELL_CAP`. */
  tables: string[][][];
}

const CONTENT_ROOT = 'main, [role="main"]';
const PAGE_CHROME =
  'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
const BLOCK_ELEMENTS =
  'p, li, dt, dd, td, th, tr, h1, h2, h3, h4, h5, h6, div, section, article, figcaption, blockquote, pre, br';

const TABLE_CAP = 5;
const ROW_CAP = 30;
const CELL_CAP = 10;
const CELL_TEXT_CAP = 200;

/** Characters of main content text kept on a snapshot (audited and rendered). */
export const MAIN_TEXT_CAP = 20_000;

/** Collapses every whitespace run to one space and trims both ends. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readTables($: cheerio.CheerioAPI, root: ReturnType<cheerio.CheerioAPI>): string[][][] {
  return root
    .find('table')
    .slice(0, TABLE_CAP)
    .toArray()
    .map((table) =>
      $(table)
        .find('tr')
        .slice(0, ROW_CAP)
        .toArray()
        .map((row) =>
          $(row)
            .children('th, td')
            .slice(0, CELL_CAP)
            .toArray()
            .map((cell) => collapseWhitespace($(cell).text()).slice(0, CELL_TEXT_CAP)),
        )
        .filter((cells) => cells.some(Boolean)),
    )
    .filter((rows) => rows.length > 0);
}

/**
 * Detached copy of the content root: the first `main` / `[role=main]`, else every
 * `article`, else `body` without page chrome.
 */
function contentRootClone($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  const main = $(CONTENT_ROOT).first();

  if (main.length > 0) {
    return main.clone();
  }

  const articles = $('article');

  if (articles.length > 0) {
    return articles.clone();
  }

  const body = $('body').clone();

  body.find(PAGE_CHROME).remove();

  return body;
}

/**
 * Main content of the page: the first `main` / `[role=main]`, else every
 * `article`, else `body` without header, nav, footer, and aside. Word count,
 * citability blocks, the opening paragraph, and `mainText` read this root,
 * so page chrome does not count as content.
 */
export function extractMainContent($: cheerio.CheerioAPI): MainContent {
  const clone = contentRootClone($);

  clone.find('script, style, noscript, template').remove();

  const texts = (selector: string): string[] =>
    clone
      .find(selector)
      .toArray()
      .map((el) => collapseWhitespace($(el).text()))
      .filter(Boolean);
  const paragraphs = texts('p');
  const listItems = texts('li');
  const tables = readTables($, clone);

  // Keep "2 kg" and "Material" in adjacent cells as two words.

  clone.find(BLOCK_ELEMENTS).after(' ');

  return { text: collapseWhitespace(clone.text()), paragraphs, listItems, tables };
}
