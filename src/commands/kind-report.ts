import type { CliFlags } from '../lib/args.ts';
import { runLocalDiscovery } from '../engine/discovery.ts';
import { buildKindReport, type KindCommand } from '../engine/report.ts';
import { kindThresholdStatus, type KindReportKind } from '../engine/findings.ts';
import { renderKindReport } from '../render/audit.ts';
import { failOnExitCode, renderAgentMarkdown } from '../lib/output.ts';
import { persistFileOutput } from '../lib/outputFile.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';

/**
 * Runs discovery and prints the kind-scoped report used by geo-check / seo-check.
 */
export async function runKindReportCommand(
  command: KindCommand,
  kind: KindReportKind,
  target: string | undefined,
  flags: CliFlags,
): Promise<number> {
  const url = requireHttpUrl(target);
  const report = await withProgress(flags, `Fetching ${url}`, async (setText) => {
    const bundle = await runLocalDiscovery(url, setText);

    return buildKindReport(bundle, command, kind);
  });
  process.stdout.write(
    flags.agent ? renderAgentMarkdown(report) : `${renderKindReport(report, flags.outFormat)}\n`,
  );
  persistFileOutput({
    flags,
    json: report,
    markdown: renderKindReport(report, 'markdown'),
  });

  return failOnExitCode(kindThresholdStatus(kind, report.blockers, report.findings), flags.failOn);
}
