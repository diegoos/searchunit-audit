import { readFileSync } from 'node:fs';
import { CHECK_RESULTS, EVIDENCE, SEVERITIES } from './audit-vocabulary.mjs';

// Checks an audit-report.md against the CLI payload and, when given, the prose JSON.
// `--slugs` prints the workstream slugs. Without `--slugs`, exit 1 means the report failed.
const REFERENCES = new URL('../references/', import.meta.url);
const args = process.argv.slice(2);
const REQUIRED_HEADINGS = [
  'Sample Coverage',
  'What Is Wrong',
  'What To Improve',
  'Priority',
  'Plan',
  'Re-audit',
  'Checks',
  'Examples',
  'Search Console',
  'Evidence Limits',
];
const FIXED_SENTENCES = [
  'This report states no ranking, traffic, revenue, or citation outcome.',
  'URLs outside this sample were not read.',
];
const PLAN_LABELS = [
  'Source:',
  'Fix kind:',
  'Location:',
  'Current → target:',
  'Why:',
  'Fix:',
  'Example:',
  'Depends on:',
  'Verify:',
];
// The Plan template in user-report.md lists `- Decision:`, and every template field is required.
const DECISION_REQUIRED = /^- Decision:/m.test(readRef('user-report.md'));
const PLAN_FIELDS = DECISION_REQUIRED ? [...PLAN_LABELS, 'Decision:'] : PLAN_LABELS;
// Verify runs a CLI command: a backticked `searchunit`, `npx`, or `bun` command.
const VERIFY_COMMAND = /`(?:searchunit|npx|bun) [^`]+`/;
const EXAMPLE_KINDS = new Set(['markup', 'header', 'config', 'schema']);
const SEVERITY_PATTERN = [...SEVERITIES].join('|');
// These rows depend on the query. An assumed query (`assumption.` on the Query line) makes them insufficient.
const QUERY_SLUGS = ['intent', 'query-terms', 'query-answer'];
// user-report.md ## Order formula: in a phase, impact (high, medium, low), then effort (S, M, L).
const IMPACT_RANK = { high: 0, medium: 1, low: 2 };
const EFFORT_RANK = { S: 0, M: 1, L: 2 };

function argValue(name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];

  return value === undefined || value.startsWith('--') ? null : value;
}

function readRef(name) {
  return readFileSync(new URL(name, REFERENCES), 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Slugs are the lines "- `slug`: ..." in workstreams.md.
function workstreamSlugs() {
  const slugs = [...readRef('workstreams.md').matchAll(/^- `([a-z][a-z0-9-]*)`:/gm)];

  return [...new Set(slugs.map((match) => match[1]))];
}

// Evidence limit labels are the "- `Label:` owner ..." lines in workstreams.md.
function evidenceLimitLabels() {
  return [...readRef('workstreams.md').matchAll(/^- `([^`]+:)` owner /gm)].map((match) => match[1]);
}

