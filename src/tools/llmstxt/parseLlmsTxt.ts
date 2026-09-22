export interface LlmsTxtLink {
  title: string;
  url: string;
  note?: string;
}

export interface LlmsTxtSection {
  heading: string;
  isOptional: boolean;
  links: LlmsTxtLink[];
}

type LlmsSyntaxErrorCode =
  | 'multiple_h1'
  | 'content_before_h1'
  | 'blockquote_outside'
  | 'link_before_section'
  | 'invalid_list_link'
  | 'non_list_in_section';

export interface LlmsSyntaxError {
  line: number;
  code: LlmsSyntaxErrorCode;
  snippet?: string;
  section?: string;
}

export interface ParsedLlmsTxt {
  h1: string | null;
  summary: string | null;
  details: string[];
  sections: LlmsTxtSection[];
  links: LlmsTxtLink[];
  syntaxErrors: LlmsSyntaxError[];
  hasBom: boolean;
}

const LIST_LINK_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*:\s*(.+))?$/;
const H1_RE = /^#\s+(.+)$/;
const H2_RE = /^##\s+(.+)$/;

/** Removes a UTF-8 BOM prefix when present. */

function stripBom(content: string): { text: string; hasBom: boolean } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { text: content.slice(1), hasBom: true };
  }

  return { text: content, hasBom: false };
}

/** Parses a single `- [title](url)` list link line; returns null when malformed. */

function parseListLink(line: string): LlmsTxtLink | null {
  const m = line.match(LIST_LINK_RE);

  if (!m) {
    return null;
  }

  const title = m[1].trim();
  const url = m[2].trim();
  const note = m[3]?.trim();

  if (!title || !url) {
    return null;
  }

  return note ? { title, url, note } : { title, url };
}

function flushSummary(lines: string[]): string | null {
  return lines.length > 0 ? lines.join(' ').trim() : null;
}

type LlmsPhase = 'before_h1' | 'after_h1' | 'summary' | 'details' | 'sections';

interface LlmsScan {
  phase: LlmsPhase;
  h1: string | null;
  summary: string | null;
  currentSection: LlmsTxtSection | null;
  summaryLines: string[];
  details: string[];
  sections: LlmsTxtSection[];
  links: LlmsTxtLink[];
  syntaxErrors: LlmsSyntaxError[];
}

function finishSummary(scan: LlmsScan): void {
  scan.summary = flushSummary(scan.summaryLines) ?? scan.summary;
}

function pushSection(scan: LlmsScan): void {
  if (scan.currentSection) {
    scan.sections.push(scan.currentSection);
  }
}

function onH1(scan: LlmsScan, heading: string, line: number): void {
  if (scan.h1 !== null) {
    scan.syntaxErrors.push({ line, code: 'multiple_h1' });
  }

  scan.h1 = heading;
  scan.phase = 'after_h1';
}

function onH2(scan: LlmsScan, heading: string): void {
  if (scan.phase === 'summary') {
    finishSummary(scan);
  }

  scan.phase = 'sections';
  pushSection(scan);
  scan.currentSection = {
    heading,
    isOptional: heading.toLowerCase() === 'optional',
    links: [],
  };
}

function onQuote(scan: LlmsScan, text: string, line: number): void {
  if (scan.phase === 'after_h1' || scan.phase === 'summary') {
    scan.phase = 'summary';
    scan.summaryLines.push(text.replace(/^>\s?/, ''));

    return;
  }

  scan.syntaxErrors.push({ line, code: 'blockquote_outside' });
}

function onList(scan: LlmsScan, trimmed: string, line: number): void {
  const link = parseListLink(trimmed);

  if (link) {
    scan.links.push(link);

    if (scan.currentSection) {
      scan.currentSection.links.push(link);
    } else if (scan.phase !== 'sections') {
      scan.syntaxErrors.push({ line, code: 'link_before_section' });
    }
  } else {
    scan.syntaxErrors.push({
      line,
      code: 'invalid_list_link',
      snippet: trimmed.slice(0, 50),
    });
  }

  if (scan.phase === 'after_h1' || scan.phase === 'summary') {
    finishSummary(scan);
    scan.phase = 'details';
  }
}

function onOther(scan: LlmsScan, trimmed: string, line: number): void {
  if (scan.phase === 'after_h1' || scan.phase === 'summary') {
    finishSummary(scan);
    scan.phase = 'details';
  }

  if (scan.phase === 'details' || (scan.phase === 'sections' && !scan.currentSection)) {
    scan.details.push(trimmed);

    return;
  }

  if (scan.phase === 'sections' && scan.currentSection) {
    scan.syntaxErrors.push({
      line,
      code: 'non_list_in_section',
      section: scan.currentSection.heading,
    });
  }
}

/** Parses llms.txt markdown-lite content (H1, blockquote summary, H2 sections, links). */
export function parseLlmsTxt(content: string): ParsedLlmsTxt {
  const { text, hasBom } = stripBom(content);
  const lines = text.split(/\r?\n/);
  const scan: LlmsScan = {
    phase: 'before_h1',
    h1: null,
    summary: null,
    currentSection: null,
    summaryLines: [],
    details: [],
    sections: [],
    links: [],
    syntaxErrors: [],
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const line = i + 1;

    if (!trimmed) {
      if (scan.phase === 'summary' && flushSummary(scan.summaryLines) !== null) {
        finishSummary(scan);
        scan.phase = 'details';
      }

      continue;
    }

    const h1Match = trimmed.match(H1_RE);

    if (h1Match) {
      onH1(scan, h1Match[1].trim(), line);
      continue;
    }

    if (scan.phase === 'before_h1') {
      scan.syntaxErrors.push({
        line,
        code: 'content_before_h1',
        snippet: trimmed.slice(0, 40),
      });
      continue;
    }

    const h2Match = trimmed.match(H2_RE);

    if (h2Match) {
      onH2(scan, h2Match[1].trim());
      continue;
    }

    if (trimmed.startsWith('>')) {
      onQuote(scan, trimmed, line);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      onList(scan, trimmed, line);
      continue;
    }

    onOther(scan, trimmed, line);
  }

  finishSummary(scan);
  pushSection(scan);

  return {
    h1: scan.h1,
    summary: scan.summary,
    details: scan.details,
    sections: scan.sections,
    links: scan.links,
    syntaxErrors: scan.syntaxErrors,
    hasBom,
  };
}

/** Returns true when a link URL uses an http(s) absolute scheme. */
export function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Returns true when a link pathname ends with .md (llmstxt.org convention). */
export function hasMdExtension(url: string): boolean {
  try {
    const pathname = new URL(url, 'https://example.com').pathname;
    return pathname.endsWith('.md');
  } catch {
    return url.endsWith('.md');
  }
}
