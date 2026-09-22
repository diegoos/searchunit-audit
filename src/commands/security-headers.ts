import type { CliFlags } from '../lib/args.ts';
import { fetchPublicUrl, formatFetchError } from '../lib/fetch.ts';
import { CliError } from '../lib/errors.ts';
import { emitCheckOutput, failOnExitCode, toCheckRow } from '../lib/output.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';
import { analyzeSecurityHeaders } from '../tools/security/analyzeSecurityHeaders.ts';
import { buildAnalyzeContext } from '../tools/security/buildAnalyzeContext.ts';
import { parseSecurityHeaders } from '../tools/security/parseSecurityHeaders.ts';

/** Fetches a URL and scores HTTP security headers (MDN Observatory-inspired). */
export async function runSecurityHeaders(
  target: string | undefined,

  flags: CliFlags,
): Promise<number> {
  const url = requireHttpUrl(target);

  const { page, analysis } = await withProgress(flags, `Fetching ${url}`, async () => {
    const page = await fetchPublicUrl(url);

    if (!page.ok) {
      throw new CliError(formatFetchError(page));
    }

    const headers = parseSecurityHeaders(page.headers);
    const ctx = buildAnalyzeContext({ finalUrl: page.finalUrl, status: page.status });

    return { page, analysis: analyzeSecurityHeaders(headers, ctx) };
  });
  emitCheckOutput(flags, {
    command: 'security-headers',
    url: page.finalUrl,
    json: { ok: true, command: 'security-headers', url: page.finalUrl, analysis },
    report: {
      title: 'Security Headers Scan',
      url: page.finalUrl,
      score: analysis.score,
      status: analysis.overallStatus,
      extra: `grade ${analysis.letterGrade}  ${analysis.summary.present}/${analysis.summary.total} headers`,
      checks: analysis.checks.map((check) =>
        toCheckRow({
          id: check.id,
          label: check.label,
          status: check.status,
          detail: check.value ?? check.detail,
        }),
      ),
    },
  });

  return failOnExitCode(analysis.overallStatus, flags.failOn);
}
