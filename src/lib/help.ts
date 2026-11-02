import pkg from '../../package.json' with { type: 'json' };
import { CANONICAL_COMMANDS, type CanonicalCommand } from './args.ts';
import { tableColumns } from './table.ts';
import { theme } from './theme.ts';

export const VERSION = pkg.version;

type Entry = readonly [label: string, detail: string];

const COMMAND_HELP: Record<CanonicalCommand, string> = {
  audit: 'Overall scores, seo-check, geo-check, tool findings, and the Google Profile URL',
  config: 'Get, set, or remove keys in .searchunit.yaml',
  'schema-check': 'JSON-LD on the page. Alias: schema-markup-check',
  'robots-check': 'robots.txt and AI crawler access. Alias: robots-txt-validator',
  'meta-check': 'Title, description, canonical, Open Graph. Alias: meta-tags-test',
  'llms-txt-check': 'llms.txt and llms-full.txt. Alias: llms-txt-validator',
  'security-headers': 'HTTP security headers. Alias: security-headers-scan',
  'geo-check': 'GEO score and GEO findings. Alias: ai-visibility, ai-visibility-check',
  'seo-check': 'SEO score and deterministic SEO findings',
  'google-profile': 'Google profile URL for the domain you pass. Alias: google-profile-finder',
  gsc: 'Read-only Search Console. A URL runs every read. A subcommand runs one read. Alias: search-console',
};

const OPTIONS: readonly Entry[] = [
  [
    '-f, --format',
    '<table|json|html|markdown>. Default: table. html and markdown: audit, geo-check, seo-check',
  ],
  [
    '-o, --output',
    '<file>. Also write that .json or .md file. Stdout stays --format. Not for config',
  ],
  ['--json', 'Same as --format=json'],
  [
    '--agent',
    'Plain markdown of the check or audit data on stdout. Every command. Overrides --format there',
  ],
  ['--silent', 'Suppress progress and “Wrote …” on stderr'],
  [
    '--fail-on <fail|warn>',
    'Exit 1 at or below the threshold. audit, geo-check, and seo-check use critical blockers and discovery findings for that report. Fetch tools use analyzer status. google-profile, gsc, and config ignore it',
  ],
  [
    '--max-bytes <n>',
    'Response body cap (bytes, or 512kb / 2mb). Default 2mb. Range 1kb–32mb. Over the cap is an error',
  ],
  [
    '--init-date <YYYY-MM-DD>',
    'gsc query start. With no --end-date, the end is 30 days later. Default window is unchanged when both are omitted',
  ],
  ['--end-date <YYYY-MM-DD>', 'gsc query end. With no --init-date, the start is 30 days earlier'],
  ['-g, --global', 'config: read and write $HOME/.searchunit.yaml'],
  ['--color / --no-color', 'Force ANSI color on or off'],
  ['-h, --help', 'Show this help'],
  ['-V, --version', 'Print version'],
];

const CONFIG: readonly Entry[] = [
  [
    'merge',
    'cwd .searchunit.yaml overlays $HOME/.searchunit.yaml, except crux_api_key, gsc_access_token, gsc_quota_project, and gsc_credentials. Flags override YAML',
  ],
  [
    'crux_api_key',
    '$HOME YAML, searchunit config set -g, or CRUX_API_KEY. Rejected without -g. Missing CrUX is not a failure',
  ],
  [
    'gsc_access_token',
    '$HOME YAML, searchunit config set -g, or GSC_ACCESS_TOKEN. Rejected without -g. An OAuth access token, valid about one hour. Missing token skips gsc',
  ],
  [
    'gsc_quota_project',
    '$HOME YAML, searchunit config set -g, or GSC_QUOTA_PROJECT. Rejected without -g. Google Cloud project id or number sent as x-goog-user-project. GOOGLE_CLOUD_QUOTA_PROJECT is the same value',
  ],
  [
    'gsc_credentials',
    '$HOME YAML, searchunit config set -g, or GSC_CREDENTIALS. Rejected without -g. Path to a service account JSON key. googleapis requests a webmasters.readonly token from it',
  ],
  ['output', 'Default for --format: table, json, html, or markdown'],
  ['max_body_bytes', 'Default for --max-bytes. --max-bytes overrides it'],
];

