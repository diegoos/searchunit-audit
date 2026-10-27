import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SCRIPT = new URL('../skills/searchunit-audit/scripts/check-audit-report.mjs', import.meta.url)
  .pathname;

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

interface Files {
  md: string;
  cli: Record<string, unknown>;
  prose: Record<string, unknown>;
}

function run(args: string[]): RunResult {
  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000 });

  if (result.error) {
    throw result.error;
  }

  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const SLUGS = run(['--slugs']).stdout.trim().split('\n');

/** Runs the validator on files written to a temp dir. Pass `withProse: false` for md and cli only. */
function check(files: Files, withProse = true): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'su-audit-report-'));
  const mdPath = join(dir, 'audit-report.md');
  const cliPath = join(dir, 'cli-audit.json');
  const prosePath = join(dir, 'audit-prose.json');
  const args = ['--md', mdPath, '--cli', cliPath];

  writeFileSync(mdPath, files.md);
  writeFileSync(cliPath, JSON.stringify(files.cli));
  writeFileSync(prosePath, JSON.stringify(files.prose));

  if (withProse) {
    args.push('--prose', prosePath);
  }

  return run(args);
}

/** Removes every line that starts with `prefix`. */
function dropLine(md: string, prefix: string): string {
  return md
    .split('\n')
    .filter((line) => !line.startsWith(prefix))
    .join('\n');
}

/** Removes the backticks around each id, so the id no longer counts as cited. */
function unquote(md: string, ids: string[]): string {
  return ids.reduce((text, id) => text.split(`\`${id}\``).join(id), md);
}

const PLAN_P1 = [
  '### P1. Add a meta description',
  '',
  '- Severity: high. Phase: 1. Effort: S. Impact: high (SEO). Owner: dev.',
  '- Source: `meta:description`',
  '- Fix kind: markup',
  '- Location: https://www.test.com/, `head`',
  '- Current → target: missing → 150 to 160 characters',
  '- Why: The snippet needs a description.',
  '- Fix: Write the description from the first paragraph.',
  '- Decision: none.',
  '- Example:',
  '',
  '```html',
  '<meta name="description" content="<150-160 character description>">',
  '```',
  '',
  '- Depends on: none',
  '- Verify: `searchunit audit "https://www.test.com/" --agent --silent`. Check `meta:description` is `pass`.',
  '',
];

function wrongItem(cliId: string): string[] {
  return [
    '### Meta description is missing',
    '- Severity: high',
    '- Evidence: direct',
    `- CLI ids: \`${cliId}\``,
    '- Plan: P1',
    'The page has no meta description.',
    '',
  ];
}

/** An item that cites every id in backticks. The sentence is the last line. */
function citedItem(title: string, ids: string[]): string[] {
  return [
    `### ${title}`,
    '- Severity: high',
    '- Evidence: direct',
    `- CLI ids: ${ids.map((id) => `\`${id}\``).join(', ')}`,
    '- Plan: P1',
    'The page has the findings named above.',
    '',
  ];
}

// Query rows carry insufficient evidence, because the default fixture query is an assumption.

const QUERY_ROW_SLUGS = ['intent', 'query-terms', 'query-answer'];

function checkRows(slugs: string[] = SLUGS): string[] {
  return slugs.map((slug) => {
    const evidence = QUERY_ROW_SLUGS.includes(slug) ? 'insufficient' : 'direct';

    return `| ${slug} | not observed | ${evidence} | ${slug === 'canonical' ? 'No finding in the CLI payload.' : ''} |`;
  });
}

interface ReportParts {
  wrong?: string[];
  plan?: string[];
  checks?: string[];
  priority?: string[];
  reaudit?: string[];
  readiness?: string;
  query?: string;
  target?: string;
}

/** One Priority line per `### ` item in the What Is Wrong lines, as the report template requires. */
function defaultPriority(wrong: string[]): string[] {
  return wrong
    .filter((line) => line.startsWith('### '))
    .map((line, index) => `${index + 1}. ${line.slice(4)}. Severity: high. Plan: P1. Fix it.`);
}

