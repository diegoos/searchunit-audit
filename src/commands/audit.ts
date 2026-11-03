import { fileOutputFormat, type CliFlags } from '../lib/args.ts';
import { runLocalDiscovery } from '../engine/discovery.ts';
import { buildAuditReport, type AuditReport } from '../engine/report.ts';
import { auditThresholdStatus } from '../engine/findings.ts';
import { renderPage, unrenderedPage } from '../engine/render.ts';
import {
  refusedLighthouse,
  skippedLighthouse,
  startLighthouse,
  type LighthouseHandle,
  type LighthouseReport,
} from '../engine/lighthouse.ts';
import type { RenderedPage } from '../engine/types.ts';
import { renderAudit } from '../render/audit.ts';
import { failOnExitCode, printNotice, renderAgentMarkdown } from '../lib/output.ts';
import { persistFileOutput } from '../lib/outputFile.ts';
import { isMachineOutput, withProgress } from '../lib/progress.ts';
import { resolvePublicHop } from '../lib/fetch.ts';
import { requireHttpUrl } from '../lib/url.ts';

/** Why a skipped tool was skipped, as the `note:` line says it. */
const SKIP_CAUSES: Partial<Record<string, string>> = {
  'binary-missing': 'lighthouse is not on PATH. Install it with:',
  'chrome-missing': 'Chrome not found.',
};

/** One `note:` line for a skipped tool that has an install hint. Null otherwise. */
function skipNote(tool: string, reason: string | undefined, install: string | null): string | null {
  const cause = reason ? SKIP_CAUSES[reason] : undefined;

  if (!cause || !install) {
    return null;
  }

  return `${tool} skipped: ${cause} ${install}`;
}

/** Stderr note lines for the skipped lab and render. None with `--silent` or on machine output. */
export function skipNotes(
  lab: LighthouseReport,
  render: RenderedPage,
  flags: Pick<CliFlags, 'silent' | 'outFormat' | 'agent'>,
): string[] {
  if (flags.silent || isMachineOutput(flags)) {
    return [];
  }

  const notes = [
    skipNote('Lighthouse lab', lab.reason, lab.install),
    skipNote('Chrome render', render.reason ?? undefined, render.install),
  ];

  return notes.filter((note): note is string => note !== null);
}

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

/**
 * Runs a local deterministic SEO/GEO audit.
 * Human stdout prints before the lab. Agent and JSON wait. A `.json` file waits. Markdown does not start Chrome.
 * The lab trigger also runs the Chrome render, before the report is built.
 * A discovery error still kills the child.
 */
export async function runAudit(target: string | undefined, flags: CliFlags): Promise<number> {
  const url = requireHttpUrl(target);
  let lab: LighthouseHandle | null = null;

  try {
    const bundle = await withProgress(flags, `Fetching ${url}`, (setText) =>
      runLocalDiscovery(url, setText, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, true),
    );
    const labUrl = lighthouseAuditUrl(url, bundle.auditedUrl);
    const hop = auditRequestsLighthouse(flags) ? await resolvePublicHop(new URL(labUrl)) : null;

    if (hop) {
      lab = hop.ok ? startLighthouse(labUrl, hop.pinnedAddress) : refusedLighthouse(labUrl);
    }

    if (hop?.ok) {
      const { pinnedAddress } = hop;

      bundle.renderedPage = await withProgress(flags, `Rendering ${labUrl}`, () =>
        renderPage(
          labUrl,
          pinnedAddress,
          bundle.securityHeaders.x_robots_tag,
          bundle.auditedPage.internalLinkIndex,
        ),
      );
    } else if (hop) {
      bundle.renderedPage = unrenderedPage('error');
    }

    const report = buildAuditReport(bundle);

    const stdoutWaits = auditStdoutWaitsForLighthouse(flags);

    if (!stdoutWaits) {
      writeAuditStdout(report, flags);
    }

    report.lighthouse = lab ? await lab.promise : skippedLighthouse(labUrl);

    for (const note of skipNotes(report.lighthouse, report.discovery.renderedPage, flags)) {
      printNotice(note);
    }

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