const NOTES: readonly Entry[] = [
  [
    'audit',
    'Fetches the page, parses it, scores the five GEO components, then prints seo-check, geo-check, every tool finding, and the Google Profile URL',
  ],
  [
    'Chrome render',
    'audit with --agent, --format json, or a .json -o also renders the page in headless Chrome (CHROME_PATH, else the default install). Without Chrome the render is skipped with a note on stderr. Install Google Chrome, or set CHROME_PATH. Markdown -o does not start Chrome',
  ],
  [
    'Lighthouse lab',
    'The same audit also runs the lighthouse CLI from PATH. Without it the lab is skipped with a note on stderr. Install it with: npm install -g lighthouse. The CLI never runs npx on its own',
  ],
  ['kind scores', 'overview, geo, and seo'],
  [
    'page type',
    'Schema.org types and og:type. When those do not identify the page, the report shows Undefined',
  ],
  [
    'body cap',
    'Default 2 MiB (--max-bytes / max_body_bytes, 1 KiB–32 MiB). A larger body is a fetch error',
  ],
  [
    'CrUX',
    'Reports include cruxApiKeyAvailable. With a key, technical foundations includes field Core Web Vitals and can change between runs. Without a key, that component omits them',
  ],
];

const EXAMPLES = [
  'searchunit audit https://example.com',
  'searchunit audit http://localhost:3000',
  'searchunit audit https://example.com --format=json',
  'searchunit audit https://example.com --agent',
  'searchunit audit https://example.com -o ./reports/audit.md',
  'searchunit schema-check https://example.com -o ./schema.json',
  'searchunit config',
  'searchunit gsc check',
  'searchunit gsc https://example.com',
  'searchunit gsc query-pages https://example.com',
  'searchunit gsc sitemaps https://example.com',
  'searchunit gsc inspect https://example.com',
  'searchunit config set -g crux_api_key YOUR_KEY',
  'searchunit config set -g gsc_access_token YOUR_TOKEN',
  'searchunit config set -g gsc_quota_project YOUR_PROJECT_ID',
  'searchunit config set -g gsc_credentials /path/to/credentials.json',
];

const CONFIG_OPERATIONS: readonly Entry[] = [
  ['list', 'List keys in cwd .searchunit.yaml'],
  ['list -g', 'List keys in $HOME/.searchunit.yaml'],
  ['(no args)', 'List every key: Local, Global, Default, Effective'],
  ['<key>', 'Show one key'],
  ['set <key> <value>', 'Set a key. Creates the file if it is missing'],
  ['remove <key>', 'Remove a key from the selected file'],
];

const CONFIG_OPTIONS: readonly Entry[] = [
  ['-g, --global', 'Read and write $HOME/.searchunit.yaml instead of the cwd file'],
  ['-f, --format', '<table|json>. Default: table. --json is the same as --format=json'],
  ['--agent', 'Plain markdown of the config payload on stdout'],
  ['--silent', 'Suppress “Created …” / “Updated …” on stderr'],
  ['-h, --help', 'Show this help'],
];

const CONFIG_NOTES: readonly Entry[] = [
  [
    'files',
    'cwd .searchunit.yaml unless -g/--global ($HOME/.searchunit.yaml). Missing values print as not set',
  ],
  [
    'crux_api_key',
    'Home YAML, -g, or CRUX_API_KEY. Without -g the command rejects and leaves the cwd file unchanged',
  ],
  [
    'gsc_access_token',
    'Home YAML, -g, or GSC_ACCESS_TOKEN. Without -g the command rejects and leaves the cwd file unchanged. Printed as [redacted]',
  ],
  [
    'gsc_quota_project',
    'Home YAML, -g, or GSC_QUOTA_PROJECT. Without -g the command rejects and leaves the cwd file unchanged. A project id or number, printed in full',
  ],
  [
    'gsc_credentials',
    'Home YAML, -g, or GSC_CREDENTIALS. Without -g the command rejects and leaves the cwd file unchanged. A path to the service account JSON key',
  ],
];

