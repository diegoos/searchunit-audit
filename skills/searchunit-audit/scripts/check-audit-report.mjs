import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CHECK_RESULTS,
  EVIDENCE,
  EXAMPLE_KINDS,
  findingLevel,
  isLoopbackUrl,
  MECHANICAL_SLUGS,
  RECURRENCE_STATES,
  SEVERITIES,
} from './audit-vocabulary.mjs';

// Checks an audit-report.md against the CLI payload and, when given, the prose JSON.
// `--slugs` prints the workstream slugs, and `--judgment-slugs` the step 5 judgment slugs. Without `--slugs`, exit 1 means the report failed.
// Optional: --prefill (default: checks-prefill.json next to --cli), --previous (the earlier cli-audit.json).
const REFERENCES = new URL('../references/', import.meta.url);
const args = process.argv.slice(2);
const REQUIRED_HEADINGS = [
  'Sample Coverage',
  'Recurrence',
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
const SEVERITY_PATTERN = [...SEVERITIES].join('|');
// These rows depend on the query. An assumed query (`assumption.` on the Query line) makes them insufficient.
const QUERY_SLUGS = ['intent', 'query-terms', 'query-answer'];
// user-report.md ## Order formula: in a phase, impact (high, medium, low), then effort (S, M, L).
const IMPACT_RANK = { high: 0, medium: 1, low: 2 };
const EFFORT_RANK = { S: 0, M: 1, L: 2 };
// A missing tool needs one Evidence Limits line with its install state (SKILL.md step 2).
const INSTALL_TOOLS = [
  ['Lighthouse', (cli) => cli.lighthouse?.reason === 'binary-missing'],
  ['Chrome', (cli) => cli.discovery?.renderedPage?.reason === 'chrome-missing'],
];
const INSTALL_STATE = /^(not needed|declined|installed|install failed \S)/;
// A ## Recurrence line: "- `<id>`: <state>. Plan: <Plan id or none>."
const RECURRENCE_LINE = /^- `([^`]+)`: ([a-z]+)\. Plan: (P\d+|none)\./;

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

// Judgment slugs are the backticked slugs after the colon of each line under "## Judgment slugs"
// in verification.md.
function judgmentSlugs() {
  const section =
    readRef('verification.md')
      .split(/^## Judgment slugs$/m)[1]
      ?.split(/^## /m)[0] ?? '';
  const lines = section.split('\n').filter((line) => line.startsWith('- `'));

  return lines.flatMap((line) =>
    [...line.slice(line.indexOf(':') + 1).matchAll(/`([a-z][a-z0-9-]*)`/g)].map(
      (match) => match[1],
    ),
  );
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

  if (verify !== undefined) checkCommandLine(verify, `${entry.id}: Verify`, problems);
  if (EXAMPLE_KINDS.has(entry.fixKind) && !entry.text.includes('```')) {
    problems.push(`${entry.id}: fix kind ${entry.fixKind} needs a fenced example`);
  }

  checkExampleScripts(entry, problems);
}

const JSON_LD_SCRIPT = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script/gi;

