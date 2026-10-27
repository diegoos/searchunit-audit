import { fileOutputFormat, type CliFlags } from '../lib/args.ts';
import { runLocalDiscovery } from '../engine/discovery.ts';
import { buildAuditReport, type AuditReport } from '../engine/report.ts';
import { auditThresholdStatus } from '../engine/findings.ts';
import {
  refusedLighthouse,
  skippedLighthouse,
  startLighthouse,
  type LighthouseHandle,
} from '../engine/lighthouse.ts';
import { renderAudit } from '../render/audit.ts';
import { failOnExitCode, renderAgentMarkdown } from '../lib/output.ts';
import { persistFileOutput } from '../lib/outputFile.ts';
import { withProgress } from '../lib/progress.ts';
import { resolvePublicHop } from '../lib/fetch.ts';
import { requireHttpUrl } from '../lib/url.ts';

/** Agent and JSON stdout include the lab object, so they wait for it. */
export function auditStdoutWaitsForLighthouse(
  flags: Pick<CliFlags, 'agent' | 'outFormat'>,
): boolean {
  return flags.agent || flags.outFormat === 'json';
}

/** Lab runs for agent, JSON stdout, or a `.json` file. Markdown `-o` stays the human report. */
export function auditRequestsLighthouse(
  flags: Pick<CliFlags, 'agent' | 'outFormat' | 'outputPath'>,
): boolean {
  if (auditStdoutWaitsForLighthouse(flags)) {
    return true;
  }

  if (!flags.outputPath) {
    return false;
  }

  return fileOutputFormat(flags.outputPath) === 'json';
}

/** Lab loads the URL discovery scored, after redirects. */
export function lighthouseAuditUrl(requestedUrl: string, auditedUrl: string): string {
  return auditedUrl || requestedUrl;
}

function writeAuditStdout(report: AuditReport, flags: CliFlags): void {
  const body = flags.agent
    ? renderAgentMarkdown(report)
    : `${renderAudit(report, flags.outFormat)}\n`;

  process.stdout.write(body);
}

async function openLighthouse(url: string, flags: CliFlags): Promise<LighthouseHandle | null> {
  if (!auditRequestsLighthouse(flags)) {
    return null;
  }

  const hop = await resolvePublicHop(new URL(url));

  if (!hop.ok) {
    return refusedLighthouse(url);
  }

  return startLighthouse(url, hop.pinnedAddress);
}

/**
 * Runs a local deterministic SEO/GEO audit.
 * Human stdout prints before the lab. Agent and JSON wait. A `.json` file waits. Markdown does not start Chrome.
 * A discovery error still kills the child.
 */
export async function runAudit(target: string | undefined, flags: CliFlags): Promise<number> {
  const url = requireHttpUrl(target);
  let lab: LighthouseHandle | null = null;

  try {
    const report = await withProgress(flags, `Fetching ${url}`, async (setText) => {
      const bundle = await runLocalDiscovery(
        url,
        setText,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        true,
      );

      return buildAuditReport(bundle);
    });
    const labUrl = lighthouseAuditUrl(url, report.url);

    lab = await openLighthouse(labUrl, flags);

    const stdoutWaits = auditStdoutWaitsForLighthouse(flags);

    if (!stdoutWaits) {
      writeAuditStdout(report, flags);
    }

    report.lighthouse = lab ? await lab.promise : skippedLighthouse(labUrl);

    if (stdoutWaits) {
      writeAuditStdout(report, flags);
    }

    persistFileOutput({
      flags,
      json: report,
      markdown: renderAudit(report, 'markdown'),
    });

    return failOnExitCode(auditThresholdStatus(report.blockers, report.findings), flags.failOn);
  } finally {
    if (lab) {
      lab.kill();
    }
  }
}
