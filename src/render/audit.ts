import { isPageIndexable } from '../engine/robotsDirective.ts';
import {
  REPORT_KINDS,
  type AuditReport,
  type KindReport,
  type KindReportBody,
} from '../engine/report.ts';
import type { AuditScores } from '../engine/scoring.ts';
import type { Finding, FindingSeverity } from '../engine/types.ts';
import type { OutputFormat } from '../lib/args.ts';
import { cruxApiKeyLabel } from '../lib/config.ts';
import { googleProfileFields, type GoogleProfileSummary } from '../lib/googleProfile.ts';
import { clipDetail, escapeMarkdown, formatReportHeader, stripControls } from '../lib/output.ts';
import { formatTable } from '../lib/table.ts';
import {
  bannerMark,
  humanizeLabel,
  paintScore,
  paintStatus,
  scoreStatus,
  statusSymbol,
  theme,
} from '../lib/theme.ts';

const GROUP_LABEL: Record<string, string> = {
  'critical-blocker': 'Critical blockers',
  'security-headers': 'Security headers',
  'llms-full': 'llms-full.txt',
  llms: 'llms.txt',
  crawlers: 'Crawlers',
  citability: 'Citability',
  platform: 'Platform',
  content: 'Content',
  discover: 'Discover',
  speakable: 'Speakable',
};

export function findingGroupLabel(source: string): string {
  if (source === 'schema' || source.startsWith('schema:')) {
    return 'Schema';
  }

  if (GROUP_LABEL[source]) {
    return GROUP_LABEL[source];
  }

  const label = humanizeLabel(source);

  return label.charAt(0).toUpperCase() + label.slice(1);
}

function schemaGroupHeading(findings: readonly Finding[]): string {
  const type = findings.find((finding) => finding.title === 'type');
  const name = type?.detail.trim();

  if (name && name !== 'missing') {
    return `Schema: ${name.split(' — ')[0]}`;
  }

  return 'Schema';
}

function groupHeading(source: string, findings: readonly Finding[]): string {
  if (source === 'schema' || source.startsWith('schema:')) {
    return schemaGroupHeading(findings);
  }

  return findingGroupLabel(source);
}

export function groupFindings(
  findings: readonly Finding[],
): { heading: string; findings: Finding[] }[] {
  const groups: { source: string; findings: Finding[] }[] = [];

  for (const finding of findings) {
    const last = groups.at(-1);

    if (last && last.source === finding.source) {
      last.findings.push(finding);
    } else {
      groups.push({ source: finding.source, findings: [finding] });
    }
  }

  return groups.map((group) => ({
    heading: groupHeading(group.source, group.findings),
    findings: group.findings,
  }));
}

function scoreCell(score: number | null): string {
  return score === null ? '—' : String(score);
}

/** Title KPI follows meta-check length status when that finding exists. */
function titleKpi(report: AuditReport | KindReport): { status: FindingSeverity; value: string } {
  const finding = report.findings.find((f) => f.id === 'meta:title');

  if (finding) {
    return { status: finding.severity, value: finding.detail };
  }

  const title = report.discovery.auditedPage.title;

  return { status: title ? 'pass' : 'fail', value: title ? 'present' : 'missing' };
}

function crawlerKind(status: string): 'pass' | 'fail' | 'warn' {
  if (status === 'allowed') {
    return 'pass';
  }

  return status === 'blocked' ? 'fail' : 'warn';
}

function indexableKpi(report: AuditReport | KindReport): {
  status: FindingSeverity;
  label: string;
  value: string;
} {
  const page = report.discovery.auditedPage;
  const indexable = isPageIndexable(
    page.statusCode,
    page.robotsDirective,
    report.discovery.securityHeaders.x_robots_tag,
    page.metaRobotsByBot,
  );

  return {
    status: indexable ? 'pass' : 'fail',
    label: 'Indexable',
    value: indexable ? 'yes' : 'no',
  };
}

function scoreExtra(scores: AuditScores, cruxApiKeyAvailable: boolean): string {
  return `confidence ${scores.confidence}  ·  evidence ${scores.evidence_quality}  ·  ${cruxApiKeyLabel(cruxApiKeyAvailable)}`;
}

function crawlerLine(bot: string, status: string): string {
  const kind = crawlerKind(status);

  return `${bannerMark(kind)}  ${bot.padEnd(18)} ${paintStatus(kind, status)}`;
}