const CONFIG_EXAMPLES = [
  'searchunit config',
  'searchunit config list',
  'searchunit config list -g',
  'searchunit config output',
  'searchunit config set output json',
  'searchunit config remove output',
  'searchunit config set -g crux_api_key YOUR_KEY',
  'searchunit config remove -g crux_api_key',
  'searchunit config set -g gsc_access_token YOUR_TOKEN',
  'searchunit config set -g gsc_quota_project YOUR_PROJECT_ID',
  'searchunit config set -g gsc_credentials /path/to/credentials.json',
];

const MIN_DETAIL_WIDTH = 24;
/** Two-space indent, two-space gap, and slack so the detail does not hit the edge. */
const HELP_ROW_CHROME = 6;

function wrapWords(text: string, width: number): string[] {
  if (text.length <= width) {
    return [text];
  }

  const lines: string[] = [];
  let line = '';

  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;

    if (line && next.length > width) {
      lines.push(line);
      line = word;
      continue;
    }

    line = next;
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function alignEntries(entries: readonly Entry[], paint: (text: string) => string): string {
  const labelWidth = Math.max(...entries.map(([label]) => label.length));
  const detailWidth = Math.max(MIN_DETAIL_WIDTH, tableColumns() - labelWidth - HELP_ROW_CHROME);

  return entries
    .map(([label, detail]) =>
      wrapWords(detail, detailWidth)
        .map((line, index) => {
          const gutter = index === 0 ? paint(label.padEnd(labelWidth)) : ' '.repeat(labelWidth);

          return `  ${gutter}  ${theme.dim(line)}`;
        })
        .join('\n'),
    )
    .join('\n');
}

function paintExample(line: string): string {
  const parts = line.split(' ').map((part, index) => {
    if (index === 1) {
      return theme.command(part);
    }

    if (part.startsWith('-')) {
      return theme.option(part);
    }

    return theme.dim(part);
  });

  return `  ${parts.join(' ')}`;
}

function helpDocument(
  title: string,
  blurb: string,
  usage: string,
  sections: readonly { heading: string; body: string }[],
): string {
  const blocks = [
    theme.title(title),
    theme.dim(blurb),
    '',
    theme.heading('Usage'),
    usage,
    ...sections.flatMap(({ heading, body }) => ['', theme.heading(heading), body]),
  ];

  return `\n${blocks.join('\n')}\n`;
}

/** TTY help: aligned columns, cyan commands, magenta options. */
export function formatHelp(): string {
  const commands = CANONICAL_COMMANDS.map((name) => [name, COMMAND_HELP[name]] as const);

  return helpDocument(
    'SearchUnit CLI',
    'Local SEO/GEO audit for one public URL, or a dev server on localhost.',
    `  ${theme.dim('searchunit')} ${theme.command('<command>')} ${theme.dim('[target]')} ${theme.option('[options]')}`,
    [
      { heading: 'Commands', body: alignEntries(commands, theme.command) },
      { heading: 'Options', body: alignEntries(OPTIONS, theme.option) },
      { heading: 'Config', body: alignEntries(CONFIG, theme.heading) },
      { heading: 'Notes', body: alignEntries(NOTES, theme.heading) },
      { heading: 'Examples', body: EXAMPLES.map(paintExample).join('\n') },
    ],
  );
}

/** TTY help for `searchunit config`. */
export function formatConfigHelp(): string {
  return helpDocument(
    'searchunit config',
    'Get, set, or remove keys in .searchunit.yaml. Does not write reports.',
    `  ${theme.dim('searchunit')} ${theme.command('config')} ${theme.dim('[list | set | remove | key]')} ${theme.option('[options]')}`,
    [
      { heading: 'Operations', body: alignEntries(CONFIG_OPERATIONS, theme.command) },
      { heading: 'Options', body: alignEntries(CONFIG_OPTIONS, theme.option) },
      { heading: 'Config', body: alignEntries(CONFIG, theme.heading) },
      { heading: 'Notes', body: alignEntries(CONFIG_NOTES, theme.heading) },
      { heading: 'Examples', body: CONFIG_EXAMPLES.map(paintExample).join('\n') },
    ],
  );
}
