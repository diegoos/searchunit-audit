import type { CheckStatus } from '../types';
import { scoreToCheckStatus, statusWeightedScore } from '../types';
import type { LlmsSyntaxError, LlmsTxtLink, LlmsTxtSection, ParsedLlmsTxt } from './parseLlmsTxt';
import { hasMdExtension, isAbsoluteUrl } from './parseLlmsTxt';

interface LlmsTxtCheck {
  id: string;
  label: string;
  status: CheckStatus | 'info';
  detail: string;
  detailItems?: string[];
  syntaxErrors?: LlmsSyntaxError[];
  value?: string;
}

export interface LlmsTxtAnalysis {
  score: number;
  overallStatus: CheckStatus;
  checks: LlmsTxtCheck[];
  llmsFullChecks: LlmsTxtCheck[];
  hasLlmsFull: boolean;
  sections: LlmsTxtSection[];
  links: LlmsTxtLink[];
}

export interface AnalyzeLlmsTxtOptions {
  present: boolean;
  contentType?: string;
  /** Raw file body used for byte-size validation (full content, not parsed subset). */
  rawContent?: string;
  hasLlmsFull?: boolean;
  isCompanion?: boolean;
}

export interface AnalyzeLlmsTxtFullOptions {
  contentType?: string;
  rawContent?: string;
}

const MAX_SIZE_BYTES = 200 * 1024;

function isLikelyUtf8(content: string): boolean {
  return !content.includes('\uFFFD');
}

function mdConvention(sections: LlmsTxtSection[]): { status: CheckStatus; detail: string } {
  const docs = sections.filter((s) => /doc/i.test(s.heading));

  if (docs.length === 0) {
    return { status: 'pass', detail: 'no_docs_section' };
  }

  const mdCount = docs.flatMap((s) => s.links).filter((l) => hasMdExtension(l.url)).length;

  if (mdCount > 0) {
    return { status: 'pass', detail: `${mdCount} .md link(s)` };
  }

  return { status: 'warn', detail: 'no_md_links_in_docs' };
}

function sizeDetail(empty: boolean, tooLarge: boolean, maxKb: number): string {
  if (empty) {
    return 'empty';
  }

  if (tooLarge) {
    return `>${maxKb}KB`;
  }

  return 'ok';
}

const LLMS_TXT_FORMAT_URL = 'https://llmstxt.org/#format';

