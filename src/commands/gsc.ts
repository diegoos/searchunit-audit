import type { CliFlags } from '../lib/args.ts';
import { CliError } from '../lib/errors.ts';
import { redact, runGscQuery, type GscSlice } from '../gsc.ts';
import { renderAgentMarkdown, printJson } from '../lib/output.ts';
import { persistFileOutput } from '../lib/outputFile.ts';
import { formatTable } from '../lib/table.ts';
import { theme } from '../lib/theme.ts';

const TITLE = 'Search Console';

/** Performance subcommands. `inspect` is a separate mode. `gsc URL` runs every read. */
const SLICE_COMMANDS = [
  'queries',
  'pages',
  'query-pages',
  'page-queries',
  'sampled-pages',
  'search-appearance',
  'discover',
  'google-news',
  'sitemaps',
] as const satisfies readonly GscSlice[];

/** Subcommands that take a URL. `gsc URL` is the full read and is not in this list. */
const URL_COMMANDS = ['inspect', ...SLICE_COMMANDS] as const;

const SLICE_COMMAND_SET = new Set<string>(SLICE_COMMANDS);

/** True for a performance subcommand. */
function isSliceCommand(value: string): value is GscSlice {
  return SLICE_COMMAND_SET.has(value);
}

/**
 * Read-only Search Console figures. A missing token skips and exits 0.
 * `--fail-on` is ignored.
 */
export async function runGsc(target: string | undefined, flags: CliFlags): Promise<number> {
  const request = parseGscArgs(target, flags.rest);
  const payload = envelope(
    request.action,
    await runGscQuery({ ...request, initDate: flags.initDate, endDate: flags.endDate }),
  );

  emitGsc(flags, payload);

  return 0;
}

function parseGscArgs(
  target: string | undefined,
  rest: string[],
): {
  action: string;
  mode: 'check' | 'performance' | 'inspect';
  slice?: GscSlice;
  url?: string;
  sample?: string[];
} {
  if (target === 'check') {
    if (rest.length > 0) {
      throw new CliError('Too many arguments. Example: searchunit gsc check', 2);
    }

    return { action: 'check', mode: 'check' };
  }

  if (target === 'inspect' || (target !== undefined && isSliceCommand(target))) {
    const url = rest[0];

    if (!url) {
      throw new CliError(
        `A URL is required. Example: searchunit gsc ${target} https://example.com`,
        2,
      );
    }

    if (target === 'inspect') {
      return { action: 'inspect', mode: 'inspect', url, sample: rest.slice(1) };
    }

    return {
      action: target,
      mode: 'performance',
      slice: target,
      url,
      sample: rest.slice(1),
    };
  }

  if (!target) {
    throw new CliError('A URL is required. Example: searchunit gsc https://example.com', 2);
  }

  if (!looksLikeUrl(target)) {
    throw unknownGscCommand(target);
  }

  return { action: 'performance', mode: 'performance', url: target, sample: rest };
}

/** A page target has a scheme, a dot, a port, or a slash. A bare word is a subcommand. */
function looksLikeUrl(value: string): boolean {
  if (value.includes('://') || value.includes('.') || value.includes(':') || value.includes('/')) {
    return true;
  }

  return value === 'localhost' || value.endsWith('.localhost');
}

/** Exit 2. Names the typo and the nearest subcommand when one is close. */
function unknownGscCommand(name: string): CliError {
  const commands = ['check', ...URL_COMMANDS];
  const near = suggestCommand(name, commands);
  const hint = near ? ` Did you mean "${near}"?` : '';

  return new CliError(
    `Unknown command "${name}".${hint} Expected a URL or one of: ${commands.join(', ')}`,
    2,
  );
}

