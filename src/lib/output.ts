import { cruxApiKeyAvailable, cruxApiKeyLabel } from './config.ts';
import type { CliFlags } from './args.ts';
import { persistFileOutput } from './outputFile.ts';
import { formatTable } from './table.ts';
import {
  bannerMark,
  humanizeLabel,
  paintScore,
  paintStatus,
  statusLegend,
  statusSymbol,
  theme,
} from './theme.ts';

/** Max visible length for finding/check details in tables and markdown lists. */
const DETAIL_CAP = 140;

/** Strips C0 controls (except tab/newline) so remote strings cannot drive a TTY. */
export function stripControls(value: string): string {
  let out = '';

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 9 || code === 10) {
      out += value[i];
      continue;
    }

    if (code <= 31 || code === 127 || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }

    out += value[i];
  }

  return out;
}

/** One-line detail for TTY/markdown; JSON keeps the full string. */
export function clipDetail(value: string, max = DETAIL_CAP): string {
  const text = stripControls(value).replaceAll('\n', ' ').trim();

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

/** Escapes remote strings for Markdown so HTML and table cells stay inert. */
export function escapeMarkdown(value: string): string {
  return stripControls(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .replaceAll('#', '\\#')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('`', '\\`');
}

export interface CheckRow {
  id: string;
  status: string;
  detail?: string;
}

/** Maps an analyzer check onto a display row with a human label. */
export function toCheckRow(check: {
  id: string;
  label?: string;
  status: string;
  detail?: string;
}): CheckRow {
  return {
    id: humanizeLabel(check.label ?? check.id),
    status: check.status,
    detail: check.detail,
  };
}

interface ReportSection {
  heading?: string;
  checks: CheckRow[];
}

interface ReportKpi {
  status: string;
  label: string;
  value: string;
}

export interface ReportHeaderInput {
  title: string;
  url?: string;
  score?: number;
  status?: string;
  /** Pre-styled summary line (e.g. painted "Moderate"). */
  label?: string;
  extra?: string;
  kpis?: ReportKpi[];
}

export interface ToolReportInput extends ReportHeaderInput {
  checks?: CheckRow[];
  sections?: ReportSection[];
  /** Extra TTY block after the shared header (e.g. a Field/Value table). */
  body?: string;
}

function reportSections(input: ToolReportInput): ReportSection[] {
  if (input.sections) {
    return input.sections;
  }

  if (input.checks) {
    return [{ checks: input.checks }];
  }

  return [];
}

function kpiKind(status: string): 'fail' | 'warn' | 'pass' {
  if (status === 'fail') {
    return 'fail';
  }

  if (status === 'warn') {
    return 'warn';
  }

  return 'pass';
}

/** One KPI: status mark, dim label, colored value. */
export function formatKpiLine(status: string, label: string, value: string): string {
  const kind = kpiKind(status);
  const safeLabel = stripControls(label);
  const safeValue = stripControls(value);

  return `${bannerMark(kind)}  ${theme.dim(safeLabel.padEnd(12))} ${paintStatus(kind, safeValue)}`;
}

/**
 * Shared TTY header for every command: title/score, URL, summary, legend, KPIs.
 * Blank lines separate blocks so the title/score line can breathe.
 */
export function formatReportHeader(input: ReportHeaderInput): string {
  const mark = input.status ? `${statusSymbol(input.status)}  ` : '';
  const score =
    input.score === undefined
      ? ''
      : `  ${theme.dim('·')}  ${paintScore(input.score, theme.score(String(input.score)))}`;
  const blocks: string[] = [`${mark}${theme.title(input.title)}${score}`];

  if (input.url) {
    blocks.push(theme.url(stripControls(input.url)));
  }

  const summary: string[] = [];

  if (input.label) {
    summary.push(input.label);
  }

  if (input.extra) {
    summary.push(theme.dim(stripControls(input.extra)));
  }

  if (summary.length > 0) {
    blocks.push(summary.join('\n'));
  }

  blocks.push(theme.dim(statusLegend()));

  if (input.kpis && input.kpis.length > 0) {
    blocks.push(
      input.kpis.map((kpi) => formatKpiLine(kpi.status, kpi.label, kpi.value)).join('\n'),
    );
  }

  return `\n${blocks.join('\n\n')}\n`;
}

/** Builds a Status / Check / Detail table from analyzer rows. */
export function formatCheckTable(checks: CheckRow[]): string {
  if (checks.length === 0) {
    return '';
  }

  return formatTable(
    ['Status', 'Check', 'Detail'],
    checks.map((check) => [
      statusSymbol(check.status),
      stripControls(check.id),
      clipDetail(check.detail?.trim() ? check.detail : 'missing'),
    ]),
  );
}

/** Builds the human-readable tool report (header + result tables). */
export function formatToolReport(input: ToolReportInput): string {
  const lines: string[] = [formatReportHeader(input)];

  if (input.body) {
    lines.push(input.body);
  }

  for (const section of reportSections(input)) {
    if (section.heading) {
      lines.push(theme.heading(stripControls(section.heading)));
    }

    const table = formatCheckTable(section.checks);

    if (table) {
      lines.push(table);
    }

    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '');
}

/** Markdown report for `-o markdown` on standalone check commands. */
export function formatToolMarkdown(input: ToolReportInput): string {
  const lines: string[] = [`# ${input.title}`, ''];

  if (input.score !== undefined) {
    lines.push(`Score: ${input.score}`, '');
  }

  if (input.url) {
    lines.push(stripControls(input.url), '');
  }

  if (input.label) {
    lines.push(stripControls(input.label));
  }

  if (input.extra) {
    lines.push(stripControls(input.extra));
  }

  if (input.label || input.extra) {
    lines.push('');
  }

  if (input.kpis && input.kpis.length > 0) {
    for (const kpi of input.kpis) {
      lines.push(`- **${kpi.status}** ${escapeMarkdown(kpi.label)}: ${escapeMarkdown(kpi.value)}`);
    }

    lines.push('');
  }

  for (const section of reportSections(input)) {
    if (section.heading) {
      lines.push(`## ${escapeMarkdown(section.heading)}`, '');
    }

    for (const check of section.checks) {
      const detail = check.detail ? ` — ${escapeMarkdown(clipDetail(check.detail))}` : '';

      lines.push(`- **${check.status}** ${escapeMarkdown(check.id)}${detail}`);
    }

    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** Prints a human-readable tool report (title, optional score, check rows). */
function printToolReport(input: ToolReportInput): void {
  console.log(formatToolReport(input));
}

/**
 * Prints the check to stdout, then writes `-o` / `--output` when set.
 */
export function emitCheckOutput(
  flags: CliFlags,
  opts: {
    command: string;
    url: string;
    json: unknown;
    report: ToolReportInput;
    /** Overrides the markdown file body (default: formatToolMarkdown(report)). */
    markdown?: string;
  },
): void {
  const cruxLine = cruxApiKeyLabel();
  const report: ToolReportInput = {
    ...opts.report,
    extra: opts.report.extra ? `${opts.report.extra}\n${cruxLine}` : cruxLine,
  };
  const json = withCruxApiKey(opts.json);

  if (flags.agent) {
    process.stdout.write(renderAgentMarkdown(json));
  } else if (flags.json) {
    printJson(json);
  } else {
    printToolReport(report);
  }

  persistFileOutput({
    flags,
    json,
    markdown: opts.markdown
      ? `${opts.markdown.replace(/\n+$/, '')}\n\n${cruxLine}\n`
      : formatToolMarkdown(report),
  });
}

/** Adds key availability to a check payload. Leaves non-objects unchanged. */
function withCruxApiKey(json: unknown): unknown {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return json;
  }

  return { ...json, cruxApiKeyAvailable: cruxApiKeyAvailable() };
}

/** Prints JSON to stdout (pretty when TTY). */
export function printJson(payload: unknown): void {
  const space = process.stdout.isTTY ? 2 : undefined;

  console.log(JSON.stringify(payload, null, space));
}

/** Maps overall status to a process exit code when --fail-on is set. */
export function failOnExitCode(
  overall: CheckStatus | string | undefined,
  failOn: 'fail' | 'warn' | undefined,
): number {
  if (!failOn || !overall) {
    return 0;
  }

  if (overall === 'fail') {
    return 1;
  }

  if (failOn === 'warn' && overall === 'warn') {
    return 1;
  }

  return 0;
}

/**
 * Plain markdown of a check or audit payload.
 * Headings name objects and arrays. Scalar lines keep the full value.
 */
export function renderAgentMarkdown(value: unknown): string {
  const lines = isRecord(value) ? renderAgentRecord(value) : [formatAgentScalar(value)];

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderAgentRecord(record: Record<string, unknown>): string[] {
  const title = typeof record.command === 'string' ? record.command : 'report';

  return [`# ${agentOneLine(title)}`, '', ...renderAgentObject(record, 2)];
}

function renderAgentObject(record: Record<string, unknown>, depth: number): string[] {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    lines.push(...renderAgentField(key, value, depth));
  }

  if (lines.length === 0) {
    return ['(empty)'];
  }

  return lines;
}

function renderAgentField(key: string, value: unknown, depth: number): string[] {
  if (isRecord(value)) {
    return agentSection(key, depth, renderAgentObject(value, depth + 1));
  }

  if (Array.isArray(value)) {
    return agentSection(key, depth, renderAgentArray(value, depth + 1));
  }

  return [agentScalarLine(key, value)];
}

function agentSection(key: string, depth: number, body: string[]): string[] {
  return [agentHeading(key, depth), ...body, ''];
}

function renderAgentArray(items: unknown[], depth: number): string[] {
  if (items.length === 0) {
    return ['(empty)'];
  }

  if (items.every(isAgentScalar)) {
    return items.map((item) => `- ${formatAgentScalar(item)}`);
  }

  const lines: string[] = [];

  for (let index = 0; index < items.length; index++) {
    lines.push(...renderAgentField(String(index), items[index], depth));
  }

  return lines;
}

function agentHeading(label: string, depth: number): string {
  const level = Math.min(Math.max(depth, 1), 6);

  return `${'#'.repeat(level)} ${agentOneLine(label)}`;
}

function agentScalarLine(key: string, value: unknown): string {
  const text = formatAgentScalar(value);

  if (!text.includes('\n')) {
    return `${key}: ${text}`;
  }

  const body = text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

  return `${key}: |\n${body}`;
}

function formatAgentScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    return stripControls(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return stripControls(JSON.stringify(value));
}

function agentOneLine(value: string): string {
  return stripControls(value).replaceAll('\n', ' ').trim();
}

function isAgentScalar(value: unknown): boolean {
  return !isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Prints a runtime error to stderr (chalkStderr). */
export function printError(message: string): void {
  console.error(theme.error(`error: ${message}`));
}
