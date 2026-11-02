import { readFileSync, writeFileSync } from 'node:fs';
import {
  CHECK_RESULTS,
  EVIDENCE,
  EXAMPLE_KINDS,
  RECURRENCE_STATES,
  SEVERITIES,
} from './audit-vocabulary.mjs';

const args = process.argv.slice(2);
const marker = '<script type="application/json" id="audit-data"></script>';

// Prose may only carry report text. Scores, blockers, and findings stay on the CLI JSON.
const PROSE_KEYS = new Set([
  'lang',
  'context',
  'wrong',
  'improve',
  'priority',
  'checks',
  'sample',
  'sampleSentence',
  'examples',
  'gsc',
  'limits',
  'cuts',
  'multimodal',
  'actions',
  'validation',
  'measurement',
  'reputation',
  'recurrence',
]);
const REQUIRED_ARRAYS = [
  'context',
  'wrong',
  'improve',
  'priority',
  'checks',
  'sample',
  'examples',
  'limits',
  'actions',
  'validation',
];
const REQUIRED_STRINGS = ['sampleSentence', 'cuts'];
const EFFORTS = new Set(['S', 'M', 'L']);
const IMPACTS = new Set(['high', 'medium', 'low']);
const OWNERS = new Set(['dev', 'content', 'SEO']);
const FIX_KINDS = new Set(['markup', 'header', 'config', 'schema', 'content', 'gsc', 'judgment']);
const ACTION_FIELDS = [
  'id',
  'title',
  'severity',
  'phase',
  'effort',
  'impact',
  'owner',
  'source',
  'location',
  'current',
  'target',
  'why',
  'fix',
  'fixKind',
  'verify',
];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const PLAN_OR_NONE = /^(p\d+|none)$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function arg(name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];

  if (value === undefined || value.startsWith('--')) fail(`Missing ${name}`);

  return value;
}

const templatePath = arg('--template');
const prosePath = arg('--prose');
const outPath = arg('--out');
const cliPath = arg('--cli');
const html = readFileSync(templatePath, 'utf8');

if (!html.includes(marker)) fail('Template has no audit-data slot');

const prose = JSON.parse(readFileSync(prosePath, 'utf8'));
checkProseKeys(prose);
const cli = readCli(cliPath);
const lang = pageLang(prose);
const proseBody = withoutLang(stripContextLabels(prose));
const payload = { kind: 'searchunit-audit-fill', cli, prose: proseBody };
const json = JSON.stringify(payload).replaceAll('<', '\\u003c');
// A replacer function keeps `$&`, `$'`, and `$$` in the JSON as literal text.
const filled = withLang(html, lang).replace(
  marker,
  () => `<script type="application/json" id="audit-data">${json}</script>`,
);

writeFileSync(outPath, filled);

// The CLI JSON is the file that `searchunit audit -o` writes. Both fields must exist.
function readCli(path) {
  const cli = JSON.parse(readFileSync(path, 'utf8'));

  if (cli?.command == null || cli?.scores == null) {
    fail('CLI JSON needs command and scores. Pass the file that searchunit audit -o writes.');
  }
  return cli;
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function expectOneOf(label, field, value, allowed) {
  if (!allowed.has(value))
    fail(`Prose ${label}.${field} must be one of: ${[...allowed].join(', ')}`);
}

function checkProseKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Prose must be a JSON object');
  }

  const unknown = Object.keys(value).filter((key) => !PROSE_KEYS.has(key));
  if (unknown.length > 0) fail(`Prose has keys the fill does not accept: ${unknown.join(', ')}`);

  const missingArrays = REQUIRED_ARRAYS.filter((key) => !Array.isArray(value[key]));
  if (missingArrays.length > 0) fail(`Prose needs arrays: ${missingArrays.join(', ')}`);

  const missingStrings = REQUIRED_STRINGS.filter((key) => typeof value[key] !== 'string');
  if (missingStrings.length > 0) fail(`Prose needs strings: ${missingStrings.join(', ')}`);

  if (!value.gsc || typeof value.gsc !== 'object') fail('Prose needs a gsc object');

  requireFields(value, 'wrong', ['title', 'text', 'evidence']);
  requireFields(value, 'improve', ['title', 'text', 'evidence']);
  requireFields(value, 'priority', ['title', 'text']);
  requireFields(value, 'checks', ['slug', 'result', 'evidence']);
  requireFields(value, 'sample', ['url', 'role']);
  requireFields(value, 'validation', ['command', 'check']);
  checkCheckNotes(value.checks);
  checkEvidenceLabels(value);
  const actionIds = checkActions(value.actions);
  checkIssueExtras(value, 'wrong', actionIds);
  checkIssueExtras(value, 'improve', actionIds);
  checkIssueExtras(value, 'priority', actionIds);
  checkPriorityLinks(value, actionIds);
  checkRecurrence(value.recurrence ?? [], actionIds);
}

// Optional list from ## Recurrence. An empty list hides the Recurrence block on the page.
function checkRecurrence(items, actionIds) {
  if (!Array.isArray(items)) fail('Prose recurrence must be an array');

  items.forEach((item, index) => {
    const label = `recurrence[${index}]`;

    if (!item || typeof item !== 'object') fail(`Prose ${label} must be an object`);
    if (!isText(item.id)) fail(`Prose ${label} needs a non-empty id`);
    expectOneOf(label, 'state', item.state, RECURRENCE_STATES);
    if (typeof item.plan !== 'string' || !PLAN_OR_NONE.test(item.plan)) {
      fail(`Prose ${label}.plan must be a lowercase Plan id (pN) or none`);
    }
    if (item.plan !== 'none' && !actionIds.has(item.plan)) {
      fail(`Prose ${label}.plan names no action id: ${item.plan}`);
    }
  });
}

