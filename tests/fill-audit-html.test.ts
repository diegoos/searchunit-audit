import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SCRIPT = new URL('../skills/searchunit-audit/scripts/fill-audit-html.mjs', import.meta.url)
  .pathname;
const TEMPLATE = new URL('../skills/searchunit-audit/template/index.html', import.meta.url)
  .pathname;

const BASE_PROSE = {
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

function withAction(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...BASE_PROSE, actions: [{ ...ACTION, ...overrides }] };
}

interface FillResult {
  status: number | null;
  stderr: string;
  out: string;
}

/** Runs the fill. Pass `undefined` for `cli` to run without `--cli`. */
function spawnFill(prose: Record<string, unknown>, cli: unknown): FillResult {
  const dir = mkdtempSync(join(tmpdir(), 'su-fill-html-'));
  const prosePath = join(dir, 'p.json');
  const outPath = join(dir, 'out.html');
  const args = ['--template', TEMPLATE, '--prose', prosePath, '--out', outPath];

  writeFileSync(prosePath, JSON.stringify(prose));

  if (cli !== undefined) {
    const cliPath = join(dir, 'cli.json');

    writeFileSync(cliPath, JSON.stringify(cli));
    args.push('--cli', cliPath);
  }

  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stderr: result.stderr,
    out: result.status === 0 ? readFileSync(outPath, 'utf8') : '',
  };
}

function runFill(prose: Record<string, unknown>, cli: unknown = CLI): FillResult {
  return spawnFill(prose, cli);
}

/** Parses the JSON that the fill writes into the `#audit-data` slot. */
function readAuditData(out: string): {
  kind: string;
  cli: unknown;
  prose: Record<string, unknown>;
} {
  const match = out.match(/<script type="application\/json" id="audit-data">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error('no #audit-data slot in output');
  }

  return JSON.parse(match[1]);
}

