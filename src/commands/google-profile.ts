import type { CliFlags } from '../lib/args.ts';
import { CliError } from '../lib/errors.ts';
import { googleProfileFields, googleProfileSummary } from '../lib/googleProfile.ts';

import { emitCheckOutput, formatToolMarkdown } from '../lib/output.ts';
import { formatTable } from '../lib/table.ts';

const TITLE = 'Google Profile Finder';
const EXTRA = 'Builds the Google profile URL for the exact domain you pass (www stays www).';

/**
 * Builds a Google Business Profile URL from a domain (no network fetch).
 */
export async function runGoogleProfile(
  target: string | undefined,
  flags: CliFlags,
): Promise<number> {
  if (!target || !target.trim()) {
    throw new CliError('A domain is required. Example: searchunit google-profile example.com');
  }

  const profile = googleProfileSummary(target);

  if (!profile.domain.includes('.')) {
    throw new CliError(`Invalid domain: ${target}`);
  }

  const url = `https://${profile.domain}`;

  const fields = googleProfileFields(profile);
  const report = { title: TITLE, url, extra: EXTRA, body: formatTable(['Field', 'Value'], fields) };

  emitCheckOutput(flags, {
    command: 'google-profile',
    url,
    json: { ok: true, command: 'google-profile', ...profile },
    report,

    markdown:
      formatToolMarkdown(report) +
      ['| Field | Value |', '| --- | --- |', ...fields.map(([k, v]) => `| ${k} | ${v} |`), ''].join(
        '\n',
      ),
  });

  return 0;
}