/** One command within two edits. A tie stays quiet. */
function suggestCommand(name: string, commands: readonly string[]): string | undefined {
  let best = '';
  let bestDistance = 3;
  let ties = 0;

  for (const command of commands) {
    const distance = editDistance(name, command);

    if (distance < bestDistance) {
      best = command;
      bestDistance = distance;
      ties = 1;
    } else if (distance === bestDistance) {
      ties += 1;
    }
  }

  if (ties !== 1 || !best) {
    return undefined;
  }

  return best;
}

/** Insert, delete, and substitute count. */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);

  for (let column = 1; column <= right.length; column += 1) {
    rows[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;

      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      );
    }
  }

  return rows[left.length][right.length];
}

/** Prints the payload only after credential-shaped text is removed. */
function envelope(action: string, payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    redact(JSON.stringify({ ok: true, command: 'gsc', action, ...payload })),
  ) as Record<string, unknown>;
}

function emitGsc(flags: CliFlags, payload: Record<string, unknown>): void {
  if (flags.agent) {
    process.stdout.write(renderAgentMarkdown(payload));
  } else if (flags.json || flags.outFormat === 'json') {
    printJson(payload);
  } else {
    console.log(renderGscTables(payload));
  }

  persistFileOutput({
    flags,
    json: payload,
    markdown: renderAgentMarkdown(payload),
  });
}

/** Human table for a Search Console payload. */
export function renderGscTables(payload: Record<string, unknown>): string {
  const blocks = [
    '',
    theme.title(TITLE),
    '',
    formatTable(['Field', 'Value'], summaryRows(payload)),
  ];
  const inspections = Array.isArray(payload.inspections)
    ? payload.inspections.filter(isRecord)
    : [];

  pushMetricTable(blocks, 'Queries', 'Query', rowsOf(payload.queries));
  pushMetricTable(blocks, 'Pages', 'Page', rowsOf(payload.pages));
  pushMetricTable(blocks, 'Sampled pages', 'Page', rowsOf(payload.sampledPages));
  pushMetricTable(blocks, 'Search appearance', 'Appearance', rowsOf(payload.searchAppearance));
  pushMetricTable(blocks, 'Discover', 'Page', rowsOf(payload.discover));
  pushMetricTable(blocks, 'Google News', 'Page', rowsOf(payload.googleNews));
  pushTable(
    blocks,
    'Query and page',
    ['Query', 'Page', 'Clicks', 'Impressions', 'CTR', 'Position'],
    rowsOf(payload.queryPages).map(queryPageRow),
  );
  pushTable(
    blocks,
    'Page queries',
    ['URL', 'Query', 'Clicks', 'Impressions', 'CTR', 'Position'],
    flatPageQueries(payload.pageQueries).map(pageQueryRow),
  );
  pushTable(
    blocks,
    'Sitemaps',
    ['Path', 'Errors', 'Warnings', 'Pending'],
    entriesOf(payload.sitemaps).map(sitemapRow),
  );
  pushTable(
    blocks,
    'Indexed version',
    ['URL', 'Verdict', 'Coverage', 'Indexing'],
    inspections.map(inspectionRow),
  );

  return blocks.join('\n');
}

/** Heading plus a table. An empty row list stays off the page. */
function pushTable(blocks: string[], title: string, headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    return;
  }

  blocks.push('', theme.heading(title), '', formatTable(headers, rows));
}

/** Metric rows under one heading. An empty slice stays off the page. */
function pushMetricTable(
  blocks: string[],
  title: string,
  keyLabel: string,
  rows: Record<string, unknown>[],
): void {
  pushTable(
    blocks,
    title,
    [keyLabel, 'Clicks', 'Impressions', 'CTR', 'Position'],
    rows.map(queryRow),
  );
}