describe('fill-audit-html action contract', () => {
  test('accepts a complete action with a validation check', () => {
    const result = runFill({ ...withAction({}), validation: [CHECK] });

    expect(result.status).toBe(0);
    expect(result.out).toContain('"actions":[');
    expect(result.out).toContain('"validation":[');
  });
  test('accepts a content action without an example', () => {
    const result = runFill(
      withAction({ fixKind: 'content', example: undefined, title: 'Rewrite the intro' }),
    );

    expect(result.status).toBe(0);
  });
  test('rejects a header action without an example', () => {
    const result = runFill(withAction({ example: '' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('actions[0]');
    expect(result.stderr).toContain('example');
  });
  test('rejects an action missing a required field', () => {
    const result = runFill(withAction({ verify: '' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('actions[0] needs non-empty: verify');
  });
  test('rejects an action with an unknown effort, owner, or impact', () => {
    expect(runFill(withAction({ effort: 'XL' })).status).toBe(1);
    expect(runFill(withAction({ owner: 'marketing' })).status).toBe(1);
    expect(runFill(withAction({ impact: 'huge' })).status).toBe(1);
  });
  test('rejects an action id that is not a safe anchor', () => {
    const result = runFill(withAction({ id: 'P1 csp' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('actions[0].id');
  });
  test('rejects a repeated action id', () => {
    const result = runFill({
      ...BASE_PROSE,
      actions: [ACTION, { ...ACTION, title: 'Other' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('repeats id p1');
  });
  test('rejects a validation item without a check', () => {
    const result = runFill({ ...BASE_PROSE, validation: [{ command: CHECK.command, check: '' }] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('validation[0] needs non-empty: check');
  });
  test('rejects an unknown severity on an issue item', () => {
    const result = runFill({
      ...BASE_PROSE,
      improve: [{ title: 'T', text: 'A sentence.', evidence: 'direct', severity: 'fail' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('improve[0].severity');
  });
  test('accepts ids and affected on issue items', () => {
    const result = runFill({
      ...BASE_PROSE,
      wrong: [
        {
          title: 'T',
          text: 'A sentence.',
          evidence: 'direct',
          severity: 'high',
          ids: ['meta:title'],
          affected: 'https://www.test.com/',
        },
      ],
    });
    expect(result.status).toBe(0);
  });
  test('rejects a priority title that matches no wrong or improve title', () => {
    const result = runFill({
      ...BASE_PROSE,
      improve: [{ title: 'HSTS', text: 'A sentence.', evidence: 'direct' }],
      priority: [{ title: 'Something else', text: 'A sentence.' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('priority[0] title must match');
  });
});

describe('fill-audit-html priority links', () => {
  const linked = {
    ...withAction({}),
    improve: [{ title: 'CSP is absent', text: 'A sentence.', evidence: 'direct' }],
    priority: [{ title: 'CSP is absent', text: 'A sentence.', action: 'p1' }],
  };
  test('accepts a priority item that names an action id', () => {
    const result = runFill(linked);

    expect(result.status).toBe(0);
    expect(result.out).toContain('"action":"p1"');
  });
  test('rejects a priority item that names no action', () => {
    const result = runFill({
      ...linked,
      priority: [{ title: 'CSP is absent', text: 'A sentence.', action: 'p9' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('names no action id: p9');
  });
  test('the template links each priority to its action anchor', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain('item.action ? `#');
  });
});

describe('fill-audit-html escaping', () => {
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
});

describe('fill-audit-html required arrays', () => {
  test('rejects a prose without actions', () => {
    const { actions: _actions, ...noActions } = BASE_PROSE;
    const result = runFill(noActions);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('actions');
  });
  test('rejects a prose without validation', () => {
    const { validation: _validation, ...noValidation } = BASE_PROSE;
    const result = runFill(noValidation);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('validation');
  });
  test('accepts empty actions and validation arrays', () => {
    const result = runFill(BASE_PROSE);

    expect(result.status).toBe(0);
  });
});

describe('fill-audit-html check notes', () => {
  test('accepts a check with a note', () => {
    const result = runFill({
      ...BASE_PROSE,
      checks: [
        { slug: 'canonical', result: 'not observed', evidence: 'direct', note: 'No canonical.' },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.out).toContain('"note":"No canonical."');
  });
  test('the template renders the check note through esc', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain("esc(row.note || '')");
  });
  test('rejects an empty check note', () => {
    const result = runFill({
      ...BASE_PROSE,
      checks: [{ slug: 'canonical', result: 'observed', evidence: 'direct', note: '' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checks[0].note');
  });
});

describe('fill-audit-html checks grouping', () => {
  test('the template renders not observed checks in a closed group after the actionable rows', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain("row.result !== 'not observed'");
    expect(template).toContain("row.result === 'not observed'");
    expect(template).toContain('<details class="checks-quiet"><summary>');
    expect(template).toContain('} with no issue`');
    expect(template).toContain('esc(quietLabel)');
  });
});

describe('fill-audit-html cli input', () => {
  test('writes the cli payload under the fill kind', () => {
    const result = runFill(BASE_PROSE);

    expect(result.status).toBe(0);
    expect(result.out).toContain('"kind":"searchunit-audit-fill"');
  });
  test('rejects a run without --cli', () => {
    const result = spawnFill(BASE_PROSE, undefined);

    expect(result.status).not.toBe(0);
  });
  test('rejects a cli payload without command', () => {
    const { command: _command, ...noCommand } = CLI;
    const result = runFill(BASE_PROSE, noCommand);

    expect(result.status).not.toBe(0);
  });
  test('rejects a cli payload without scores', () => {
    const { scores: _scores, ...noScores } = CLI;
    const result = runFill(BASE_PROSE, noScores);

    expect(result.status).not.toBe(0);
  });
});

describe('fill-audit-html prose round-trip', () => {
  test('keeps dollar patterns in prose text exact', () => {
    const text = "Price US$$, then $& and $' end.";
    const result = runFill({ ...BASE_PROSE, sampleSentence: text, cuts: text });

    expect(result.status).toBe(0);

    const data = readAuditData(result.out);

    expect(data.prose.sampleSentence).toBe(text);
    expect(data.prose.cuts).toBe(text);
  });
});

describe('fill-audit-html plan links', () => {
  test('the template renders the action why and the issue plan link', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain('action.why');
    expect(template).toContain('Plan: <a href=');
  });
});

describe('fill-audit-html action decision', () => {
  const DECISION = 'Keep the menu <nav> or the link list? Pick one.';

  test('carries an action decision into the audit data', () => {
    const result = runFill(withAction({ decision: DECISION }));

    expect(result.status).toBe(0);

    const data = readAuditData(result.out);

    expect((data.prose.actions as { decision?: string }[])[0]?.decision).toBe(DECISION);
  });
  test('accepts an action without a decision or with decision none', () => {
    expect(runFill(withAction({})).status).toBe(0);
    expect(runFill(withAction({ decision: 'none' })).status).toBe(0);
  });
  test('rejects a decision that is not a string', () => {
    const result = runFill(withAction({ decision: ['A', 'B'] }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('actions[0].decision must be a string');
  });
  test('the template renders the decision row through esc and hides empty or none', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain("const decision = (action.decision ?? '').trim();");
    expect(template).toContain("['Decision', decision === 'none' ? '' : decision]");
    expect(template).toContain(`<dd>\${esc(value)}</dd>`);
  });
});

describe('fill-audit-html crux claim', () => {
  test('the template states CrUX is in the score only behind a condition', () => {
    const template = readFileSync(TEMPLATE, 'utf8');
    const claimLines = template
      .split('\n')
      .filter((line) =>
        /CrUX in the score|Field Core Web Vitals are in the technical score/.test(line),
      );

    expect(claimLines.length).toBeGreaterThan(0);

    for (const line of claimLines) {
      expect(line).toMatch(/\bif \(|\?\s*'/);
    }
  });
  test('the in-score flag comes from CrUX field data, not from the key alone', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain('cruxAvailable: cruxHasFieldData(discovery.crux)');
    expect(template).not.toMatch(/cruxAvailable:\s*report\.cruxApiKeyAvailable/);
  });
});

describe('fill-audit-html evidence labels', () => {
  const CHECK_ROW = { slug: 'canonical', result: 'observed', evidence: 'direct' };
  const ISSUE = { title: 'T', text: 'A sentence.', evidence: 'direct', severity: 'high' };

  test('accepts each evidence label on check rows', () => {
    const labels = ['direct', 'proxy', 'lab', 'mixed', 'inferred', 'insufficient'];
    const result = runFill({
      ...BASE_PROSE,
      checks: labels.map((evidence) => ({ ...CHECK_ROW, evidence })),
    });
    expect(result.status).toBe(0);
  });
  test('rejects an assumption evidence label on a check row', () => {
    const result = runFill({
      ...BASE_PROSE,
      checks: [{ ...CHECK_ROW, evidence: 'assumption' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checks[0].evidence must be one of');
  });
  test('rejects an unknown result on a check row', () => {
    const result = runFill({
      ...BASE_PROSE,
      checks: [{ ...CHECK_ROW, result: 'maybe' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checks[0].result must be one of');
  });
  test('rejects an assumption evidence label on a wrong item', () => {
    const result = runFill({
      ...BASE_PROSE,
      wrong: [{ ...ISSUE, evidence: 'assumption' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('wrong[0].evidence must be one of');
  });
  test('rejects an assumption evidence label on an improve item', () => {
    const result = runFill({
      ...BASE_PROSE,
      improve: [{ ...ISSUE, evidence: 'assumption' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('improve[0].evidence must be one of');
  });
});

describe('fill-audit-html Limits section', () => {
  const METHOD =
    'The sample judgment reads static HTML. When the HTML is a shell and lighthouse.renderedText is set, that text is lab evidence.';
  const NO_RANKING = 'This report states no ranking, traffic, revenue, or citation outcome.';
  const CUTS = 'main complete. sitemap complete. links complete. lighthouse error binary-missing.';

  test('the template renders the fixed method sentence and the no-ranking sentence in Limits', () => {
    const template = readFileSync(TEMPLATE, 'utf8');

    expect(template).toContain(METHOD);
    expect(template).toContain(NO_RANKING);
  });
  test('the filled page carries the fixed Limits sentences in the template', () => {
    const result = runFill({ ...BASE_PROSE, cuts: CUTS });

    expect(result.status).toBe(0);
    expect(result.out).toContain(METHOD);
    expect(result.out).toContain(NO_RANKING);
  });
  test('the template labels the Cuts line and keeps a value that already has the label once', () => {
    const template = readFileSync(TEMPLATE, 'utf8');
    const result = runFill({ ...BASE_PROSE, cuts: CUTS });

    expect(template).toContain(`<p class="prose">Cuts: \${esc(text)}</p>`);
    expect(template).toContain('.replace(/^\\s*Cuts:\\s*/i, ');
    expect(result.out).toContain(`"cuts":"${CUTS}"`);
  });
});
