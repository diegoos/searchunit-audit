import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const SCRIPT = new URL('../scripts/fill-audit-html.mjs', import.meta.url).pathname;
const TEMPLATE = new URL('../template/index.html', import.meta.url).pathname;

type Prose = Record<string, unknown>;

const BASE_PROSE: Prose = {
  lang: 'en',
  context: [],
  wrong: [],
  improve: [],
  priority: [],
  checks: [],
  sample: [],
  sampleSentence: 'URLs outside this sample were not read.',
  examples: [],
  gsc: {},
  limits: [],
  cuts: '',
  actions: [],
  validation: [],
};

const ACTION = {
  id: 'p1',
  title: 'Send Content-Security-Policy',
  severity: 'medium',
  phase: '1',
  effort: 'S',
  impact: 'medium',
  owner: 'dev',
  source: 'security:content-security-policy',
  location: 'Response headers of https://www.test.com/',
  current: 'absent',
  target: 'Content-Security-Policy present',
  fix: 'Send a policy that lists the origins the page loads.',
  fixKind: 'header',
  example: "Content-Security-Policy: default-src 'self'",
  why: 'Without a policy, the page accepts scripts from any origin.',
  verify:
    'searchunit audit "https://www.test.com/" --agent --silent. Finding security:content-security-policy is pass.',
};

const CHECK = {
  command: 'searchunit audit "https://www.test.com/" --agent --silent',
  check: 'p1: finding security:content-security-policy is pass.',
};

const CHECK_ROW = { slug: 'canonical', result: 'observed', evidence: 'direct' };
const ISSUE = { title: 'T', text: 'A sentence.', evidence: 'direct', severity: 'high' };
const ENTRY = { id: 'links:status', state: 'recurring', plan: 'p1' };

/** Minimal audit payload: the fill needs `command` and `scores`. */
const CLI = {
  command: 'audit',
  url: 'https://www.test.com/',
  fetchedAt: '2026-09-30T22:14:00-03:00',
  scores: {
    overall: 60,
    label: 'Moderate',
    confidence: 'low',
    evidence_quality: 'mixed',
    breakdown: [],
  },
};

function withAction(overrides: Prose): Prose {
  return { ...BASE_PROSE, actions: [{ ...ACTION, ...overrides }] };
}

function without(value: object, key: string): Prose {
  const copy: Prose = { ...value };

  delete copy[key];
  return copy;
}

/** A prose that uses every optional link and note field, and passes. */
const COMPLETE: Prose = {
  ...withAction({ decision: 'Keep the menu <nav> or the link list? Pick one.' }),
  wrong: [
    {
      title: 'CSP is absent',
      text: 'A sentence.',
      evidence: 'direct',
      severity: 'high',
      ids: ['meta:title'],
      affected: 'https://www.test.com/',
      plan: 'p1',
    },
  ],
  checks: [
    { slug: 'canonical', result: 'not observed', evidence: 'direct', note: 'No canonical.' },
  ],
  priority: [{ title: 'CSP is absent', text: 'A sentence.', action: 'p1' }],
  validation: [CHECK],
};

interface FillResult {
  status: number | null;
  stderr: string;
  out: string;
}

/** Runs the fill. Pass `null` for `cli` to run without `--cli`. */
function runFill(prose: Prose, cli: unknown = CLI): FillResult {
  const dir = mkdtempSync(join(tmpdir(), 'su-fill-html-'));
  const prosePath = join(dir, 'p.json');
  const outPath = join(dir, 'out.html');
  const args = ['--template', TEMPLATE, '--prose', prosePath, '--out', outPath];

  writeFileSync(prosePath, JSON.stringify(prose));

  if (cli !== null) {
    const cliPath = join(dir, 'cli.json');

    writeFileSync(cliPath, JSON.stringify(cli));
    args.push('--cli', cliPath);
  }

  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) throw result.error;

  return {
    status: result.status,
    stderr: result.stderr,
    out: result.status === 0 ? readFileSync(outPath, 'utf8') : '',
  };
}

// Runs the page script of the filled HTML, so a test sees the sections the reader sees.
async function renderedDocument(out: string): Promise<Document> {
  const window = new Window({
    url: 'http://localhost/',
    // The script is this repo's template, not page content from the web.
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });

  window.document.write(out);
  await window.happyDOM.waitUntilComplete();

  return window.document as unknown as Document;
}

/** Parses the JSON that the fill writes into the `#audit-data` slot. */
function readAuditData(out: string): { kind: string; prose: Prose } {
  const match = out.match(/<script type="application\/json" id="audit-data">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error('no #audit-data slot in output');
  }

  return JSON.parse(match[1]);
}

