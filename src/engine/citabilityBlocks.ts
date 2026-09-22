import type * as cheerio from 'cheerio';

export const CITABILITY_IDEAL_MIN_WORDS = 134;
export const CITABILITY_IDEAL_MAX_WORDS = 167;

/** Five-dimension citability rubric. */
export interface CitabilityDimensions {
  answer_block: number;
  self_containment: number;
  structure: number;
  statistical_density: number;
  uniqueness: number;
}

export interface CitabilityBlockScore {
  text_preview: string;
  word_count: number;
  score: number;
  dimensions: CitabilityDimensions;
  in_ideal_word_range: boolean;
  citation_ready: boolean;
}

export interface CitabilitySummary {
  blocks: CitabilityBlockScore[];
  page_score: number;
  citation_ready_blocks: number;
  ideal_range_blocks: number;
}

export function citabilityWordCount(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim();

  return t ? t.split(/\s+/).length : 0;
}

/** Candidate answer blocks (word counts only; scores live in scoring.ts). */
export function extractCitabilityTexts($: cheerio.CheerioAPI): string[] {
  const candidates: string[] = [];

  $('main p, article p, [role="main"] p, body > p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();

    if (citabilityWordCount(t) >= 25) {
      candidates.push(t);
    }
  });
  $('main li, article li, [role="main"] li').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();

    if (citabilityWordCount(t) >= 30) {
      candidates.push(t);
    }
  });

  return candidates.slice(0, 24);
}