// A value that holds `</script>` closes the example's script element early when a reader pastes it.
// A JSON-LD body needs no `<` at all: a value writes it as `\u003c`.
function checkExampleScripts(entry, problems) {
  for (const [block] of entry.text.matchAll(/```[\s\S]*?```/g)) {
    const opened = block.match(/<script\b/gi)?.length ?? 0;
    const closed = block.match(/<\/script/gi)?.length ?? 0;

    if (opened !== closed) {
      problems.push(
        `${entry.id}: example has ${opened} <script> and ${closed} </script>. Escape < in values as \\u003c`,
      );
    }
    for (const [, body] of block.matchAll(JSON_LD_SCRIPT)) {
      if (body.includes('<')) {
        problems.push(`${entry.id}: example JSON-LD holds <. Escape < in values as \\u003c`);
      }
    }
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
  const itemCounts = { 'What Is Wrong': 0, 'What To Improve': 0 };
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

      itemCounts[section] += 1;
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

  return { itemCounts, itemTitles };
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

// A reader runs these commands, so each one is a SearchUnit read command: the binary, one read-only
// command, double-quoted http(s) URLs with no shell expansion, and read flags whose values the CLI
// accepts. `-o` / `--output` writes a file and is not a read flag. Text from the audited site
// cannot become a command or a file write.
const READ_COMMAND =
  /^(?:searchunit|npx --yes @searchunit\/cli|bun (?![\w.~/-]*\.\.)[\w.~/-]*searchunit[\w.~/-]*\/src\/index\.ts) (audit|seo-check|geo-check|meta-check|schema-check|robots-check|llms-txt-check|security-headers|gsc(?: (?:check|inspect|queries|pages|query-pages|page-queries|sampled-pages|search-appearance|discover|google-news|sitemaps))?)((?: "https?:\/\/[^"\s`$\\!']+")*)((?: \S+)*)$/;
const KIND_COMMANDS = new Set(['audit', 'seo-check', 'geo-check']);
const BARE_FLAGS = new Set(['--agent', '--silent', '--json', '--no-color']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORMAT = /^(?:json|table|html|markdown)$/;
// Flags that take a value, the values src/lib/args.ts accepts, and the commands that accept them.
const VALUE_FLAGS = {
  '--fail-on': { value: /^(?:fail|warn)$/, gsc: false },
  '--format': { value: FORMAT },
  '-f': { value: FORMAT },
  '--max-bytes': { value: /^\d+(?:kb|mb)?$/i },
  '--init-date': { value: DATE, gsc: true },
  '--end-date': { value: DATE, gsc: true },
};
// A backticked span that runs something: a known program first, or a shell operator.
const COMMAND_LIKE =
  /^(?:[\w.~/-]+\/)?(?:searchunit|npx|bunx?|node|npm|pnpm|yarn|curl|wget|sh|bash|zsh|python3?|rm|sudo|chmod|git|eval|source|reboot|halt|shutdown|poweroff|dd|mkfs|fdisk|passwd|chown|killall|kill)(?:\s|$)|\$\(|&&|\|\||\|\s*(?:ba|z)?sh\b/i;

function isReadCommand(command) {
  const match = command.match(READ_COMMAND);

  if (match == null) return false;

  const [, name, urls, flags] = match;
  const urlCount = (urls.match(/ "/g) ?? []).length;

  // `gsc check` takes no URL, other gsc reads take at least one, the rest take exactly one.
  const urlCountOk =
    name === 'gsc check' ? urlCount === 0 : name.startsWith('gsc') ? urlCount > 0 : urlCount === 1;
  if (!urlCountOk) return false;

  return readFlagsAccepted(flags.split(' ').filter(Boolean), name);
}

function readFlagsAccepted(tokens, command) {
  const gsc = command.startsWith('gsc');

  for (let index = 0; index < tokens.length; index++) {
    if (BARE_FLAGS.has(tokens[index])) continue;

    const [flag, inline] = tokens[index].split(/=(.*)/s);
    const rule = VALUE_FLAGS[flag];
    const value = inline ?? tokens[++index];

    if (rule == null || (rule.gsc !== undefined && rule.gsc !== gsc)) return false;
    if (value == null || !rule.value.test(value)) return false;
    if (/^(?:html|markdown)$/.test(value) && !KIND_COMMANDS.has(command)) return false;
  }

  return true;
}

function commandSpans(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

// Shell quoting, escaping, grouping, expansion, or metachar
// (`x>file`, `a;reboot`, `'reboot'`, `(reboot)`, `{a,b}`, `*`, `!!`).
const SHELL_SPAN_CHAR = /[\s;&|<>$(){}\[\]*?!'"\\~%^=]/;
// A finding id, result token, or payload field path (`meta:description`, `internalLinks[].href`).
const INERT_SPAN = /^[A-Za-z][\w.:-]*(?:\[\d*\][\w.:-]*)*$/;

// A span that runs something: a known program or shell operator, or any shell char
// outside an inert field path.
function looksRunnable(span) {
  return COMMAND_LIKE.test(span) || (!INERT_SPAN.test(span) && SHELL_SPAN_CHAR.test(span));
}

// Any span after the command that still looks runnable is a smuggled command.
function checkExtraSpans(spans, label, problems) {
  for (const span of spans) {
    if (looksRunnable(span) && !isReadCommand(span)) {
      problems.push(`${label}: command is not a SearchUnit read command: ${span}`);
    }
  }
}

// The first backticked span is the command. Any other runnable span is a command too.
function checkCommandLine(line, label, problems) {
  const [first, ...rest] = commandSpans(line);

  if (first == null || !isReadCommand(first)) {
    problems.push(`${label} needs one backticked SearchUnit read command first`);
  }
  checkExtraSpans(rest, label, problems);
}

function checkReaudit(sections, planIds, problems) {
  const lines = sections.get('Re-audit') ?? [];
  const reauditIds = lines.map((line) => line.match(/^- (P\d+):/)?.[1]).filter(Boolean);

  for (const id of planIds) {
    if (!reauditIds.includes(id)) problems.push(`Re-audit: no checklist line for ${id}`);
  }

  for (const line of lines.filter((text) => text.includes('`'))) {
    const [first, ...rest] = commandSpans(line);

    if (first == null) {
      problems.push('Re-audit needs one backticked SearchUnit read command first');
    } else if (!isReadCommand(first)) {
      problems.push(`Re-audit: command is not a SearchUnit read command: ${first}`);
    }
    checkExtraSpans(rest, 'Re-audit', problems);
  }
}

// Site text can hold markup. Outside code, a tag, an HTML comment, an image, or a link to a scheme
// other than https would render live in a markdown viewer.
const RAW_HTML = /<\/?[a-z][\w-]*(?=[\s/>])[^<>]*>|<!--/i;
const AUTOLINK = /<(?!https:\/\/)[a-z][a-z0-9+.-]{1,31}:[^<>\s]*>/i;
const MD_IMAGE = /!\[[^\]]*\]\([^)]*\)/;
const MD_LINK_TARGET = /\]\(\s*<?([^)\s>]*)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm;

