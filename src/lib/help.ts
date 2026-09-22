import pkg from '../../package.json' with { type: 'json' };
import { CANONICAL_COMMANDS, type CanonicalCommand } from './args.ts';
import { tableColumns } from './table.ts';
import { theme } from './theme.ts';

export const VERSION = pkg.version;

type Entry = readonly [label: string, detail: string];

const COMMAND_HELP: Record<CanonicalCommand, string> = {
  audit: 'Overall scores, seo-check, geo-check, tool findings, and the Google Profile URL',
  config: 'Get, set, or unset keys in .searchunit.yaml',
  'schema-check': 'JSON-LD on the page. Alias: schema-markup-check',
  'robots-check': 'robots.txt and AI crawler access. Alias: robots-txt-validator',
  'meta-check': 'Title, description, canonical, Open Graph. Alias: meta-tags-test',
  'llms-txt-check': 'llms.txt and llms-full.txt. Alias: llms-txt-validator',
  'security-headers': 'HTTP security headers. Alias: security-headers-scan',
  'geo-check': 'GEO score and GEO findings. Alias: ai-visibility, ai-visibility-check',
  'seo-check': 'SEO score and deterministic SEO findings',
  'google-profile': 'Google profile URL for the domain you pass. Alias: google-profile-finder',
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
    'Exit 1 at or below the threshold. audit, geo-check, and seo-check use critical blockers and discovery findings for that report. Fetch tools use analyzer status. google-profile and config ignore it',
  ],
  [
    '--max-bytes <n>',
    'Response body cap (bytes, or 512kb / 2mb). Default 2mb. Range 1kb–32mb. Over the cap is an error',
  ],
  ['-g, --global', 'config: read and write $HOME/.searchunit.yaml'],
  ['--unset', 'config: remove a key'],
  ['--color / --no-color', 'Force ANSI color on or off'],
  ['-h, --help', 'Show this help'],
  ['-V, --version', 'Print version'],
];

const CONFIG: readonly Entry[] = [
  [
    'merge',
    'cwd .searchunit.yaml overlays $HOME/.searchunit.yaml, except crux_api_key. Flags override YAML',
  ],
  [
    'crux_api_key',
    '$HOME YAML, searchunit config -g, or CRUX_API_KEY. Rejected without -g. Missing CrUX is not a failure',
  ],
  ['output', 'Default for --format: table, json, html, or markdown'],
  ['max_body_bytes', 'Default for --max-bytes. --max-bytes overrides it'],
];

const NOTES: readonly Entry[] = [
  [
    'audit',
    'Fetches the page, parses it, scores the five GEO components, then prints seo-check, geo-check, every tool finding, and the Google Profile URL',
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
  'searchunit audit https://example.com --format=json',
  'searchunit audit https://example.com --agent',
  'searchunit audit https://example.com -o ./reports/audit.md',
  'searchunit schema-check https://example.com -o ./schema.json',
  'searchunit config',
  'searchunit config -g crux_api_key YOUR_KEY',
];

const CONFIG_OPERATIONS: readonly Entry[] = [
  ['list', 'List keys in cwd .searchunit.yaml'],
  ['list -g', 'List keys in $HOME/.searchunit.yaml'],
  ['(no args)', 'List every key: Local, Global, Default, Effective'],
  ['<key>', 'Show one key'],
  ['<key> <value>', 'Set a key. Creates the file if it is missing'],
  ['--unset <key>', 'Remove a key from the selected file'],
];

const CONFIG_OPTIONS: readonly Entry[] = [
  ['-g, --global', 'Read and write $HOME/.searchunit.yaml instead of the cwd file'],
  ['--unset', 'Remove <key> from the selected file'],
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
];

const CONFIG_EXAMPLES = [
  'searchunit config',
  'searchunit config list',
  'searchunit config list -g',
  'searchunit config output',
  'searchunit config output json',
  'searchunit config --unset output',
  'searchunit config -g crux_api_key YOUR_KEY',
  'searchunit config -g --unset crux_api_key',
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
    'Local SEO/GEO audit for one public URL.',
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
    'Get, set, or unset keys in .searchunit.yaml. Does not write reports.',
    `  ${theme.dim('searchunit')} ${theme.command('config')} ${theme.dim('[list | key] [value]')} ${theme.option('[options]')}`,
    [
      { heading: 'Operations', body: alignEntries(CONFIG_OPERATIONS, theme.command) },
      { heading: 'Options', body: alignEntries(CONFIG_OPTIONS, theme.option) },
      { heading: 'Config', body: alignEntries(CONFIG, theme.heading) },
      { heading: 'Notes', body: alignEntries(CONFIG_NOTES, theme.heading) },
      { heading: 'Examples', body: CONFIG_EXAMPLES.map(paintExample).join('\n') },
    ],
  );
}
