import type { CliFlags } from '../lib/args.ts';
import { fetchPublicUrl, formatFetchError } from '../lib/fetch.ts';
import { CliError } from '../lib/errors.ts';
import { emitCheckOutput, failOnExitCode, toCheckRow } from '../lib/output.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';
import { analyzeSchema } from '../tools/schema/analyzeSchema.ts';
import { parseSchema } from '../tools/schema/parseSchema.ts';

/** Fetches a page and scores JSON-LD blocks (Schema Markup Check). */
export async function runSchemaCheck(target: string | undefined, flags: CliFlags): Promise<number> {
  const url = requireHttpUrl(target);

  const { page, analysis } = await withProgress(flags, `Fetching ${url}`, async () => {
    const page = await fetchPublicUrl(url);

    if (!page.ok) {
      throw new CliError(formatFetchError(page));
    }

    const blocks = parseSchema(page.body);

    return { page, analysis: analyzeSchema(blocks) };
  });
  const json = {
    ok: true,
    command: 'schema-check',
    url: page.finalUrl,
    analysis,
  };
  const sections =
    analysis.blocks.length > 0
      ? analysis.blocks.map((block) => ({
          heading: block.types.join(', ') || `Block ${block.index}`,
          checks: block.checks.map(toCheckRow),
        }))
      : [{ checks: [{ id: 'jsonld', status: 'fail', detail: 'no application/ld+json blocks' }] }];
  emitCheckOutput(flags, {
    command: 'schema-check',
    url: page.finalUrl,
    json,
    report: {
      title: 'Schema Markup Check',
      url: page.finalUrl,
      score: analysis.score,
      status: analysis.overallStatus,
      extra: `${analysis.blocks.length} JSON-LD block(s)`,
      sections,
    },
  });

  return failOnExitCode(analysis.overallStatus, flags.failOn);
}