// One row per validation message family: the prose key, the value, and the stderr text.
const REJECTIONS: [string, Prose, string][] = [
  [
    'a prose key that would overwrite a CLI number',
    { ...BASE_PROSE, scores: { overall: 100 } },
    'does not accept: scores',
  ],
  ['a missing required array', without(BASE_PROSE, 'actions'), 'needs arrays: actions'],
  ['a missing required string', without(BASE_PROSE, 'cuts'), 'needs strings: cuts'],
  ['a missing gsc object', without(BASE_PROSE, 'gsc'), 'needs a gsc object'],
  ['a lang that is not a language tag', { ...BASE_PROSE, lang: 'not a tag' }, 'BCP 47'],
  [
    'a check result outside the allowed list',
    { ...BASE_PROSE, checks: [{ ...CHECK_ROW, result: 'maybe' }] },
    'checks[0].result must be one of',
  ],
  [
    'an empty check note',
    { ...BASE_PROSE, checks: [{ ...CHECK_ROW, note: '' }] },
    'checks[0].note must be a non-empty string',
  ],
  [
    'an ids value that is not a list',
    { ...BASE_PROSE, wrong: [{ ...ISSUE, ids: 'meta:title' }] },
    'wrong[0].ids must be an array of non-empty strings',
  ],
  [
    'a plan on a priority item',
    { ...BASE_PROSE, priority: [{ title: 'T', text: 'A sentence.', plan: 'p1' }] },
    'priority[0].plan is not accepted on priority',
  ],
  [
    'an action with an empty required field',
    withAction({ verify: '' }),
    'actions[0] needs non-empty: verify',
  ],
  [
    'an action id that is not a safe anchor',
    withAction({ id: 'P1 csp' }),
    'lowercase letters, digits, and hyphens',
  ],
  [
    'a repeated action id',
    { ...BASE_PROSE, actions: [ACTION, { ...ACTION, title: 'Other' }] },
    'repeats id p1',
  ],
  ['a header action without an example', withAction({ example: '' }), 'actions[0] needs example'],
  [
    'a decision that is not a string',
    withAction({ decision: ['A', 'B'] }),
    'actions[0].decision must be a string',
  ],
  [
    'a priority title that matches no wrong or improve title',
    {
      ...BASE_PROSE,
      improve: [{ title: 'HSTS', text: 'A sentence.', evidence: 'direct' }],
      priority: [{ title: 'Something else', text: 'A sentence.' }],
    },
    'priority[0] title must match',
  ],
  [
    'a priority action that names no action id',
    {
      ...withAction({}),
      improve: [{ title: 'CSP is absent', text: 'A sentence.', evidence: 'direct' }],
      priority: [{ title: 'CSP is absent', text: 'A sentence.', action: 'p9' }],
    },
    'names no action id: p9',
  ],
  [
    'a recurrence state outside the recurrence states',
    { ...COMPLETE, recurrence: [{ ...ENTRY, state: 'maybe' }] },
    'recurrence[0].state must be one of: new, recurring',
  ],
  [
    'a recurrence plan id that names no action',
    { ...COMPLETE, recurrence: [{ ...ENTRY, plan: 'p9' }] },
    'recurrence[0].plan names no action id: p9',
  ],
  [
    'a recurrence plan that is not a lowercase Plan id',
    { ...COMPLETE, recurrence: [{ ...ENTRY, plan: 'P1' }] },
    'recurrence[0].plan must be a lowercase Plan id',
  ],
  [
    'a recurrence value that is not a list',
    { ...COMPLETE, recurrence: ENTRY },
    'Prose recurrence must be an array',
  ],
];

// The CLI argument of each row: `null` runs without --cli.
const CLI_REJECTIONS: [string, unknown, string][] = [
  ['a run without --cli', null, 'Missing --cli'],
  ['a cli payload without command', without(CLI, 'command'), 'CLI JSON needs command and scores'],
];