// Markdown without fenced blocks and code spans. A span opens on a whole backtick run and closes
// on a run of the same length, as in CommonMark.
function withoutCode(text) {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm, '')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, '');
}

function checkRawHtml(md, problems) {
  const prose = withoutCode(md);
  const markup =
    prose.match(RAW_HTML)?.[0] ?? prose.match(AUTOLINK)?.[0] ?? prose.match(MD_IMAGE)?.[0];

  if (markup) problems.push(`raw HTML outside code: ${markup}. Put markup in backticks`);

  for (const [, inline, reference] of prose.matchAll(MD_LINK_TARGET)) {
    const target = inline ?? reference;

    if (!/^(?:https:\/\/|#)/i.test(target)) {
      problems.push(`link target outside code is not https or #: ${target}`);
    }
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

// The CLI never fires blocker:no_https on a loopback target, so only the Target line is checked.
function checkLoopback(md, cli, problems) {
  if (!isLoopbackUrl(cli.url)) return;

  const target = md.match(/^Target:(.*)$/m)?.[1] ?? '';

  if (!target.includes('(dev server)')) {
    problems.push('Target line needs (dev server) for a loopback target');
  }
}

// Each flagged CLI finding and each blocker must appear as a backticked id somewhere in the report.
function checkCited(md, cli, problems) {
  const flagged = (cli.findings ?? [])
    .filter((finding) => ['fail', 'warn'].includes(findingLevel(finding)))
    .map((finding) => finding.id);
  const blockers = (cli.blockers ?? []).map((blocker) => `blocker:${blocker.id}`);

  for (const id of new Set([...flagged, ...blockers])) {
    if (!md.includes(`\`${id}\``)) problems.push(`CLI ${id} is not cited in backticks`);
  }
}

// Double quotes in item text, straight or curly, are passages from the page. An ellipsis splits a
// passage into fragments.
const QUOTE = /["\u{201C}]([^"\u{201C}\u{201D}\n]+)["\u{201D}]/gu;
const ELLIPSIS = /…|\.\.\./;
const DIFFERS_NOTE = /^Differs from prefill:\s*\S+(?:\s+\S+){2}/;
const SEVERITY_RANK = { fail: 2, warn: 1 };

// The same set as INVISIBLE_FORMAT in the CLI (src/lib/invisibleText.ts).
const INVISIBLE_FORMAT =
  /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2028\u2029\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;
// A quote with fewer than three letters or digits matches almost any payload, so it proves nothing.
const MIN_QUOTE_LETTERS = 3;

function normalizeText(text) {
  return text
    .replace(INVISIBLE_FORMAT, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stringsIn(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value != null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);

  return [];
}

// Other cli-*.json files of the run directory, such as cli-seo-<n>.json.
function siblingPayloads(cliPath) {
  const dir = dirname(cliPath);

  return readdirSync(dir)
    .filter((name) => /^cli-.*\.json$/.test(name) && resolve(dir, name) !== resolve(cliPath))
    .map((name) => readJson(join(dir, name)));
}

// An explicit path must exist. Otherwise the file next to the CLI JSON is read when it exists.
function readOptional(explicit, fallback) {
  if (explicit != null) return readJson(explicit);

  return existsSync(fallback) ? readJson(fallback) : null;
}

// Quotes in one item block. Code spans and fenced code are not quotes. A quote may wrap a line.
function itemQuotes(lines) {
  const text = withoutCode(lines.join('\n')).replace(/\n(?!\n)/g, ' ');

  return [...text.matchAll(QUOTE)].map((match) => normalizeText(match[1]));
}

// Page text the CLI read: every string under `discovery` of each payload. Scores and finding
// details are CLI text, so a quote of them is not evidence from the page.
function quotePool(payloads) {
  return payloads.flatMap((payload) => stringsIn(payload.discovery).map(normalizeText));
}

// Problems for one quote: no text, too short, or a fragment the page text does not hold.
function quoteProblems(quote, pool, where) {
  const fragments = quote
    .split(ELLIPSIS)
    .map((part) => part.trim())
    .filter(Boolean);

  if (fragments.length === 0) return [`${where}: quote has no text`];

  return fragments.flatMap((fragment) => {
    if ((fragment.match(/[\p{L}\p{N}]/gu) ?? []).length < MIN_QUOTE_LETTERS) {
      return [`${where}: quote has fewer than ${MIN_QUOTE_LETTERS} letters: "${fragment}"`];
    }

    return pool.some((text) => text.includes(fragment))
      ? []
      : [`${where}: quote not found in the CLI payload: "${fragment}"`];
  });
}

// Every quote in What Is Wrong and What To Improve must appear in the page text of a payload.
function checkQuotes(sections, pool, problems) {
  for (const section of ['What Is Wrong', 'What To Improve']) {
    for (const block of splitBy(sections.get(section) ?? [], '### ')) {
      for (const quote of itemQuotes(block.lines)) {
        problems.push(...quoteProblems(quote, pool, `${section} "${block.title}"`));
      }
    }
  }
}

// The HTML page shows prose quotes and item text, so they follow the same quote rule as the markdown.
function checkProseQuotes(prose, pool, problems) {
  for (const key of ['wrong', 'improve']) {
    for (const item of Array.isArray(prose[key]) ? prose[key] : []) {
      const where = `prose ${key} "${item?.title ?? ''}"`;
      const quoted =
        typeof item?.quote === 'string'
          ? [item.quote.replace(/^["\u{201C}]|["\u{201D}]$/gu, '')]
          : [];
      const inText =
        typeof item?.text === 'string' ? [...item.text.matchAll(QUOTE)].map((m) => m[1]) : [];

      for (const quote of [...quoted, ...inText]) {
        problems.push(...quoteProblems(normalizeText(quote), pool, where));
      }
    }
  }
}

// A mechanical row that differs from checks-prefill.json needs a note with the reason.
function checkPrefill(prefill, checkRows, problems) {
  if (prefill == null) return;

  for (const entry of prefill) {
    if (!MECHANICAL_SLUGS.includes(entry.slug)) continue;

    const row = checkRows.find(([slugCell]) => slugCell.replace(/`/g, '') === entry.slug);

    if (row == null) continue;

    const [, result, evidence, note = ''] = row;

    if (result === entry.result && evidence === entry.evidence) continue;
    if (!DIFFERS_NOTE.test(note)) {
      problems.push(
        `Checks ${entry.slug}: differs from checks-prefill.json (${entry.result}, ${entry.evidence}) and its note has no reason. Start the note with "Differs from prefill:" and the reason`,
      );
    }
  }
}

// Severity rank of each finding id: fail 2, warn 1, anything else 0.
function findingRanks(payload) {
  return new Map(
    (payload.findings ?? []).map((finding) => [
      finding.id,
      SEVERITY_RANK[findingLevel(finding)] ?? 0,
    ]),
  );
}

// The recurrence state of one finding, from its rank in the previous run and in this run.
function recurrenceState(previous, current) {
  if (current === 0) return previous === 0 ? null : 'resolved';
  if (previous === 0) return 'new';
  if (current === previous) return 'recurring';

  return current > previous ? 'worsened' : 'improved';
}

// With --previous, each finding whose state changed is listed in ## Recurrence with the state the runs imply.
function checkRecurrence(sections, cli, previous, problems) {
  const lines = sections.get('Recurrence');

  if (lines == null || previous == null) return;

  const current = findingRanks(cli);
  const earlier = findingRanks(previous);

  for (const id of new Set([...current.keys(), ...earlier.keys()])) {
    const state = recurrenceState(earlier.get(id) ?? 0, current.get(id) ?? 0);

    if (state == null) continue;

    const line = lines.find((text) => text.includes(`\`${id}\``));

    if (line == null) {
      problems.push(`Recurrence: no line for \`${id}\` (${state})`);
      continue;
    }

    const found = [...RECURRENCE_STATES].find((word) => new RegExp(`\\b${word}\\b`).test(line));

    if (found !== state) {
      problems.push(`Recurrence \`${id}\`: state ${state} expected, found ${found ?? 'none'}`);
    }
  }
}

function checkCuts(md, cli, problems) {
  const cutLine = md.match(/^Cuts:(.*)$/m)?.[1] ?? '';

  for (const [token, expected] of Object.entries(cutValues(cli))) {
    const actual = cutLine.match(new RegExp(`\\b${token} ([a-z_-]+(?: [a-z_-]+)?)`))?.[1];

    if (actual !== expected) {
      problems.push(`Cuts ${token}: md ${actual ?? 'missing'}, payload ${expected}`);
    }
  }
}

// A missing tool needs an Evidence Limits line whose value is one of the install states.
function checkInstallLines(sections, cli, problems) {
  const limitLines = (sections.get('Evidence Limits') ?? []).map((line) => line.trim());

  for (const [label, missing] of INSTALL_TOOLS) {
    if (!missing(cli)) continue;

    const line = limitLines.find((text) => text.startsWith(`${label}:`));

    if (line == null) {
      problems.push(`Evidence Limits: missing ${label} install line, ${label} is not on this run`);
    } else if (!INSTALL_STATE.test(line.slice(label.length + 1).trim())) {
      problems.push(
        `Evidence Limits ${label}: state must be not needed, declined, installed, or install failed <reason>`,
      );
    }
  }
}

// Step 5 verdict counts: "Verification: <n> confirmed, <n> corrected, <n> insufficient."
const VERIFICATION_LINE = /^Verification: (\d+) confirmed, (\d+) corrected, (\d+) insufficient\./;

// The Verification line exists and its counts cover every judgment slug. Returns the line.
function checkVerification(sections, problems) {
  const line = (sections.get('Evidence Limits') ?? [])
    .map((text) => text.trim())
    .find((text) => text.startsWith('Verification:'));
  const counts = line?.match(VERIFICATION_LINE);

  if (counts == null) {
    problems.push(
      'Evidence Limits: missing Verification: line ("Verification: <n> confirmed, <n> corrected, <n> insufficient.")',
    );

    return null;
  }

  const total = counts.slice(1, 4).reduce((sum, count) => sum + Number(count), 0);
  const expected = judgmentSlugs().length;

  if (total !== expected) {
    problems.push(`Verification: counts add up to ${total}, there are ${expected} judgment slugs`);
  }

  return line;
}

// The Recurrence lines and prose.recurrence name the same findings, states, and Plan ids.
function checkRecurrenceProse(prose, sections, problems) {
  const expected = new Map();
  const actual = new Map();

  for (const line of sections.get('Recurrence') ?? []) {
    const match = line.trim().match(RECURRENCE_LINE);

    if (match) expected.set(match[1], { state: match[2], plan: match[3].toLowerCase() });
  }
  for (const item of Array.isArray(prose.recurrence) ? prose.recurrence : []) {
    actual.set(item?.id, { state: item?.state, plan: item?.plan });
  }
  for (const [id, want] of expected) {
    const got = actual.get(id);

    if (got == null) {
      problems.push(`Recurrence \`${id}\`: prose has no entry`);
    } else if (got.state !== want.state || got.plan !== want.plan) {
      problems.push(
        `Recurrence \`${id}\`: prose ${got.state} ${got.plan}, md ${want.state} ${want.plan}`,
      );
    }
  }
  for (const id of actual.keys()) {
    if (!expected.has(id)) problems.push(`Recurrence \`${id}\`: prose entry has no md line`);
  }
}

function checkProse(prose, parts, problems) {
  const { itemCounts, priorityLines, plan, checkRows, installLabels, verificationLine } = parts;
  const count = (value) => (Array.isArray(value) ? value.length : null);
  const pairs = [
    ['What Is Wrong items', itemCounts['What Is Wrong'], count(prose.wrong)],
    ['What To Improve items', itemCounts['What To Improve'], count(prose.improve)],
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

  const limits = Array.isArray(prose.limits) ? prose.limits : [];

  for (const label of installLabels) {
    if (!limits.some((text) => String(text).startsWith(`${label}:`))) {
      problems.push(`limits: no ${label} install line. Copy it from Evidence Limits`);
    }
  }
  if (verificationLine != null && !limits.includes(verificationLine)) {
    problems.push('limits: no Verification line. Copy it from Evidence Limits');
  }
}

function validate(md, cli, prose, { payloads = [cli], prefill = null, previous = null } = {}) {
  const problems = [];
  const sections = new Map(
    splitBy(md.split('\n'), '## ').map((block) => [block.title, block.lines]),
  );

  checkSections(md, sections, problems);
  const checkRows = checkChecks(md, sections, problems);
  const plan = splitBy(sections.get('Plan') ?? [], '### ').map(planEntry);
  const planIds = new Set(plan.map((entry) => entry.id));

  checkPlan(plan, problems);
  const { itemCounts, itemTitles } = checkItems(sections, planIds, problems);
  const priorityLines = checkPriority(sections, planIds, itemTitles, problems);
  checkReaudit(sections, planIds, problems);
  checkFixedSentences(md, problems);
  checkRawHtml(md, problems);
  checkReadiness(md, cli, problems);
  checkLoopback(md, cli, problems);
  checkCited(md, cli, problems);
  checkCuts(md, cli, problems);
  checkInstallLines(sections, cli, problems);
  const verificationLine = checkVerification(sections, problems);
  const pool = quotePool(payloads);

  checkQuotes(sections, pool, problems);
  checkRecurrence(sections, cli, previous, problems);
  checkPrefill(prefill, checkRows, problems);
  if (prose) {
    const installLabels = INSTALL_TOOLS.filter(([, missing]) => missing(cli)).map(
      ([label]) => label,
    );

    checkProse(
      prose,
      { itemCounts, priorityLines, plan, checkRows, installLabels, verificationLine },
      problems,
    );
    checkRecurrenceProse(prose, sections, problems);
    checkProseQuotes(prose, pool, problems);
  }

  return problems;
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

  if (cli.lighthouse != null) values.lighthouse = stateOf(cli.lighthouse);
  if (cli.discovery?.renderedPage != null) values.render = stateOf(cli.discovery.renderedPage);

  return values;
}

// "ok", or the status and the reason of a Lighthouse or render run that did not finish.
function stateOf({ status, reason }) {
  return status === 'ok' ? 'ok' : `${status} ${reason ?? ''}`.trim();
}

if (args.includes('--slugs')) {
  process.stdout.write(`${workstreamSlugs().join('\n')}\n`);
} else if (args.includes('--judgment-slugs')) {
  process.stdout.write(`${judgmentSlugs().join('\n')}\n`);
} else {
  const mdPath = argValue('--md');
  const cliPath = argValue('--cli');
  const prosePath = argValue('--prose');
  const prefillPath = argValue('--prefill');
  const previousPath = argValue('--previous');

  if (mdPath == null || cliPath == null) {
    process.stderr.write(
      'Usage: check-audit-report.mjs --slugs | --judgment-slugs | --md <audit-report.md> --cli <cli-audit.json> [--prose <audit-prose.json>] [--prefill <checks-prefill.json>] [--previous <previous cli-audit.json>]\n',
    );
    process.exitCode = 1;
  } else {
    let problems;

    try {
      const md = readFileSync(mdPath, 'utf8');
      const cli = readJson(cliPath);
      const prose = prosePath == null ? null : readJson(prosePath);
      const payloads = [cli, ...siblingPayloads(cliPath)];
      const prefill = readOptional(prefillPath, join(dirname(cliPath), 'checks-prefill.json'));
      const previous = previousPath == null ? null : readJson(previousPath);

      problems = validate(md, cli, prose, { payloads, prefill, previous });
    } catch (error) {
      problems = [`cannot read input: ${error.message}`];
    }

    if (problems.length > 0) {
      // Problems quote report text, so control characters are dropped before they reach the terminal.
      const safe = problems
        .join('\n')
        .replace(/[\u{0}-\u{9}\u{B}-\u{1F}\u{7F}-\u{9F}]/gu, '')
        .replace(INVISIBLE_FORMAT, '');

      process.stderr.write(`${safe}\n`);
      process.exitCode = 1;
    }
  }
}
