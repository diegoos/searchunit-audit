import type { MainContent } from './parsers/mainContent.ts';
import { summaryParagraph } from './parsers/contentSignals.ts';

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
  text: string;
  text_preview: string;
  word_count: number;
  score: number;
  dimensions: CitabilityDimensions;
  in_ideal_word_range: boolean;
  citation_ready: boolean;
}

export interface CitabilitySummary {
  blocks: CitabilityBlockScore[];
  /** Lowest-scoring blocks that are not already in `blocks`, at most 12. */
  weakBlocks: CitabilityBlockScore[];
  blocksTruncated: boolean;
  /** First paragraph on the page, including a short opening the score skips. */
  opening: string | null;
  page_score: number;
  citation_ready_blocks: number;
  ideal_range_blocks: number;
}

export function citabilityWordCount(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim();

  return t ? t.split(/\s+/).length : 0;
}

/** Candidate answer blocks (word counts only; scores live in scoring.ts). */
export function extractCitabilityTexts(content: MainContent): string[] {
  return [
    ...content.paragraphs.filter((text) => citabilityWordCount(text) >= 25),
    ...content.listItems.filter((text) => citabilityWordCount(text) >= 30),
  ];
}

const OPENING_CAP = 600;

/**
 * First main-content paragraph after any leading byline or date, even when it is too
 * short to score. A byline is not an answer.
 */
export function extractCitabilityOpening(content: MainContent): string | null {
  const opening = summaryParagraph(content.paragraphs);

  return opening ? opening.slice(0, OPENING_CAP) : null;
}