function reportMd(parts: ReportParts = {}): string {
  const wrong = parts.wrong ?? wrongItem('meta:description');

  return [
    '# GEO + SEO Page Audit: https://www.test.com/',
    '',
    'Audit date: 2026-10-26',
    `Target: ${parts.target ?? 'https://www.test.com/'}`,
    'Scope: page. 1 page scored. Context: robots=true.',
    `CLI readiness: ${parts.readiness ?? '60 / 60 / 60 (overview / geo / seo)'}`,
    'This report states no ranking, traffic, revenue, or citation outcome.',
    `Query: ${parts.query ?? 'assumption. test widgets: widgets for small teams.'}`,
    'Indexation: status 200, robots none, canonical https://www.test.com/. This run did not read the indexed version.',
    '',
    '## Sample Coverage',
    '',
    'URLs outside this sample were not read.',
    '',
    '## What Is Wrong',
    '',
    ...wrong,
    '## What To Improve',
    '',
    'No confirmed issues found. Evidence limitation: fixture.',
    '',
    '## Priority',
    '',
    ...(parts.priority ?? defaultPriority(wrong)),
    '',
    '## Plan',
    '',
    ...(parts.plan ?? PLAN_P1),
    '## Re-audit',
    '',
    ...(parts.reaudit ?? [
      '- P1: `searchunit audit "https://www.test.com/" --agent --silent`. Check `meta:description` is `pass`.',
    ]),
    '',
    '## Checks',
    '',
    '| Slug | Result | Evidence | Note |',
    '| --- | --- | --- | --- |',
    ...(parts.checks ?? checkRows()),
    '',
    '## Examples',
    '',
    '- P1: `<meta>` in the head of https://www.test.com/.',
    '',
    '## Search Console',
    '',
    'Search Console was not used. Evidence limitation: insufficient.',
    '',
    '## Evidence Limits',
    '',
    'Backlinks: insufficient. This run does not fetch an off-page source.',
    'Crawl logs: insufficient. This run has no server logs.',
    'CrUX: insufficient. cruxApiKeyAvailable is false.',
    'Observed citations: insufficient. This run has no pasted platform test.',
    'GBP/NAP: not observed. The business type is not local.',
    'Conversions: insufficient. This run does not read analytics.',
    'Cuts: main complete. sitemap complete. links complete. outbound complete. headings complete. images complete. citability complete. llms complete. lighthouse skipped no-chrome.',
    '',
  ].join('\n');
}

function proseFor(wrongCount = 1): Record<string, unknown> {
  const wrong = Array.from({ length: wrongCount }, () => ({
    title: 'Meta description is missing',
    text: 'The page has no meta description.',
    evidence: 'direct',
    severity: 'high',
    ids: ['meta:description'],
  }));

  return {
    lang: 'en',
    wrong,
    improve: [],
    priority: [
      {
        title: 'Meta description is missing',
        text: 'Adds a description.',
        severity: 'high',
        action: 'p1',
      },
    ],
    actions: [
      {
        id: 'p1',
        title: 'Add a meta description',
        severity: 'high',
        phase: '1',
        effort: 'S',
        impact: 'high',
        owner: 'dev',
        fixKind: 'markup',
      },
    ],
    checks: SLUGS.map((slug) => ({ slug, result: 'not observed', evidence: 'direct' })),
  };
}

function cliFiles(findings: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    command: 'audit',
    url: 'https://www.test.com/',
    scores: { overall: 60, label: 'Moderate', confidence: 'low' },
    kindScores: {
      overview: { value: 60 },
      geo: { value: 60 },
      seo: { value: 60 },
    },
    findings: [{ id: 'meta:description', severity: 'fail' }, ...findings],
    blockers: [],
  };
}

function validFiles(): Files {
  return { md: reportMd(), cli: cliFiles(), prose: proseFor() };
}

/** A CLI payload with two fail findings and one blocker that the report must cite. */
function linkedCli(): Record<string, unknown> {
  return {
    ...cliFiles([
      { id: 'links:status', severity: 'fail' },
      { id: 'crawlers:GPTBot', severity: 'fail' },
    ]),
    blockers: [{ id: 'thin_content' }],
  };
}

const LINKED_IDS = ['links:status', 'crawlers:GPTBot', 'blocker:thin_content'];