function formatSyntaxDetail(errors: readonly LlmsSyntaxError[]): string {
  const groups = new Map<LlmsSyntaxError['code'], number[]>();

  for (const err of errors) {
    const lines = groups.get(err.code);

    if (lines) {
      lines.push(err.line);
    } else {
      groups.set(err.code, [err.line]);
    }
  }

  return [...groups]
    .map(([code, lines]) => {
      const loc = lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`;

      return `${loc}: ${code}`;
    })
    .join('; ');
}

function llmsCheck(
  prefix: string,
  id: string,
  status: LlmsTxtCheck['status'],
  detail: string,
  extra?: {
    detailItems?: string[];
    syntaxErrors?: LlmsSyntaxError[];
    value?: string;
  },
): LlmsTxtCheck {
  const name = `${prefix}${id}`;

  return { id: name, label: name, status, detail, ...extra };
}

/** Builds the full checklist for llms.txt or llms-full.txt (prefixed when companion). */

// eslint-disable-next-line complexity -- one check per field of the same catalog
function buildChecks(parsed: ParsedLlmsTxt, options: AnalyzeLlmsTxtOptions): LlmsTxtCheck[] {
  const checks: LlmsTxtCheck[] = [];
  const { present, contentType, isCompanion = false } = options;
  const prefix = isCompanion ? 'full_' : '';

  checks.push(
    llmsCheck(prefix, 'presence', present ? 'pass' : 'fail', present ? 'found' : 'not_found'),
  );

  if (!present) {
    return checks;
  }

  const isText =
    !contentType ||
    contentType.includes('text/') ||
    contentType.includes('markdown') ||
    contentType.includes('application/octet-stream');

  checks.push(
    llmsCheck(prefix, 'content_type', isText ? 'pass' : 'warn', contentType ?? 'unknown'),
    llmsCheck(prefix, 'h1_title', parsed.h1 ? 'pass' : 'fail', parsed.h1 ?? 'missing'),
    llmsCheck(
      prefix,
      'summary',
      parsed.summary ? 'pass' : 'warn',
      parsed.summary ? 'present' : 'missing',
    ),
  );
  const sectionCount = parsed.sections.filter((s) => s.links.length > 0).length;
  const hasFileLists = sectionCount > 0;

  checks.push(
    llmsCheck(
      prefix,
      'file_lists',
      hasFileLists ? 'pass' : 'warn',
      hasFileLists ? `${sectionCount} section(s)` : 'none',
    ),
  );
  const badLinks = parsed.links.filter((l) => !isAbsoluteUrl(l.url));

  checks.push(
    llmsCheck(
      prefix,
      'links_format',
      badLinks.length === 0 ? 'pass' : 'warn',
      badLinks.length === 0 ? 'all_absolute' : badLinks.map((l) => l.url).join('; '),
      {
        detailItems: badLinks.length > 0 ? badLinks.slice(0, 5).map((l) => l.url) : undefined,
        value: badLinks.length > 0 ? String(badLinks.length) : undefined,
      },
    ),
  );
  const hasOptional = parsed.sections.some((s) => s.isOptional);

  checks.push(
    llmsCheck(
      prefix,
      'optional_section',
      hasOptional ? 'pass' : 'warn',
      hasOptional ? 'present' : 'absent',
    ),
  );
  const md = mdConvention(parsed.sections);

  checks.push(llmsCheck(prefix, 'md_convention', md.status, md.detail));
  const rawContent = options.rawContent ?? '';
  const byteSize = new TextEncoder().encode(rawContent).length;
  const empty =
    rawContent.trim().length === 0 || (!parsed.h1 && parsed.links.length === 0 && !parsed.summary);
  const tooLarge = byteSize > MAX_SIZE_BYTES;

  checks.push(
    llmsCheck(
      prefix,
      'size',
      empty || tooLarge ? 'warn' : 'pass',
      sizeDetail(empty, tooLarge, MAX_SIZE_BYTES / 1024),
      {
        value: String(byteSize),
      },
    ),
  );

  if (parsed.syntaxErrors.length > 0) {
    const shown = parsed.syntaxErrors.slice(0, 8);

    checks.push(
      llmsCheck(prefix, 'syntax', 'warn', formatSyntaxDetail(shown), {
        syntaxErrors: shown,
        value: String(parsed.syntaxErrors.length),
      }),
    );

    if (shown.some((err) => err.code === 'non_list_in_section')) {
      checks.push(
        llmsCheck(
          prefix,
          'non_list_in_section',
          'info',
          `H2 file lists only allow - [name](url). ${LLMS_TXT_FORMAT_URL}`,
        ),
      );
    }
  }

  if (!isLikelyUtf8([parsed.h1 ?? '', parsed.summary ?? '', ...parsed.details].join('\n'))) {
    checks.push(llmsCheck(prefix, 'encoding', 'warn', 'non_utf8'));
  }

  return checks;
}

/** Derives overall pass/warn/fail from presence, H1, and weighted score. */

function computeOverallStatus(checks: LlmsTxtCheck[], score: number): CheckStatus {
  const presence = checks.find((c) => c.id === 'presence' || c.id === 'full_presence');
  const h1 = checks.find((c) => c.id === 'h1_title' || c.id === 'full_h1_title');

  if (presence?.status === 'fail' || h1?.status === 'fail') {
    return 'fail';
  }

  return scoreToCheckStatus(score);
}

/** Runs llms.txt validation checks and computes score from parsed structure. */
export function analyzeLlmsTxt(
  parsed: ParsedLlmsTxt,
  options: AnalyzeLlmsTxtOptions,
): LlmsTxtAnalysis {
  const checks = buildChecks(parsed, options);
  const score = statusWeightedScore(checks);
  const overallStatus = computeOverallStatus(checks, score);

  return {
    score,
    overallStatus,
    checks,
    llmsFullChecks: [],
    hasLlmsFull: options.hasLlmsFull ?? false,
    sections: parsed.sections,
    links: parsed.links,
  };
}

/** Merges main and companion analyses when llms-full.txt is present. */

function mergeCompanionAnalysis(
  main: LlmsTxtAnalysis,
  fullAnalysis: LlmsTxtAnalysis,
): LlmsTxtAnalysis {
  const combinedScore = Math.round((main.score + fullAnalysis.score) / 2);

  return {
    ...main,
    hasLlmsFull: true,
    llmsFullChecks: fullAnalysis.checks,
    score: combinedScore,
    overallStatus: computeOverallStatus([...main.checks, ...fullAnalysis.checks], combinedScore),
  };
}

/** Analyzes llms.txt and optional llms-full.txt companion; averages scores when both exist. */
export function analyzeLlmsTxtPair(
  llmsParsed: ParsedLlmsTxt,
  llmsOptions: AnalyzeLlmsTxtOptions,
  fullParsed: ParsedLlmsTxt | null,
  fullPresent: boolean,
  fullOptions?: AnalyzeLlmsTxtFullOptions,
): LlmsTxtAnalysis {
  const main = analyzeLlmsTxt(llmsParsed, { ...llmsOptions, hasLlmsFull: fullPresent });

  if (!fullPresent || !fullParsed) {
    return main;
  }

  const fullAnalysis = analyzeLlmsTxt(fullParsed, {
    present: true,
    contentType: fullOptions?.contentType,
    rawContent: fullOptions?.rawContent,
    isCompanion: true,
  });

  return mergeCompanionAnalysis(main, fullAnalysis);
}

/** Returns analysis for a missing llms.txt (presence fail, no error UI). */
export function analyzeAbsentLlmsTxt(): LlmsTxtAnalysis {
  const empty: ParsedLlmsTxt = {
    h1: null,
    summary: null,
    details: [],
    sections: [],
    links: [],
    syntaxErrors: [],
    hasBom: false,
  };

  return analyzeLlmsTxt(empty, { present: false, hasLlmsFull: false });
}

/** Fetch failed: file presence unknown (not the same as HTTP 404). */
export function analyzeLlmsTxtFetchError(): LlmsTxtAnalysis {
  return {
    score: 50,
    overallStatus: 'warn',
    checks: [
      {
        id: 'presence',
        label: 'presence',
        status: 'warn',
        detail: 'fetch_error',
      },
    ],
    llmsFullChecks: [],
    hasLlmsFull: false,
    sections: [],
    links: [],
  };
}