// Splits lines into blocks at each heading that starts with `prefix`. Fenced code is skipped.
function splitBy(lines, prefix) {
  const blocks = [];
  let current = null;
  let fenced = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;

    if (!fenced && line.startsWith(prefix)) {
      current = { title: line.slice(prefix.length).trim(), lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  return blocks;
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

// Data rows of a markdown table. The header and the separator row are dropped.
function tableRows(lines) {
  return lines
    .filter((line) => line.trim().startsWith('|'))
    .map(splitRow)
    .filter((cells) => cells[0] !== 'Slug' && !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

function severityOf(text) {
  return text.match(new RegExp(`Severity:\\s*(${SEVERITY_PATTERN})\\b`))?.[1] ?? null;
}

function planEntry(block) {
  const id = block.title.match(/^(P\d+)\./)?.[1] ?? null;
  const text = block.lines.join('\n');
  const phase = text.match(/Phase:\s*([123])\b/)?.[1];

  return {
    id,
    title: block.title,
    text,
    severity: severityOf(text),
    phase: phase === undefined ? null : Number(phase),
    effort: text.match(/Effort:\s*([SML])\b/)?.[1] ?? null,
    impact: text.match(/Impact:\s*(high|medium|low)\b/)?.[1] ?? null,
    fixKind: text.match(/Fix kind:\s*([a-z]+)/)?.[1] ?? null,
    dependsOn: [...(text.match(/^- Depends on:(.*)$/m)?.[1] ?? '').matchAll(/P\d+\b/g)].map(
      (match) => match[0],
    ),
  };
}

function expectedPhase({ severity, effort, impact }) {
  if (severity === 'critical' || severity === 'high') return 1;
  if (impact === 'high' && effort === 'S') return 1;
  if (impact === 'high' || impact === 'medium') return 2;

  return 3;
}

function compareOrder(a, b) {
  return (
    IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort]
  );
}

function checkPlan(entries, problems) {
  let previousPhase = 0;
  let previous = null;
  const indexById = new Map(entries.map((entry, index) => [entry.id, index]));

  for (const [index, entry] of entries.entries()) {
    const label = entry.id ?? entry.title;
    const missing = ['severity', 'phase', 'effort', 'impact'].filter(
      (field) => entry[field] == null,
    );

    if (entry.id == null) problems.push(`Plan heading needs P<n>.: ${entry.title}`);
    if (missing.length > 0) {
      problems.push(
        `${label}: missing ${missing.join(', ')} in the Severity/Phase/Effort/Impact line`,
      );
      continue;
    }

    const expected = expectedPhase(entry);

    if (entry.phase !== expected) {
      problems.push(
        `${label}: Phase ${entry.phase}, but severity ${entry.severity}, impact ${entry.impact}, effort ${entry.effort} give Phase ${expected}`,
      );
    }
    if (entry.phase < previousPhase) {
      problems.push(
        `${label}: Phase ${entry.phase} follows Phase ${previousPhase}. Plan must be ordered by phase`,
      );
    }
    previousPhase = Math.max(previousPhase, entry.phase);

    // A dependency comes first. An entry that depends on the previous one may sort ahead of it.
    for (const dep of entry.dependsOn) {
      if (indexById.has(dep) && indexById.get(dep) > index) {
        problems.push(`${label}: depends on ${dep}, which comes later. A dependency comes first`);
      }
    }
    if (
      previous != null &&
      previous.phase === entry.phase &&
      compareOrder(entry, previous) < 0 &&
      !entry.dependsOn.includes(previous.id)
    ) {
      problems.push(
        `${label}: impact ${entry.impact}, effort ${entry.effort} follows ${previous.id} (impact ${previous.impact}, effort ${previous.effort}) in Phase ${entry.phase}. Order is impact, then effort`,
      );
    }
    previous = entry;
    checkPlanFields(entry, problems);
  }
}

function checkPlanFields(entry, problems) {
  const lines = entry.text.split('\n').map((line) => line.trim());

  for (const field of PLAN_FIELDS) {
    if (!lines.some((line) => line.startsWith(`- ${field}`))) {
      problems.push(`${entry.id}: missing field ${field}`);
    }
  }

  const verify = lines.find((line) => line.startsWith('- Verify:'));

  if (verify !== undefined && !VERIFY_COMMAND.test(verify)) {
    problems.push(
      `${entry.id}: Verify needs a backticked command starting with searchunit, npx, or bun`,
    );
  }
  if (EXAMPLE_KINDS.has(entry.fixKind) && !entry.text.includes('```')) {
    problems.push(`${entry.id}: fix kind ${entry.fixKind} needs a fenced example`);
  }
}

function checkSections(md, sections, problems) {
  for (const heading of REQUIRED_HEADINGS) {
    if (!sections.has(heading)) problems.push(`missing ## ${heading}`);
  }

  const scope = md.match(/^Scope:\s*([a-z]+)/m)?.[1];

  if (scope == null) problems.push('missing Scope: line');
  else if (scope !== 'page') problems.push(`Scope: line says ${scope}, not page`);

  for (const label of ['Query:', 'Indexation:', 'Cuts:']) {
    if (!new RegExp(`^${label}`, 'm').test(md)) problems.push(`missing ${label} line`);
  }

  const limitLines = (sections.get('Evidence Limits') ?? []).map((line) => line.trim());

  for (const label of evidenceLimitLabels()) {
    if (!limitLines.some((line) => line.startsWith(label))) {
      problems.push(`Evidence Limits: missing ${label} line`);
    }
  }
}

// Returns the Checks data rows, so later checks can count them.
function checkChecks(md, sections, problems) {
  const slugs = workstreamSlugs();
  const checkRows = tableRows(sections.get('Checks') ?? []);
  const rowSlugs = checkRows.map((cells) => cells[0].replace(/`/g, ''));

  for (const slug of slugs) {
    if (!rowSlugs.includes(slug)) problems.push(`Checks: no row for slug ${slug}`);
  }
  for (const slug of new Set(rowSlugs)) {
    if (!slugs.includes(slug)) problems.push(`Checks: unknown slug ${slug}`);
  }
  rowSlugs.forEach((slug, index) => {
    if (rowSlugs.indexOf(slug) !== index) problems.push(`Checks: repeats slug ${slug}`);
  });

  const assumedQuery = (md.match(/^Query:\s*(.*)$/m)?.[1] ?? '').trim().startsWith('assumption.');

  for (const [slugCell, result, evidence] of checkRows) {
    const slug = slugCell.replace(/`/g, '');

    if (!CHECK_RESULTS.has(result)) {
      problems.push(
        `Checks ${slug}: result "${result}" must be observed, not observed, or insufficient`,
      );
    }
    if (!EVIDENCE.has(evidence)) {
      problems.push(`Checks ${slug}: evidence "${evidence}" is not an evidence label`);
    }
    if (assumedQuery && QUERY_SLUGS.includes(slug) && evidence !== 'insufficient') {
      problems.push(
        `Checks ${slug}: assumed query needs evidence insufficient (workstreams.md intent)`,
      );
    }
  }

  return checkRows;
}

// Returns the item blocks of What Is Wrong and What To Improve.
function checkItems(sections, planIds, problems) {
  const itemSections = [];
  const itemTitles = new Set();

  for (const section of ['What Is Wrong', 'What To Improve']) {
    for (const block of splitBy(sections.get(section) ?? [], '### ')) {
      const text = block.lines.join('\n');
      const severity = severityOf(text);
      const evidence = text.match(/^-\s.*?\bEvidence:\s*([A-Za-z]+)/m)?.[1];
      const hasSentence = block.lines.some((line) => {
        const trimmed = line.trim();

        return trimmed !== '' && !trimmed.startsWith('- ');
      });
      const refs = [...text.matchAll(/Plan:\s*(P\d+)\b/g)].map((match) => match[1]);
      const name = `${section} "${block.title}"`;

      itemSections.push(section);
      itemTitles.add(block.title);
      if (block.title.endsWith('.')) problems.push(`${name}: title ends with a period`);
      if (severity == null) problems.push(`${name}: no severity`);
      if (evidence == null) {
        problems.push(`${name}: no evidence label`);
      } else if (!EVIDENCE.has(evidence)) {
        problems.push(`${name}: evidence "${evidence}" is not an evidence label`);
      }
      if (!hasSentence) problems.push(`${name}: no sentence`);
      if (refs.length !== 1) {
        problems.push(`${name}: needs exactly one Plan: P<n>, found ${refs.length}`);
      } else if (!planIds.has(refs[0])) {
        problems.push(`${name}: Plan ${refs[0]} has no entry`);
      }
    }
  }

  return { itemSections, itemTitles };
}

// Returns the Priority lines. Each item needs exactly one line, with a Plan id that exists.
function checkPriority(sections, planIds, itemTitles, problems) {
  const priorityLines = (sections.get('Priority') ?? []).filter((line) => /^\d+\.\s/.test(line));
  const priorityTitles = [];

  for (const line of priorityLines) {
    const ref = line.match(/Plan:\s*(P\d+)\b/)?.[1];
    const title = line
      .replace(/^\d+\.\s+/, '')
      .split(/\.\s+Severity:/)[0]
      .trim();

    priorityTitles.push(title);
    if (ref == null || !planIds.has(ref)) {
      problems.push(`Priority line names no Plan entry: ${line.slice(0, 60)}`);
    }
    if (!itemTitles.has(title)) {
      problems.push(`Priority "${title}" matches no What Is Wrong or What To Improve title`);
    }
    if (title.endsWith('.')) problems.push(`Priority "${title}": title ends with a period`);
  }

  // user-report.md ## Priority: one line per item, and each item title appears once.
  for (const title of new Set(priorityTitles)) {
    if (priorityTitles.filter((item) => item === title).length > 1) {
      problems.push(`Priority repeats "${title}"`);
    }
  }
  for (const title of itemTitles) {
    if (!priorityTitles.includes(title)) problems.push(`Priority has no line for "${title}"`);
  }

  return priorityLines;
}

function checkReaudit(sections, planIds, problems) {
  const reauditIds = (sections.get('Re-audit') ?? [])
    .map((line) => line.match(/^- (P\d+):/)?.[1])
    .filter(Boolean);

  for (const id of planIds) {
    if (!reauditIds.includes(id)) problems.push(`Re-audit: no checklist line for ${id}`);
  }
}

function checkFixedSentences(md, problems) {
  for (const sentence of FIXED_SENTENCES) {
    if (!md.includes(sentence)) problems.push(`missing fixed sentence: ${sentence}`);
  }
}

// Readiness line order is overview / geo / seo.
function checkReadiness(md, cli, problems) {
  const readiness = md.match(/^CLI readiness:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/m);

  if (readiness == null) {
    problems.push('missing CLI readiness line');
    return;
  }

  const [overview, geo, seo] = readiness.slice(1).map(Number);

  if (overview !== cli.scores?.overall) {
    problems.push(
      `CLI readiness overall ${overview} differs from scores.overall ${cli.scores?.overall}`,
    );
  }
  for (const [kind, value] of [
    ['geo', geo],
    ['seo', seo],
  ]) {
    const expected = cli.kindScores?.[kind]?.value;

    if (expected != null && value !== expected) {
      problems.push(
        `CLI readiness ${kind} ${value} differs from kindScores.${kind}.value ${expected}`,
      );
    }
  }
}

function checkLoopback(md, sections, cli, problems) {
  if (cli.url == null || !isLoopbackUrl(cli.url)) return;

  const target = md.match(/^Target:(.*)$/m)?.[1] ?? '';
  const planText = (sections.get('Plan') ?? []).join('\n');

  if (!target.includes('(dev server)')) {
    problems.push('Target line needs (dev server) for a loopback target');
  }
  if (
    cli.blockers?.some((blocker) => blocker.id === 'no_https') &&
    !/verify on production/i.test(planText)
  ) {
    problems.push('Plan needs "Verify on production" for blocker:no_https on a loopback target');
  }
}

// Each flagged CLI finding and each blocker must appear as a backticked id somewhere in the report.
function checkCited(md, cli, problems) {
  const flagged = (cli.findings ?? [])
    .filter((finding) => ['fail', 'warn'].includes(finding.severity ?? finding.status))
    .map((finding) => finding.id);
  const blockers = (cli.blockers ?? []).map((blocker) => `blocker:${blocker.id}`);

  for (const id of new Set([...flagged, ...blockers])) {
    if (!md.includes(`\`${id}\``)) problems.push(`CLI ${id} is not cited in backticks`);
  }
}

function checkCuts(md, cli, problems) {
  const cutLine = md.match(/^Cuts:(.*)$/m)?.[1] ?? '';

  for (const [token, expected] of Object.entries(cutValues(cli))) {
    const actual = cutLine.match(new RegExp(`\\b${token} ([a-z-]+(?: [a-z-]+)?)`))?.[1];

    if (actual !== expected) {
      problems.push(`Cuts ${token}: md ${actual ?? 'missing'}, payload ${expected}`);
    }
  }
}

function checkProse(prose, parts, problems) {
  const { itemSections, priorityLines, plan, checkRows } = parts;
  const count = (value) => (Array.isArray(value) ? value.length : null);
  const pairs = [
    [
      'What Is Wrong items',
      itemSections.filter((section) => section === 'What Is Wrong').length,
      count(prose.wrong),
    ],
    [
      'What To Improve items',
      itemSections.filter((section) => section === 'What To Improve').length,
      count(prose.improve),
    ],
    ['Priority lines', priorityLines.length, count(prose.priority)],
    ['Plan entries', plan.length, count(prose.actions)],
    ['Checks rows', checkRows.length, count(prose.checks)],
  ];

  for (const [label, mdCount, proseCount] of pairs) {
    if (mdCount !== proseCount) {
      problems.push(`${label}: md ${mdCount}, prose ${proseCount ?? 'missing'}`);
    }
  }

  for (const action of prose.actions ?? []) {
    const entry = plan.find((item) => item.id === String(action.id).toUpperCase());

    if (entry == null) {
      problems.push(`prose action ${action.id} has no Plan entry in md`);
    } else if (String(entry.phase) !== String(action.phase)) {
      problems.push(`prose action ${action.id}: phase ${action.phase}, md Phase ${entry.phase}`);
    } else if (entry.severity !== action.severity) {
      problems.push(`prose action ${action.id}: severity ${action.severity}, md ${entry.severity}`);
    }
  }
}

function validate(md, cli, prose) {
  const problems = [];
  const sections = new Map(
    splitBy(md.split('\n'), '## ').map((block) => [block.title, block.lines]),
  );

  checkSections(md, sections, problems);
  const checkRows = checkChecks(md, sections, problems);
  const plan = splitBy(sections.get('Plan') ?? [], '### ').map(planEntry);
  const planIds = new Set(plan.map((entry) => entry.id));

  checkPlan(plan, problems);
  const { itemSections, itemTitles } = checkItems(sections, planIds, problems);
  const priorityLines = checkPriority(sections, planIds, itemTitles, problems);
  checkReaudit(sections, planIds, problems);
  checkFixedSentences(md, problems);
  checkReadiness(md, cli, problems);
  checkLoopback(md, sections, cli, problems);
  checkCited(md, cli, problems);
  checkCuts(md, cli, problems);
  if (prose) checkProse(prose, { itemSections, priorityLines, plan, checkRows }, problems);

  return problems;
}

// Loopback targets: localhost, *.localhost, 127.0.0.0/8, and ::1.
function isLoopbackUrl(url) {
  let host;

  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

// Expected Cuts line values from the payload flags, as cli-facts.md "Payload cuts" describes.
function cutValues(cli) {
  const page = cli.discovery?.auditedPage ?? {};
  const { headings = {}, images = {} } = page;
  const flag = (cut) => (cut === true ? 'truncated' : 'complete');
  const headingCut = (count, list) => (count ?? 0) > (list?.length ?? 0);
  const values = {
    main: flag(page.mainTextTruncated),
    sitemap: flag(cli.discovery?.sitemap?.urlsTruncated),
    links: flag(page.internalLinksTruncated),
    outbound: flag(page.outboundLinksTruncated),
    headings: flag(
      headingCut(headings.h2NonEmpty, headings.h2) || headingCut(headings.h3NonEmpty, headings.h3),
    ),
    images: flag((images.total ?? 0) > (images.items?.length ?? 0)),
    citability: flag(page.citability?.blocksTruncated),
    llms: flag(cli.discovery?.llmsTxt?.linksTruncated),
  };

  if (cli.lighthouse != null) {
    const { status, reason } = cli.lighthouse;

    values.lighthouse = status === 'ok' ? 'ok' : `${status} ${reason ?? ''}`.trim();
  }

  return values;
}

if (args.includes('--slugs')) {
  process.stdout.write(`${workstreamSlugs().join('\n')}\n`);
} else {
  const mdPath = argValue('--md');
  const cliPath = argValue('--cli');
  const prosePath = argValue('--prose');

  if (mdPath == null || cliPath == null) {
    process.stderr.write(
      'Usage: check-audit-report.mjs --slugs | --md <audit-report.md> --cli <cli-audit.json> [--prose <audit-prose.json>]\n',
    );
    process.exitCode = 1;
  } else {
    let problems;

    try {
      const md = readFileSync(mdPath, 'utf8');
      const cli = readJson(cliPath);
      const prose = prosePath == null ? null : readJson(prosePath);

      problems = validate(md, cli, prose);
    } catch (error) {
      problems = [`cannot read input: ${error.message}`];
    }

    if (problems.length > 0) {
      process.stderr.write(`${problems.join('\n')}\n`);
      process.exitCode = 1;
    }
  }
}
