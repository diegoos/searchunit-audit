import type { CliFlags } from '../lib/args.ts';
import { runLocalDiscovery } from '../engine/discovery.ts';
import { buildAuditReport } from '../engine/report.ts';
import { auditThresholdStatus } from '../engine/findings.ts';
import { renderAudit } from '../render/audit.ts';
import { failOnExitCode, renderAgentMarkdown } from '../lib/output.ts';
import { persistFileOutput } from '../lib/outputFile.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';

/**

 * Runs a local deterministic SEO/GEO audit.

 */
export async function runAudit(target: string | undefined, flags: CliFlags): Promise<number> {
  const url = requireHttpUrl(target);
  const report = await withProgress(flags, `Fetching ${url}`, async (setText) => {
    const bundle = await runLocalDiscovery(url, setText);

    return buildAuditReport(bundle);
  });
  process.stdout.write(
    flags.agent ? renderAgentMarkdown(report) : `${renderAudit(report, flags.outFormat)}\n`,
  );

  persistFileOutput({
    flags,
    json: report,
    markdown: renderAudit(report, 'markdown'),
  });

  return failOnExitCode(auditThresholdStatus(report.blockers, report.findings), flags.failOn);
}
