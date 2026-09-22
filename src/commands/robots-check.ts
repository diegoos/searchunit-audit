import type { CliFlags } from '../lib/args.ts';
import {
  fetchPublicUrl,
  formatFetchError,
  classifyWellKnownFetch,
  type FetchOutcome,
} from '../lib/fetch.ts';
import { CliError } from '../lib/errors.ts';
import { emitCheckOutput, failOnExitCode, toCheckRow } from '../lib/output.ts';
import { withProgress } from '../lib/progress.ts';
import { requireHttpUrl } from '../lib/url.ts';
import {
  analyzeRobots,
  analyzeAbsentRobots,
  analyzeRobotsFetchError,
  type RobotsAnalysis,
} from '../tools/robots/analyzeRobots.ts';
import { parseRobots } from '../tools/robots/parseRobots.ts';

/** Maps a robots.txt fetch onto the same present / missing / error split as audit. */
export function analysisForRobotsOutcome(page: FetchOutcome, requestPath: string): RobotsAnalysis {
  const kind = classifyWellKnownFetch(page, '/robots.txt');

  if (kind === 'present' && page.ok) {
    return analyzeRobots(parseRobots(page.body), requestPath);
  }

  if (kind === 'missing') {
    return analyzeAbsentRobots();
  }

  return analyzeRobotsFetchError();
}

function crawlerRows(
  allowed: number,
  total: number,
  denied: RobotsAnalysis['crawlers'],
): { id: string; status: 'pass' | 'warn' | 'fail'; detail: string }[] {
  if (total === 0) {
    return [{ id: 'unknown', status: 'warn', detail: 'fetch_error' }];
  }

  if (denied.length > 0) {
    return denied.map((crawler) => ({
      id: crawler.userAgent,
      status: crawler.access === 'blocked' ? 'fail' : 'warn',
      detail: crawler.access,
    }));
  }

  return [{ id: 'allowed', status: 'pass', detail: `${allowed}/${total}` }];
}

function extraLine(robotsUrl: string, analysis: RobotsAnalysis): string {
  if (analysis.present) {
    return `Fetched ${robotsUrl}`;
  }

  const presence = analysis.checks.find((check) => check.id === 'presence');

  if (presence?.detail === 'fetch_error') {
    return 'robots.txt fetch failed (crawler access unknown)';
  }

  return 'robots.txt not found (crawlers implicitly allowed)';
}

/** Fetches origin /robots.txt and scores syntax plus AI crawler access. */
export async function runRobotsCheck(target: string | undefined, flags: CliFlags): Promise<number> {
  const url = requireHttpUrl(target);
  const origin = new URL(url).origin;
  const robotsUrl = `${origin}/robots.txt`;
  const requestPath = new URL(url).pathname || '/';

  const analysis = await withProgress(flags, `Fetching ${robotsUrl}`, async () => {
    const page = await fetchPublicUrl(robotsUrl, { allowHttpErrors: true });

    if (!page.ok && (page.error === 'blocked' || page.error === 'invalid_url')) {
      throw new CliError(formatFetchError(page));
    }

    return analysisForRobotsOutcome(page, requestPath);
  });
  const allowed = analysis.crawlers.filter((crawler) => crawler.allowed).length;
  const total = analysis.crawlers.length;
  const denied = analysis.crawlers.filter((crawler) => !crawler.allowed);

  emitCheckOutput(flags, {
    command: 'robots-check',
    url,
    json: { ok: true, command: 'robots-check', url, resourceUrl: robotsUrl, analysis },
    report: {
      title: 'robots.txt Validator',
      url,
      score: analysis.score,
      status: analysis.overallStatus,
      extra: extraLine(robotsUrl, analysis),
      sections: [
        { heading: 'File', checks: analysis.checks.map(toCheckRow) },
        {
          heading: 'Crawlers',
          checks: crawlerRows(allowed, total, denied),
        },
      ],
    },
  });

  return failOnExitCode(analysis.overallStatus, flags.failOn);
}