function findingRows(findings: readonly Finding[]): string[][] {
  return findings.map((finding) => [
    statusSymbol(finding.severity),
    stripControls(humanizeLabel(finding.title)),
    clipDetail(finding.detail),
  ]);
}

function scoreTable(scores: AuditScores): string {
  return formatTable(
    ['Component', 'Score', 'Weight', 'Evidence'],
    scores.breakdown.map((row) => [
      row.display_name,
      scoreCell(row.score),
      String(row.weight),
      row.evidence_type,
    ]),
  );
}

function kindScoreEntries(report: AuditReport): [string, string, string][] {
  return REPORT_KINDS.map((kind) => {
    const k = report.kindScores[kind];

    return [kind, scoreCell(k.value), k.label ?? ''];
  });
}

function appendFindingTables(lines: string[], findings: readonly Finding[]): void {
  for (const group of groupFindings(findings)) {
    lines.push('');
    lines.push(theme.heading(group.heading));
    lines.push(formatTable(['Status', 'Title', 'Detail'], findingRows(group.findings)));
  }
}

const KIND_TITLE: Record<KindReport['command'], string> = {
  'geo-check': 'GEO Check',
  'seo-check': 'SEO Check',
};

function appendKindBody(lines: string[], body: KindReportBody): void {
  const overall = body.scores.overall;

  lines.push('');
  lines.push(theme.heading(KIND_TITLE[body.command]));
  lines.push(
    `${paintScore(overall, theme.score(String(overall)))} ${theme.dim('/ 100')}  ${paintScore(overall, body.scores.label)}`,
  );
  lines.push('');
  lines.push(theme.heading('Scores'));
  lines.push(scoreTable(body.scores));
  appendFindingTables(lines, body.findings);
}

function appendGoogleProfile(lines: string[], profile: GoogleProfileSummary): void {
  lines.push('');
  lines.push(theme.heading('Google Profile'));
  lines.push(formatTable(['Field', 'Value'], googleProfileFields(profile)));
}

function appendCrawlerList(
  lines: string[],
  crawlers: readonly { bot: string; status: string }[],
): void {
  lines.push('');
  lines.push(theme.heading('Crawlers'));
  lines.push('');

  for (const entry of crawlers) {
    lines.push(crawlerLine(entry.bot, entry.status));
  }
}

function htmlCrawlerSection(crawlers: readonly { bot: string; status: string }[]): string {
  const rows = crawlers
    .map(
      (entry) => `<tr><td>${escapeHtml(entry.bot)}</td><td>${escapeHtml(entry.status)}</td></tr>`,
    )
    .join('');

  return `<h2>Crawlers</h2>
  ${htmlTable(['Bot', 'Status'], rows)}`;
}

function markdownCrawlerSection(crawlers: readonly { bot: string; status: string }[]): string[] {
  return [
    '## Crawlers',
    '',
    '| Bot | Status |',
    '| --- | --- |',
    ...crawlers.map(
      (entry) => `| ${escapeMarkdown(entry.bot)} | ${escapeMarkdown(entry.status)} |`,
    ),
    '',
  ];
}

