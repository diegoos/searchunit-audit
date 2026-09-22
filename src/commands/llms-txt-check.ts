import type { CliFlags } from '../lib/args.ts';
import {
  fetchPublicUrl,
  formatFetchError,
  classifyWellKnownFetch,
  type FetchOutcome,
} from '../lib/fetch.ts';
import { CliError } from '../lib/errors.ts';
import { emitCheckOutput, failOnExitCode, toCheckRow, type CheckRow } from '../lib/output.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';
import { parseLlmsTxt, type ParsedLlmsTxt } from '../tools/llmstxt/parseLlmsTxt.ts';
import {
  analyzeAbsentLlmsTxt,
  analyzeLlmsTxt,
  analyzeLlmsTxtFetchError,
  analyzeLlmsTxtPair,
  type LlmsTxtAnalysis,
} from '../tools/llmstxt/analyzeLlmsTxt.ts';

function isPresentFile(page: FetchOutcome): page is Extract<FetchOutcome, { ok: true }> {
  return classifyWellKnownFetch(page, '/llms-full.txt') === 'present' && page.ok;
}

function parseCompanionFull(
  full: FetchOutcome,
): { parsed: ParsedLlmsTxt; contentType: string; rawContent: string } | null {
  if (!isPresentFile(full)) {
    return null;
  }

  return {
    parsed: parseLlmsTxt(full.body),
    contentType: full.contentType,
    rawContent: full.body,
  };
}

function companionChecks(
  companion: NonNullable<ReturnType<typeof parseCompanionFull>>,
): LlmsTxtAnalysis['checks'] {
  return analyzeLlmsTxt(companion.parsed, {
    present: true,
    contentType: companion.contentType,
    rawContent: companion.rawContent,
    isCompanion: true,
  }).checks;
}

function analysisForLlmsFetchError(full: FetchOutcome, hasLlmsFull: boolean): LlmsTxtAnalysis {
  const base = analyzeLlmsTxtFetchError();
  const companion = parseCompanionFull(full);

  if (!companion) {
    return { ...base, hasLlmsFull };
  }

  return {
    ...base,
    hasLlmsFull: true,
    llmsFullChecks: companionChecks(companion),
  };
}

function joinExtraBits(bits: string[], hasLlmsFull: boolean): string {
  if (hasLlmsFull) {
    bits.push('llms-full.txt present');
  }

  return bits.join('  ·  ');
}

/** Maps an llms.txt fetch onto present / missing / error, matching audit. */
export function analysisForLlmsOutcome(
  llms: FetchOutcome,
  full: FetchOutcome,
): { analysis: LlmsTxtAnalysis; hasLlmsFull: boolean } {
  const kind = classifyWellKnownFetch(llms, '/llms.txt');
  const companion = parseCompanionFull(full);
  const hasLlmsFull = companion !== null;

  if (kind === 'present' && llms.ok) {
    return {
      hasLlmsFull,
      analysis: analyzeLlmsTxtPair(
        parseLlmsTxt(llms.body),
        {
          present: true,
          contentType: llms.contentType,
          rawContent: llms.body,
          hasLlmsFull,
        },
        companion?.parsed ?? null,
        hasLlmsFull,
        companion
          ? { contentType: companion.contentType, rawContent: companion.rawContent }
          : undefined,
      ),
    };
  }

  if (kind === 'missing') {
    return { analysis: analyzeAbsentLlmsTxt(), hasLlmsFull };
  }

  return { analysis: analysisForLlmsFetchError(full, hasLlmsFull), hasLlmsFull };
}

/** One Status/Check/Detail table per fetched file. */
export function llmsCheckSections(
  analysis: LlmsTxtAnalysis,
): { heading: string; checks: CheckRow[] }[] {
  const sections = [{ heading: 'llms.txt', checks: analysis.checks.map(toCheckRow) }];

  if (analysis.llmsFullChecks.length > 0) {
    sections.push({ heading: 'llms-full.txt', checks: analysis.llmsFullChecks.map(toCheckRow) });
  }

  return sections;
}

export function extraLine(hasLlmsFull: boolean, analysis: LlmsTxtAnalysis): string {
  const presence = analysis.checks.find((check) => check.id === 'presence');

  if (presence?.detail === 'fetch_error') {
    return joinExtraBits(
      ['llms.txt fetch failed (optional file; not a ranking factor)'],
      hasLlmsFull,
    );
  }

  if (presence?.detail === 'not_found') {
    return 'llms.txt not found (optional file; not a ranking factor)';
  }

  const bits = ['Fetched origin /llms.txt'];

  if (analysis.overallStatus === 'fail') {
    bits.push('llms.txt is optional (not a ranking factor)');
  }

  return joinExtraBits(bits, hasLlmsFull);
}

/** Fetches /llms.txt and optional /llms-full.txt and scores structure. */
export async function runLlmsTxtCheck(
  target: string | undefined,
  flags: CliFlags,
): Promise<number> {
  const url = requireHttpUrl(target);
  const origin = new URL(url).origin;
  const llmsUrl = `${origin}/llms.txt`;

  const { analysis, hasLlmsFull } = await withProgress(flags, `Fetching ${llmsUrl}`, async () => {
    const [llms, full] = await Promise.all([
      fetchPublicUrl(llmsUrl, { allowHttpErrors: true }),
      fetchPublicUrl(`${origin}/llms-full.txt`, { allowHttpErrors: true }),
    ]);

    if (!llms.ok && (llms.error === 'blocked' || llms.error === 'invalid_url')) {
      throw new CliError(formatFetchError(llms));
    }

    return analysisForLlmsOutcome(llms, full);
  });
  emitCheckOutput(flags, {
    command: 'llms-txt-check',
    url,
    json: { ok: true, command: 'llms-txt-check', url, resourceUrl: llmsUrl, hasLlmsFull, analysis },
    report: {
      title: 'llms.txt Validator',
      url,
      score: analysis.score,
      status: analysis.overallStatus,
      extra: extraLine(hasLlmsFull, analysis),
      sections: llmsCheckSections(analysis),
    },
  });

  return failOnExitCode(analysis.overallStatus, flags.failOn);
}