// Optional note on a check row. It shows as the Note column of the Checks table.
function checkCheckNotes(checks) {
  checks.forEach((item, index) => {
    if (item.note != null && !isText(item.note)) {
      fail(`Prose checks[${index}].note must be a non-empty string`);
    }
  });
}

// A check result and every evidence label must be one of the allowed values.
function checkEvidenceLabels(value) {
  value.checks.forEach((item, index) => {
    expectOneOf(`checks[${index}]`, 'result', item.result, CHECK_RESULTS);
    expectOneOf(`checks[${index}]`, 'evidence', item.evidence, EVIDENCE);
  });
  for (const key of ['wrong', 'improve']) {
    value[key].forEach((item, index) => {
      expectOneOf(`${key}[${index}]`, 'evidence', item.evidence, EVIDENCE);
    });
  }
}

function requireFields(value, key, fields) {
  value[key].forEach((item, index) => {
    const empty = fields.filter((field) => !isText(item?.[field]));
    if (empty.length > 0) fail(`Prose ${key}[${index}] needs non-empty: ${empty.join(', ')}`);
  });
}

// Optional severity, ids, affected, and plan on an issue or priority item.
// plan names the Plan action that fixes a wrong or improve item, for example p1.
// A priority item names its action with `action` instead.
function checkIssueExtras(value, key, actionIds) {
  value[key].forEach((item, index) => {
    const label = `${key}[${index}]`;
    if (item.severity != null) expectOneOf(label, 'severity', item.severity, SEVERITIES);
    if (item.affected != null && !isText(item.affected)) {
      fail(`Prose ${label}.affected must be a non-empty string`);
    }
    if (item.ids != null && !isTextList(item.ids)) {
      fail(`Prose ${label}.ids must be an array of non-empty strings`);
    }
    if (item.plan != null && key === 'priority') {
      fail(`Prose ${label}.plan is not accepted on priority. Use action.`);
    }
    if (item.plan != null && !actionIds.has(item.plan)) {
      fail(`Prose ${label}.plan names no action id: ${item.plan}`);
    }
  });
}

// The context value is the line without its label. A leading `<label>:` that repeats
// the row label (ignoring case) is removed, so the label does not show twice.
function stripContextLabels(value) {
  const context = value.context.map((item) => {
    if (!isText(item?.label) || typeof item.value !== 'string') return item;

    const prefix = `${item.label.trim()}:`;
    const text = item.value.trim();
    if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return item;

    const rest = text.slice(prefix.length).trim();
    return rest === '' ? item : { ...item, value: rest };
  });

  return { ...value, context };
}

function isTextList(value) {
  return Array.isArray(value) && value.every(isText);
}

// Returns the action ids. An empty array means the report has no Plan entries.
function checkActions(actions) {
  const ids = new Set();

  actions.forEach((action, index) => {
    checkAction(action, index);
    if (ids.has(action.id)) fail(`Prose actions[${index}] repeats id ${action.id}`);
    ids.add(action.id);
  });
  return ids;
}

function checkAction(action, index) {
  const label = `actions[${index}]`;
  if (!action || typeof action !== 'object') fail(`Prose ${label} must be an object`);

  const empty = ACTION_FIELDS.filter((field) => !isText(action[field]));
  if (empty.length > 0) fail(`Prose ${label} needs non-empty: ${empty.join(', ')}`);

  if (!ID_PATTERN.test(action.id)) {
    fail(`Prose ${label}.id must be lowercase letters, digits, and hyphens`);
  }
  expectOneOf(label, 'severity', action.severity, SEVERITIES);
  expectOneOf(label, 'effort', action.effort, EFFORTS);
  expectOneOf(label, 'impact', action.impact, IMPACTS);
  expectOneOf(label, 'owner', action.owner, OWNERS);
  expectOneOf(label, 'fixKind', action.fixKind, FIX_KINDS);

  if (action.decision !== undefined && typeof action.decision !== 'string') {
    fail(`Prose ${label}.decision must be a string when set`);
  }

  if (EXAMPLE_KINDS.has(action.fixKind) && !isText(action.example)) {
    fail(`Prose ${label} needs example: fixKind ${action.fixKind} requires one`);
  }
}

// Each priority item names a wrong or improve title, and may name a Plan action.
function checkPriorityLinks(value, actionIds) {
  const titles = new Set([...value.wrong, ...value.improve].map((item) => item.title));

  value.priority.forEach((item, index) => {
    if (!titles.has(item.title)) {
      fail(`Prose priority[${index}] title must match a wrong or improve title`);
    }
    if (item.action != null && !actionIds.has(item.action)) {
      fail(`Prose priority[${index}].action names no action id: ${item.action}`);
    }
  });
}

function pageLang(value) {
  const lang = typeof value.lang === 'string' ? value.lang.trim() : '';

  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang)) {
    fail('Prose lang must be the BCP 47 tag of the user language');
  }

  return lang;
}

function withoutLang(value) {
  const copy = { ...value };
  delete copy.lang;
  return copy;
}

function withLang(source, lang) {
  if (!/<html\b/i.test(source)) fail('Template has no html element');

  return source.replace(/<html\b[^>]*>/i, `<html lang="${lang}">`);
}