describe('check-audit-report --slugs', () => {
  test('prints at least 60 workstream slugs, including crawler-access', () => {
    const result = run(['--slugs']);

    expect(result.status).toBe(0);
    expect(SLUGS.length).toBeGreaterThanOrEqual(60);
    expect(SLUGS).toContain('crawler-access');
  });
});

describe('check-audit-report', () => {
  test('passes a valid md, cli, and prose', () => {
    const result = check(validFiles());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
  test('passes a valid md and cli without prose', () => {
    const result = check(validFiles(), false);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
  test('fails when a slug has no Checks row', () => {
    const files = validFiles();

    files.md = reportMd({ checks: checkRows(SLUGS.filter((slug) => slug !== 'canonical')) });

    const result = check(files);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Checks: no row for slug canonical');
  });
  test('fails a critical item placed in Phase 2', () => {
    const plan = PLAN_P1.map((line) =>
      line.replace('Severity: high. Phase: 1', 'Severity: critical. Phase: 2'),
    );
    const result = check({ ...validFiles(), md: reportMd({ plan }) }, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('P1: Phase 2, but severity critical');
  });
  test('fails when Verify has no backticked command', () => {
    const plan = PLAN_P1.map((line) =>
      line.startsWith('- Verify:') ? '- Verify: Check `meta:description` is `pass`.' : line,
    );
    const result = check({ ...validFiles(), md: reportMd({ plan }) }, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'P1: Verify needs a backticked command starting with searchunit, npx, or bun',
    );
  });
  test('fails when Verify is a backticked command with another first word', () => {
    const plan = PLAN_P1.map((line) =>
      line.startsWith('- Verify:') ? '- Verify: `curl -I https://www.test.com/`.' : line,
    );
    const result = check({ ...validFiles(), md: reportMd({ plan }) }, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('P1: Verify needs a backticked command');
  });
  test('passes Verify with a searchunit, npx, or bun command', () => {
    for (const command of [
      'searchunit seo-check "https://www.test.com/" --agent --silent',
      'npx @searchunit/cli audit "https://www.test.com/"',
      'bun run check',
    ]) {
      const plan = PLAN_P1.map((line) =>
        line.startsWith('- Verify:')
          ? `- Verify: \`${command}\`. Check \`meta:description\` is \`pass\`.`
          : line,
      );
      const result = check({ ...validFiles(), md: reportMd({ plan }) }, false);

      expect(result.status).toBe(0);
    }
  });
  test('fails when a Plan entry has no Decision line', () => {
    const plan = PLAN_P1.filter((line) => !line.startsWith('- Decision:'));
    const result = check({ ...validFiles(), md: reportMd({ plan }) }, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('P1: missing field Decision:');
  });
  test('passes a Plan entry whose Decision line names options', () => {
    const plan = PLAN_P1.map((line) =>
      line.startsWith('- Decision:')
        ? '- Decision: Option A: keep the path. Option B: redirect it. Default: A, because the URL has links.'
        : line,
    );
    const result = check({ ...validFiles(), md: reportMd({ plan }) }, false);

    expect(result.status).toBe(0);
  });
  test('fails a CLI fail id that the report does not cite', () => {
    const cli = cliFiles([{ id: 'custom:unknown-check', severity: 'fail' }]);
    const uncited = check({ ...validFiles(), cli });

    expect(uncited.status).toBe(1);
    expect(uncited.stderr).toContain('CLI custom:unknown-check');

    const cited = check({
      ...validFiles(),
      cli,
      md: reportMd({ wrong: wrongItem('custom:unknown-check') }),
    });
    expect(cited.status).toBe(0);
  });
  test('fails when a count differs from the prose', () => {
    const result = check({ ...validFiles(), prose: proseFor(2) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('What Is Wrong items: md 1, prose 2');
  });
  test('fails when the readiness overall differs from the CLI score', () => {
    const result = check({
      ...validFiles(),
      md: reportMd({ readiness: '55 / 60 / 60 (overview / geo / seo)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('differs from scores.overall 60');
  });
});

describe('check-audit-report mutations of a valid report', () => {
  const wrong = [
    ...wrongItem('meta:description'),
    ...citedItem('Crawl and link failures', LINKED_IDS),
  ];
  const valid = (): Files => ({
    md: reportMd({ wrong }),
    cli: linkedCli(),
    prose: proseFor(),
  });
  test('the linked fixture passes before any mutation', () => {
    const result = check(valid(), false);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
  test('(a) fails when fail, warn, and blocker ids are not in backticks', () => {
    const files = valid();

    files.md = unquote(files.md, LINKED_IDS);

    const result = check(files, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLI links:status is not cited in backticks');
    expect(result.stderr).toContain('CLI crawlers:GPTBot is not cited in backticks');
    expect(result.stderr).toContain('CLI blocker:thin_content is not cited in backticks');
  });
  test('(b) fails when Scope says site', () => {
    const files = validFiles();

    files.md = files.md.replace('Scope: page.', 'Scope: site.');

    const result = check(files);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Scope: line says site, not page');
  });
  test('(c) fails when the Cuts line is missing', () => {
    const files = validFiles();

    files.md = dropLine(files.md, 'Cuts:');

    const result = check(files);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing Cuts: line');
  });
  test('(d) fails when the Backlinks and Crawl logs evidence limit lines are missing', () => {
    const files = validFiles();

    files.md = dropLine(dropLine(files.md, 'Backlinks:'), 'Crawl logs:');

    const result = check(files);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Evidence Limits: missing Backlinks: line');
    expect(result.stderr).toContain('Evidence Limits: missing Crawl logs: line');
  });
  test('(e) fails when a Checks result is not observed, not observed, or insufficient', () => {
    const rows = checkRows().map((row, index) =>
      index === 0 ? row.replace('| not observed |', '| maybe |') : row,
    );
    const result = check({ ...validFiles(), md: reportMd({ checks: rows }) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'result "maybe" must be observed, not observed, or insufficient',
    );
  });
  test('(f) fails when a Checks evidence label is not in the allowed list', () => {
    const rows = checkRows().map((row, index) =>
      index === 0 ? row.replace('| direct |', '| assumption |') : row,
    );
    const result = check({ ...validFiles(), md: reportMd({ checks: rows }) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evidence "assumption" is not an evidence label');
  });
  test('(g) fails when an item has no sentence', () => {
    const noSentence = wrongItem('meta:description').filter((line) => !line.startsWith('The page'));
    const result = check({ ...validFiles(), md: reportMd({ wrong: noSentence }) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"Meta description is missing": no sentence');
  });
  test('(h) fails when a Priority title matches no item title', () => {
    const result = check({
      ...validFiles(),
      md: reportMd({ priority: ['1. Meta description absent. Severity: high. Plan: P1.'] }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Priority "Meta description absent" matches no What Is Wrong or What To Improve title',
    );
  });
  test('fails when the Query line is missing', () => {
    const files = validFiles();

    files.md = dropLine(files.md, 'Query:');

    const result = check(files);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing Query: line');
  });
});

describe('check-audit-report assumed query', () => {
  test('fails when an assumed query has an intent row with direct evidence', () => {
    const rows = checkRows().map((row) =>
      row.startsWith('| intent |') ? row.replace('| insufficient |', '| direct |') : row,
    );
    const result = check({ ...validFiles(), md: reportMd({ checks: rows }) }, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Checks intent: assumed query needs evidence insufficient (workstreams.md intent)',
    );
  });
  test('passes direct evidence on the query rows when the query is not assumed', () => {
    const rows = checkRows().map((row) => row.replace('| insufficient |', '| direct |'));
    const result = check(
      {
        ...validFiles(),
        md: reportMd({ query: 'acme widgets: industrial widgets', checks: rows }),
      },
      false,
    );

    expect(result.status).toBe(0);
  });
});

describe('check-audit-report readiness kinds', () => {
  test('fails when the geo readiness differs from kindScores.geo', () => {
    const result = check(
      { ...validFiles(), md: reportMd({ readiness: '60 / 55 / 60 (overview / geo / seo)' }) },
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLI readiness geo 55 differs from kindScores.geo.value 60');
  });
  test('fails when the seo readiness differs from kindScores.seo', () => {
    const result = check(
      { ...validFiles(), md: reportMd({ readiness: '60 / 60 / 50 (overview / geo / seo)' }) },
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLI readiness seo 50 differs from kindScores.seo.value 60');
  });
});

const PLAN_PROD = PLAN_P1.map((line) =>
  line.startsWith('- Fix:')
    ? '- Fix: Verify on production. Write the description from the first paragraph.'
    : line,
);

/** A loopback audit with a no_https blocker. The md cites it, so only the Target and Plan rules apply. */
function loopback(target: string, plan: string[], blockers: Record<string, unknown>[]): Files {
  return {
    md: reportMd({
      target,
      plan,
      wrong: [
        ...wrongItem('meta:description'),
        ...citedItem('Page is served over HTTP', ['blocker:no_https']),
      ],
    }),
    cli: { ...cliFiles(), url: 'http://localhost:8765/page.html', blockers },
    prose: proseFor(),
  };
}

describe('check-audit-report loopback target', () => {
  test('passes a dev server report that says Verify on production', () => {
    const result = check(
      loopback('http://localhost:8765/page.html (dev server)', PLAN_PROD, [{ id: 'no_https' }]),
      false,
    );

    expect(result.status).toBe(0);
  });
  test('fails when the Target line lacks (dev server)', () => {
    const result = check(
      loopback('http://localhost:8765/page.html', PLAN_PROD, [{ id: 'no_https' }]),
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Target line needs (dev server) for a loopback target');
  });
  test('fails when no_https is set and the Plan lacks Verify on production', () => {
    const result = check(
      loopback('http://localhost:8765/page.html (dev server)', PLAN_P1, [{ id: 'no_https' }]),
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Plan needs "Verify on production" for blocker:no_https on a loopback target',
    );
  });
  test('passes without Verify on production when no_https is not set', () => {
    const result = check(
      loopback('http://localhost:8765/page.html (dev server)', PLAN_P1, []),
      false,
    );

    expect(result.status).toBe(0);
  });
});

describe('check-audit-report Cuts line', () => {
  test('fails when the payload flags main text as truncated and the Cuts line says complete', () => {
    const files = {
      ...validFiles(),
      cli: { ...cliFiles(), discovery: { auditedPage: { mainTextTruncated: true } } },
    };
    const result = check(files, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cuts main: md complete, payload truncated');
  });
  test('passes when the Cuts line names the truncation', () => {
    const files = {
      ...validFiles(),
      cli: { ...cliFiles(), discovery: { auditedPage: { mainTextTruncated: true } } },
    };
    files.md = files.md.replace('Cuts: main complete.', 'Cuts: main truncated.');

    const result = check(files, false);

    expect(result.status).toBe(0);
  });
  test('fails when the lighthouse status differs from the payload', () => {
    const result = check(
      { ...validFiles(), cli: { ...cliFiles(), lighthouse: { status: 'ok' } } },
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cuts lighthouse: md skipped no-chrome, payload ok');
  });
});

/** A Plan entry block for the order tests. Each entry has one fix and no example, so fixKind is content. */
function planBlock(
  id: string,
  { severity, phase, effort, impact, dependsOn = 'none' }: PlanFields,
): string[] {
  return [
    `### ${id}. Fix ${id}`,
    '',
    `- Severity: ${severity}. Phase: ${phase}. Effort: ${effort}. Impact: ${impact} (SEO). Owner: content.`,
    '- Source: `judgment: order fixture`',
    '- Fix kind: content',
    '- Location: article body',
    '- Current → target: old → new',
    '- Why: The order test needs an entry.',
    '- Fix: Change the text.',
    '- Decision: none.',
    '- Example: not needed.',
    `- Depends on: ${dependsOn}`,
    '- Verify: `searchunit audit "https://www.test.com/" --agent --silent`. Finding meta:description is pass.',
    '',
  ];
}

interface PlanFields {
  severity: string;
  phase: number;
  effort: string;
  impact: string;
  dependsOn?: string;
}

/** Plan with the given entries, each with a Re-audit line, so only the order rules can fail. */
function planWith(entries: [string, PlanFields][]): {
  plan: string[];
  reaudit: string[];
} {
  return {
    plan: entries.flatMap(([id, fields]) => planBlock(id, fields)),
    reaudit: entries.map(
      ([id]) =>
        `- ${id}: \`searchunit audit "https://www.test.com/" --agent --silent\`. Check meta:description is pass.`,
    ),
  };
}

describe('check-audit-report Plan order', () => {
  const HIGH_M: PlanFields = { severity: 'medium', phase: 2, effort: 'M', impact: 'high' };
  const MEDIUM_S: PlanFields = { severity: 'medium', phase: 2, effort: 'S', impact: 'medium' };

  function orderCheck(entries: [string, PlanFields][]): RunResult {
    const { plan, reaudit } = planWith(entries);

    return check({ ...validFiles(), md: reportMd({ plan, reaudit }) }, false);
  }

  test('passes when high impact precedes medium impact in the same phase', () => {
    const result = orderCheck([
      ['P1', HIGH_M],
      ['P2', MEDIUM_S],
    ]);

    expect(result.status).toBe(0);
  });
  test('fails when medium impact precedes high impact in the same phase', () => {
    const result = orderCheck([
      ['P1', MEDIUM_S],
      ['P2', HIGH_M],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'P2: impact high, effort M follows P1 (impact medium, effort S) in Phase 2. Order is impact, then effort',
    );
  });
  test('fails when effort L precedes effort S at the same impact', () => {
    const result = orderCheck([
      ['P1', { severity: 'medium', phase: 2, effort: 'L', impact: 'medium' }],
      ['P2', { severity: 'medium', phase: 2, effort: 'S', impact: 'medium' }],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('P2: impact medium, effort S follows P1');
  });
  test('allows a lower-sorting entry first when the later one depends on it', () => {
    const result = orderCheck([
      ['P1', MEDIUM_S],
      ['P2', { ...HIGH_M, dependsOn: 'P1' }],
    ]);

    expect(result.status).toBe(0);
  });
  test('fails when an entry depends on an entry that comes later', () => {
    const result = orderCheck([
      ['P1', { ...MEDIUM_S, dependsOn: 'P2' }],
      ['P2', HIGH_M],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'P1: depends on P2, which comes later. A dependency comes first',
    );
  });
});

describe('check-audit-report Priority lines', () => {
  const TWO_ITEMS = [
    ...wrongItem('meta:description'),
    ...citedItem('Crawl and link failures', LINKED_IDS),
  ];

  test('fails when an item has no Priority line', () => {
    const result = check(
      {
        ...validFiles(),
        md: reportMd({
          wrong: TWO_ITEMS,
          priority: ['1. Meta description is missing. Severity: high. Plan: P1. Fix it.'],
        }),
      },
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Priority has no line for "Crawl and link failures"');
  });
  test('fails when an item has two Priority lines', () => {
    const result = check(
      {
        ...validFiles(),
        md: reportMd({
          priority: [
            '1. Meta description is missing. Severity: high. Plan: P1. Fix it.',
            '2. Meta description is missing. Severity: high. Plan: P1. Fix it again.',
          ],
        }),
      },
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Priority repeats "Meta description is missing"');
  });
  test('fails when an item title ends with a period', () => {
    const wrong = wrongItem('meta:description').map((line) =>
      line.replace('### Meta description is missing', '### Meta description is missing.'),
    );
    const result = check({ ...validFiles(), md: reportMd({ wrong }) }, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'What Is Wrong "Meta description is missing.": title ends with a period',
    );
  });
  test('fails when a Priority title ends with a period', () => {
    const result = check(
      {
        ...validFiles(),
        md: reportMd({
          priority: ['1. Meta description is missing.. Severity: high. Plan: P1. Fix it.'],
        }),
      },
      false,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Priority "Meta description is missing.": title ends with a period',
    );
  });
});

describe('check-audit-report Verify on production', () => {
  test('passes a lowercase "verify on production" on a loopback target', () => {
    const plan = PLAN_PROD.map((line) =>
      line.replace('Verify on production', 'verify on production'),
    );
    const result = check(
      loopback('http://localhost:8765/page.html (dev server)', plan, [{ id: 'no_https' }]),
      false,
    );

    expect(result.status).toBe(0);
  });
});
