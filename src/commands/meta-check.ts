import type { CliFlags } from '../lib/args.ts';
import { fetchPageOrThrow } from '../lib/fetch.ts';
import { emitCheckOutput, failOnExitCode, toCheckRow } from '../lib/output.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';
import { analyzeMeta } from '../tools/meta/analyzeMeta.ts';
import { parseMeta } from '../tools/meta/parseMeta.ts';

/** Fetches HTML and scores title, description, canonical, and social tags. */
export async function runMetaCheck(target: string | undefined, flags: CliFlags): Promise<number> {
  const url = requireHttpUrl(target);

  const { page, analysis } = await withProgress(flags, `Fetching ${url}`, async () => {
    const page = await fetchPageOrThrow(url);
    const tags = parseMeta(page.body);

    return { page, analysis: analyzeMeta(tags, page.finalUrl) };
  });
  emitCheckOutput(flags, {
    command: 'meta-check',
    url: page.finalUrl,
    json: { ok: true, command: 'meta-check', url: page.finalUrl, analysis },
    report: {
      title: 'Meta Tags Test',
      url: page.finalUrl,
      score: analysis.score,
      status: analysis.overallStatus,
      checks: analysis.checks.map(toCheckRow),
    },
  });

  return failOnExitCode(analysis.overallStatus, flags.failOn);
}