describe('fill-audit-html rejects invalid prose', () => {
  test.each(REJECTIONS)('%s', (_, prose, message) => {
    const result = runFill(prose);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

describe('fill-audit-html rejects invalid cli input', () => {
  test.each(CLI_REJECTIONS)('%s', (_, cli, message) => {
    const result = runFill(BASE_PROSE, cli);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

describe('fill-audit-html accepts valid prose', () => {
  test('keeps the action links, check note, and action decision in the audit data', () => {
    const result = runFill(COMPLETE);

    expect(result.status).toBe(0);

    const data = readAuditData(result.out);
    const [action] = data.prose.actions as { decision?: string }[];

    expect(data.kind).toBe('searchunit-audit-fill');
    expect(action?.decision).toBe('Keep the menu <nav> or the link list? Pick one.');
    expect((data.prose.priority as { action?: string }[])[0]?.action).toBe('p1');
    expect((data.prose.checks as { note?: string }[])[0]?.note).toBe('No canonical.');
  });

  test('accepts a content action without an example', () => {
    const result = runFill(
      withAction({ fixKind: 'content', example: undefined, title: 'Rewrite the intro' }),
    );

    expect(result.status).toBe(0);
  });

  test('accepts the none plan for a recurrence line with no action', () => {
    const result = runFill({ ...COMPLETE, recurrence: [{ ...ENTRY, plan: 'none' }] });

    expect(result.status).toBe(0);
  });
});

describe('fill-audit-html escaping and round-trip', () => {
  test('keeps script markup inside an example out of the page as raw HTML', () => {
    const result = runFill(
      withAction({
        example: '<script>alert("x")</script>',
        fixKind: 'markup',
      }),
    );

    expect(result.status).toBe(0);
    expect(result.out).not.toContain('<script>alert');
    expect(result.out).toContain('\\u003cscript>alert');
  });

  test('keeps dollar patterns in prose text exact', () => {
    const text = "Price US$$, then $& and $' end.";
    const result = runFill({ ...BASE_PROSE, sampleSentence: text, cuts: text });

    expect(result.status).toBe(0);

    const data = readAuditData(result.out);

    expect(data.prose.sampleSentence).toBe(text);
    expect(data.prose.cuts).toBe(text);
  });
});

describe('fill-audit-html recurrence', () => {
  test('keeps a recurrence line in the audit data, the page renders it', () => {
    const result = runFill({ ...COMPLETE, recurrence: [ENTRY] });

    expect(result.status).toBe(0);
    expect(readAuditData(result.out).prose.recurrence).toEqual([ENTRY]);
  });

  test('keeps an empty recurrence list, so the page hides the block', () => {
    const result = runFill({ ...COMPLETE, recurrence: [] });

    expect(result.status).toBe(0);
    expect(readAuditData(result.out).prose.recurrence).toEqual([]);
  });

  test('the page shows the Recurrence block and its nav link for one line', async () => {
    const result = runFill({ ...COMPLETE, recurrence: [ENTRY] });
    const doc = await renderedDocument(result.out);
    const section = doc.querySelector('#recurrence');

    expect(section).not.toBeNull();
    expect(section?.closest('[hidden]')).toBeNull();
    expect(section?.textContent).toContain('links:status');
    expect(section?.textContent).toContain('recurring');
    expect(section?.querySelector('a[href="#p1"]')).not.toBeNull();
    expect(doc.querySelector('a[href="#recurrence"]')).not.toBeNull();
  });

  test('the page has no Recurrence block or nav link for an empty list', async () => {
    const result = runFill({ ...COMPLETE, recurrence: [] });
    const doc = await renderedDocument(result.out);

    expect(doc.querySelector('#report')?.children.length).toBeGreaterThan(0);
    expect(doc.querySelector('#recurrence')).toBeNull();
    expect(doc.querySelector('a[href="#recurrence"]')).toBeNull();
  });
});

describe('fill-audit-html evidence cards', () => {
  const discovery = {
    renderedPage: {
      status: 'skipped',
      reason: 'chrome-missing',
      install: 'Install Google Chrome, or set CHROME_PATH',
    },
    httpsReadiness: {
      insecureSubresources: [],
      insecureUrls: [],
      devHostUrls: [{ field: 'canonical', url: 'http://localhost:8799/' }],
    },
  };

  test('the page shows the render state with its install hint, and the HTTPS readiness list', async () => {
    const doc = await renderedDocument(runFill(COMPLETE, { ...CLI, discovery }).out);

    expect(doc.querySelector('#render')?.textContent).toContain('chrome-missing');
    expect(doc.querySelector('#render')?.textContent).toContain('set CHROME_PATH');
    expect(doc.querySelector('#https-readiness')?.textContent).toContain('http://localhost:8799/');
  });

  test('the page has no render or HTTPS readiness card without that data', async () => {
    const doc = await renderedDocument(runFill(COMPLETE).out);

    expect(doc.querySelector('#render')).toBeNull();
    expect(doc.querySelector('#https-readiness')).toBeNull();
  });
});