function summaryRows(payload: Record<string, unknown>): string[][] {
  const rows: string[][] = [['status', text(payload.status)]];
  const fields: [string, unknown][] = [
    ['gsc', payload.gsc],
    ['reason', payload.reason],
    ['http', payload.http],
    ['message', payload.message],
    ['site', payload.siteUrl],
    ['window', windowText(payload.window)],
    ['urls', Array.isArray(payload.urls) ? String(payload.urls.length) : undefined],
    ['pages', countList(payload.pages, 'rows')],
    ['query pages', countList(payload.queryPages, 'rows')],
    ['page queries', pageQueryText(payload.pageQueries)],
    ['sampled pages', sampledText(payload.sampledPages)],
    ['sitemaps', countList(payload.sitemaps, 'entries')],
    ['search appearance', countList(payload.searchAppearance, 'rows')],
    ['discover', countList(payload.discover, 'rows')],
    ['google news', countList(payload.googleNews, 'rows')],
    [
      'unexpected',
      Array.isArray(payload.unexpected) ? payload.unexpected.map(text).join(', ') : undefined,
    ],
  ];

  for (const [label, value] of fields) {
    push(rows, label, value);
  }

  return rows;
}

function push(rows: string[][], label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  rows.push([label, text(value)]);
}

function queryRow(row: Record<string, unknown>): string[] {
  return [keyTexts(row.keys).join(' '), ...metricCells(row)];
}

function queryPageRow(row: Record<string, unknown>): string[] {
  const keys = keyTexts(row.keys);

  return [keys[0] ?? '', keys[1] ?? '', ...metricCells(row)];
}

function pageQueryRow(row: { url: string; query: Record<string, unknown> }): string[] {
  const keys = keyTexts(row.query.keys);

  return [row.url, keys[0] ?? '', ...metricCells(row.query)];
}

function keyTexts(keys: unknown): string[] {
  return Array.isArray(keys) ? keys.map(text) : [];
}

function metricCells(row: Record<string, unknown>): string[] {
  return [text(row.clicks), text(row.impressions), text(row.ctr), text(row.position)];
}

function sitemapRow(row: Record<string, unknown>): string[] {
  return [text(row.path), text(row.errors), text(row.warnings), text(row.isPending)];
}

function inspectionRow(row: Record<string, unknown>): string[] {
  return [
    text(row.url ?? row.message),
    text(row.verdict ?? row.error),
    text(row.coverageState),
    text(row.indexingState),
  ];
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.rows)) {
    return [];
  }

  return value.rows.filter(isRecord);
}

function entriesOf(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return [];
  }

  return value.entries.filter(isRecord);
}

function flatPageQueries(value: unknown): { url: string; query: Record<string, unknown> }[] {
  if (!isRecord(value) || !Array.isArray(value.pages)) {
    return [];
  }

  const rows: { url: string; query: Record<string, unknown> }[] = [];

  for (const page of value.pages) {
    if (!isRecord(page) || !Array.isArray(page.rows)) {
      continue;
    }

    const url = text(page.url);

    for (const query of page.rows) {
      if (isRecord(query)) {
        rows.push({ url, query });
      }
    }
  }

  return rows;
}

function countList(value: unknown, field: 'rows' | 'entries'): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.error === 'number') {
    return `error ${value.error}`;
  }

  const list = value[field];

  return Array.isArray(list) ? String(list.length) : undefined;
}

function sampledText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const count = Array.isArray(value.rows) ? value.rows.length : 0;
  const errors = Array.isArray(value.errors) ? value.errors.length : 0;

  return errors > 0 ? `${count} rows, ${errors} errors` : String(count);
}

function pageQueryText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.pages)) {
    return undefined;
  }

  let rows = 0;
  let errors = 0;

  for (const page of value.pages) {
    if (!isRecord(page)) {
      continue;
    }

    if (typeof page.error === 'number') {
      errors += 1;
      continue;
    }

    rows += Array.isArray(page.rows) ? page.rows.length : 0;
  }

  return errors > 0 ? `${rows} rows, ${errors} errors` : String(rows);
}

function windowText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const start = text(value.startDate);
  const end = text(value.endDate);

  if (!start || !end) {
    return undefined;
  }

  return `${start} .. ${end}`;
}

function text(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