/** Renders the default stdout table: overall, then SEO, GEO, and Google Profile. */
function renderTable(report: AuditReport): string {
  const overall = report.scores.overall;
  const title = titleKpi(report);
  const seo = report.seo.scores.overall;
  const geo = report.geo.scores.overall;
  const header = formatReportHeader({
    title: 'Site Audit',
    url: report.url,
    score: overall,
    label: paintScore(overall, report.scores.label),
    extra: scoreExtra(report.scores, report.cruxApiKeyAvailable),
    kpis: [
      { status: title.status, label: 'Title', value: title.value },
      indexableKpi(report),
      { status: scoreStatus(seo), label: 'SEO', value: String(seo) },
      { status: scoreStatus(geo), label: 'GEO', value: String(geo) },
    ],
  });
  const lines: string[] = [header];

  lines.push(theme.heading('Scores'));
  lines.push(scoreTable(report.scores));
  lines.push('');
  lines.push(theme.heading('Kind scores'));
  lines.push(formatTable(['Kind', 'Score', 'Label'], kindScoreEntries(report)));
  appendKindBody(lines, report.seo);
  appendKindBody(lines, report.geo);
  appendCrawlerList(lines, report.discovery.crawlerAccess.crawlers);
  appendGoogleProfile(lines, report.googleProfile);

  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return stripControls(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const HTML_STYLE = `    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #111; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
    td:last-child { overflow-wrap: anywhere; }
    th { background: #f4f4f5; }
    .fail { color: #b91c1c; } .warn { color: #a16207; } .pass { color: #15803d; }`;

function htmlTable(headers: readonly string[], rows: string): string {
  const head = headers.map((header) => `<th>${header}</th>`).join('');

  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function htmlScoreTable(scores: AuditScores): string {
  const rows = scores.breakdown
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.display_name)}</td><td>${scoreCell(row.score)}</td><td>${row.weight}</td><td>${escapeHtml(row.evidence_type)}</td></tr>`,
    )
    .join('');

  return htmlTable(['Component', 'Score', 'Weight', 'Evidence'], rows);
}

function htmlFindingGroups(findings: readonly Finding[], heading: 'h2' | 'h3'): string {
  return groupFindings(findings)
    .map((group) => {
      const rows = group.findings
        .map(
          (finding) =>
            `<tr class="${escapeHtml(finding.severity)}"><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(humanizeLabel(finding.title))}</td><td>${escapeHtml(clipDetail(finding.detail))}</td></tr>`,
        )
        .join('');

      return `<${heading}>${escapeHtml(group.heading)}</${heading}>
  ${htmlTable(['Status', 'Title', 'Detail'], rows)}`;
    })
    .join('\n  ');
}

function htmlKindSection(body: KindReportBody): string {
  return `<h2>${escapeHtml(KIND_TITLE[body.command])}</h2>
  <p>${escapeHtml(body.kind.toUpperCase())} ${body.scores.overall} — ${escapeHtml(body.scores.label)}</p>
  <h3>Scores</h3>
  ${htmlScoreTable(body.scores)}
  ${htmlFindingGroups(body.findings, 'h3')}`;
}

function htmlGoogleProfile(profile: GoogleProfileSummary): string {
  const rows = googleProfileFields(profile)
    .map(([field, value]) => `<tr><td>${escapeHtml(field)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('');

  return `<h2>Google Profile</h2>
  ${htmlTable(['Field', 'Value'], rows)}`;
}

function htmlShell(title: string, url: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SearchUnit ${escapeHtml(title)} — ${escapeHtml(url)}</title>
  <style>
${HTML_STYLE}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Renders a self-contained HTML report. */
function renderHtml(report: AuditReport): string {
  const kindRows = kindScoreEntries(report)
    .map(
      ([kind, score, label]) =>
        `<tr><td>${escapeHtml(kind)}</td><td>${score}</td><td>${escapeHtml(label)}</td></tr>`,
    )
    .join('');

  return htmlShell(
    'audit',
    report.url,
    `  <h1>Site Audit</h1>
  <p>${escapeHtml(report.url)}</p>
  <p>Overall ${report.scores.overall} — ${escapeHtml(report.scores.label)} (confidence ${escapeHtml(report.scores.confidence)})</p>
  <p>${escapeHtml(cruxApiKeyLabel(report.cruxApiKeyAvailable))}</p>
  <h2>Scores</h2>
  ${htmlScoreTable(report.scores)}
  <h2>Kind scores</h2>
  ${htmlTable(['Kind', 'Score', 'Label'], kindRows)}
  ${htmlKindSection(report.seo)}
  ${htmlKindSection(report.geo)}
  ${htmlCrawlerSection(report.discovery.crawlerAccess.crawlers)}
  ${htmlGoogleProfile(report.googleProfile)}`,
  );
}

function markdownScoreTable(scores: AuditScores): string[] {
  return [
    '| Component | Score | Weight | Evidence |',
    '| --- | --- | --- | --- |',
    ...scores.breakdown.map(
      (row) =>
        `| ${row.display_name} | ${scoreCell(row.score)} | ${row.weight} | ${row.evidence_type} |`,
    ),
  ];
}

function markdownFindingGroups(findings: readonly Finding[], heading: string): string[] {
  return groupFindings(findings).flatMap((group) => [
    `${heading} ${escapeMarkdown(group.heading)}`,
    '',
    ...group.findings.map((f) => {
      const title = escapeMarkdown(humanizeLabel(f.title));
      const detail = escapeMarkdown(clipDetail(f.detail));

      return `- **${escapeMarkdown(f.severity)}** ${title} — ${detail}`;
    }),
    '',
  ]);
}

function markdownKindSection(body: KindReportBody): string[] {
  return [
    `## ${KIND_TITLE[body.command]}`,
    '',
    `**${body.kind.toUpperCase()} ${body.scores.overall}** — ${body.scores.label}`,
    '',
    '### Scores',
    '',
    ...markdownScoreTable(body.scores),
    '',
    ...markdownFindingGroups(body.findings, '###'),
  ];
}

function markdownGoogleProfile(profile: GoogleProfileSummary): string[] {
  return [
    '## Google Profile',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...googleProfileFields(profile).map(
      ([field, value]) => `| ${escapeMarkdown(field)} | ${escapeMarkdown(value)} |`,
    ),
    '',
  ];
}

/** Renders a Markdown report with overall scores, then SEO, GEO, and Google Profile. */
function renderMarkdown(report: AuditReport): string {
  return [
    `# Site Audit`,
    '',
    escapeMarkdown(report.url),
    '',
    `**Overall ${report.scores.overall}** — ${report.scores.label} (confidence ${report.scores.confidence}, evidence ${report.scores.evidence_quality})`,
    '',
    cruxApiKeyLabel(report.cruxApiKeyAvailable),
    '',
    '## Scores',
    '',
    ...markdownScoreTable(report.scores),
    '',
    '## Kind scores',
    '',
    '| Kind | Score | Label |',
    '| --- | --- | --- |',
    ...kindScoreEntries(report).map(
      ([kind, score, label]) => `| ${kind} | ${score} | ${escapeMarkdown(label)} |`,
    ),
    '',
    ...markdownKindSection(report.seo),
    ...markdownKindSection(report.geo),
    ...markdownCrawlerSection(report.discovery.crawlerAccess.crawlers),
    ...markdownGoogleProfile(report.googleProfile),
  ].join('\n');
}

/** Serializes the full audit payload for --format=json. */
function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Renders the audit in the requested format. */
export function renderAudit(report: AuditReport, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return renderJson(report);
    case 'html':
      return renderHtml(report);
    case 'markdown':
      return renderMarkdown(report);
    default:
      return renderTable(report);
  }
}

function renderKindTable(report: KindReport): string {
  const title = KIND_TITLE[report.command];
  const overall = report.scores.overall;
  const kpis: { status: FindingSeverity; label: string; value: string }[] = [
    { ...titleKpi(report), label: 'Title' },
  ];

  if (report.kind === 'seo') {
    kpis.push(indexableKpi(report));
  }

  const header = formatReportHeader({
    title,
    url: report.url,
    score: overall,
    label: paintScore(overall, report.scores.label),
    extra: scoreExtra(report.scores, report.cruxApiKeyAvailable),
    kpis,
  });
  const lines: string[] = [header];

  lines.push(theme.heading('Scores'));
  lines.push(scoreTable(report.scores));
  appendFindingTables(lines, report.findings);

  return lines.join('\n');
}

function renderKindHtml(report: KindReport): string {
  const title = KIND_TITLE[report.command];

  return htmlShell(
    title,
    report.url,
    `  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(report.url)}</p>
  <p>${escapeHtml(report.kind.toUpperCase())} ${report.scores.overall} — ${escapeHtml(report.scores.label)} (confidence ${escapeHtml(report.scores.confidence)})</p>
  <p>${escapeHtml(cruxApiKeyLabel(report.cruxApiKeyAvailable))}</p>
  <h2>Scores</h2>
  ${htmlScoreTable(report.scores)}
  ${htmlFindingGroups(report.findings, 'h2')}`,
  );
}

function renderKindMarkdown(report: KindReport): string {
  const title = KIND_TITLE[report.command];

  return [
    `# ${title}`,
    '',
    escapeMarkdown(report.url),
    '',
    `**${report.kind.toUpperCase()} ${report.scores.overall}** — ${report.scores.label} (confidence ${report.scores.confidence}, evidence ${report.scores.evidence_quality})`,
    '',
    cruxApiKeyLabel(report.cruxApiKeyAvailable),
    '',
    '## Scores',
    '',
    ...markdownScoreTable(report.scores),
    '',
    ...markdownFindingGroups(report.findings, '##'),
  ].join('\n');
}

/** Renders geo-check / seo-check in the requested format. */
export function renderKindReport(report: KindReport, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(report, null, 2)}\n`;
    case 'html':
      return renderKindHtml(report);
    case 'markdown':
      return renderKindMarkdown(report);
    default:
      return renderKindTable(report);
  }
}
