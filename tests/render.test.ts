import { describe, expect, test } from 'bun:test';
import type { ProcessHandle, ProcessOutcome, ProcessSpawn } from '../src/engine/childProcess.ts';
import { collectFindings, kindThresholdStatus } from '../src/engine/findings.ts';
import { renderedPageFrom, renderPage, resolveChromeBinary } from '../src/engine/render.ts';
import { renderFinding } from '../src/engine/renderFindings.ts';
import { computeAuditScores } from '../src/engine/scoring.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import { bundleFromHtml } from './engine-fixtures.ts';

const URL = 'https://example.com/app';

const PIN = '93.184.216.34';
const DOM = '<html><head><title>Shell</title></head><body><h1>Hi</h1></body></html>';

function fakeSpawn(outcome: Partial<ProcessOutcome>, seen?: { args: readonly string[] }) {
  const spawn: ProcessSpawn = (_command, args): ProcessHandle => {
    if (seen) {
      seen.args = args;
    }

    return {
      done: Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, ...outcome }),
      kill: () => undefined,
    };
  };

  return spawn;
}

function renderWith(outcome: Partial<ProcessOutcome>, seen?: { args: readonly string[] }) {
  return renderPage(URL, PIN, null, [], {
    chrome: '/fake/chrome',
    spawn: fakeSpawn(outcome, seen),
  });
}

const existing = (present: string[]) => (path: string) => present.includes(path);

describe('resolveChromeBinary', () => {
  test('CHROME_PATH wins when it exists, and falls back when it does not', () => {
    expect(
      resolveChromeBinary({ CHROME_PATH: '/opt/chrome' }, 'linux', existing(['/opt/chrome'])),
    ).toBe('/opt/chrome');
    expect(
      resolveChromeBinary(
        { CHROME_PATH: '/missing/chrome' },
        'darwin',
        existing(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
      ),
    ).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(
      resolveChromeBinary({ CHROME_PATH: '/missing/chrome' }, 'darwin', existing([])),
    ).toBeNull();
  });
  test('uses the macOS app bundle, then nothing when no Chrome is installed', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    expect(resolveChromeBinary({}, 'darwin', existing([mac]))).toBe(mac);
    expect(resolveChromeBinary({}, 'darwin', existing([]))).toBeNull();
  });
  test('finds a Linux name on PATH', () => {
    expect(
      resolveChromeBinary({ PATH: '/bin:/usr/bin' }, 'linux', existing(['/usr/bin/chromium'])),
    ).toBe('/usr/bin/chromium');
  });
});

describe('renderPage', () => {
  test('without Chrome the render is skipped with chrome-missing and spawns nothing', async () => {
    let spawned = false;
    const page = await renderPage(URL, PIN, null, [], {
      chrome: null,
      spawn: () => {
        spawned = true;

        return fakeSpawn({})('x', []);
      },
    });
    expect(page).toMatchObject({ status: 'skipped', reason: 'chrome-missing', title: null });
    expect(spawned).toBe(false);
  });
  test('passes headless, DOM dump, the pin proxy, and the host rule', async () => {
    const seen = { args: [] as readonly string[] };

    await renderWith({ stdout: DOM }, seen);

    expect(seen.args).toEqual(
      expect.arrayContaining([
        '--headless',
        '--dump-dom',
        '--virtual-time-budget=10000',
        '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=EXCLUDE 127.0.0.1, MAP example.com:443 93.184.216.34:443, MAP * ^NOTFOUND',
      ]),
    );
    expect(seen.args.some((arg) => arg.startsWith('--proxy-server=http://127.0.0.1:'))).toBe(true);
    expect(seen.args.at(-1)).toBe(URL);
  });
  test('reads the DOM and keeps the raw X-Robots-Tag in the directive', async () => {
    const page = await renderPage(URL, PIN, 'noindex', [], {
      chrome: '/fake/chrome',
      spawn: fakeSpawn({ stdout: DOM }),
    });
    expect(page).toMatchObject({
      status: 'ok',
      reason: null,
      title: 'Shell',
      h1: ['Hi'],
      effectiveRobotsDirective: 'noindex',
    });
  });
  test.each<[string, Partial<ProcessOutcome>, string, string]>([
    ['a timeout', { timedOut: true, code: null }, 'error', 'timeout'],
    ['an output overflow', { overflow: true, stdout: DOM }, 'error', 'too_large'],
    ['a missing binary', { errorCode: 'ENOENT', code: null }, 'skipped', 'chrome-missing'],
    ['no DOM on stdout', { code: 1, stdout: '' }, 'error', 'error'],
  ])('%s gives %s with reason %s', async (_name, outcome, status, reason) => {
    expect(await renderWith(outcome)).toMatchObject({ status, reason });
  });
  test('a missing Chrome carries the install hint, and other skips carry none', async () => {
    expect(
      await renderPage(URL, PIN, null, [], { chrome: null, spawn: fakeSpawn({}) }),
    ).toMatchObject({
      reason: 'chrome-missing',
      install: 'Install Google Chrome, or set CHROME_PATH',
    });
    expect(await renderWith({ errorCode: 'ENOENT', code: null })).toMatchObject({
      reason: 'chrome-missing',
      install: 'Install Google Chrome, or set CHROME_PATH',
    });
    expect(await renderWith({ timedOut: true, code: null })).toMatchObject({ install: null });
  });
  test('a DOM with a non-zero exit is still a usable render', async () => {
    expect(await renderWith({ code: 1, stdout: DOM })).toMatchObject({ status: 'ok' });
  });
  test('a DOM bigger than the body cap is too_large', async () => {
    const big = `<html>${'a'.repeat(DEFAULT_MAX_BODY_BYTES)}</html>`;

    expect(await renderWith({ stdout: big })).toMatchObject({
      status: 'error',
      reason: 'too_large',
    });
  });
  test('a spawn failure is error, not an exception', async () => {
    const page = await renderPage(URL, PIN, null, [], {
      chrome: '/fake/chrome',
      spawn: () => {
        throw new Error('spawn failed');
      },
    });
    expect(page).toMatchObject({ status: 'error', reason: 'error' });
  });
});

describe('renderedPageFrom', () => {
  test('reads the same fields as the raw parser', () => {
    const page = renderedPageFrom(
      `<html><head><title>T</title><meta name="robots" content="noindex"></head><body><h1>A</h1></body></html>`,
      URL,
      null,
      [],
    );

    expect(page.effectiveRobotsDirective).toBe('noindex');
    expect(page.h1).toEqual(['A']);
    expect(page.mainText).toBeTypeOf('string');
  });
  test('lists the rendered pageKeys that the raw index lacks', () => {
    const page = renderedPageFrom(htmlPage('<a href="/a">A</a><a href="/c">C</a>'), URL, null, [
      'example.com/a',
    ]);

    expect(page.linksOnlyAfterRender).toEqual(['example.com/c']);
    expect(page.linksOnlyAfterRenderCount).toBe(1);
  });
  test('caps the listed pageKeys at 20 and counts all of them', () => {
    const links = Array.from({ length: 25 }, (_, index) => `<a href="/p${index}">x</a>`).join('');
    const page = renderedPageFrom(htmlPage(links), URL, null, []);

    expect(page.linksOnlyAfterRender).toHaveLength(20);
    expect(page.linksOnlyAfterRenderCount).toBe(25);
  });
});

const htmlPage = (body: string, head = '') =>
  `<html><head>${head}</head><body>${body}</body></html>`;

function findingFor(raw: string, rendered: string) {
  const bundle = bundleFromHtml(raw);

  bundle.renderedPage = renderedPageFrom(
    rendered,
    bundle.auditedUrl,
    null,
    bundle.auditedPage.internalLinkIndex,
  );

  return renderFinding(bundle);
}

describe('discovery:render', () => {
  const longText = 'Reliable widgets for operations teams. '.repeat(20);

  test.each<[string, string, string, string]>([
    ['same HTML', htmlPage('<h1>A</h1><p>x</p>'), htmlPage('<h1>A</h1><p>x</p>'), 'pass'],
    [
      'noindex only in raw HTML',
      htmlPage('<h1>A</h1>', '<meta name="robots" content="noindex">'),
      htmlPage('<h1>A</h1>'),
      'fail',
    ],
    [
      'noindex only after render',
      htmlPage('<h1>A</h1>'),
      htmlPage('<h1>A</h1>', '<meta name="robots" content="noindex">'),
      'fail',
    ],
    [
      'canonical with another page key',
      htmlPage('<h1>A</h1>', '<link rel="canonical" href="https://example.com/a">'),
      htmlPage('<h1>A</h1>', '<link rel="canonical" href="https://example.com/b">'),
      'fail',
    ],
    [
      'canonical only after render',
      htmlPage('<h1>A</h1>'),
      htmlPage('<h1>A</h1>', '<link rel="canonical" href="https://example.com/a">'),
      'warn',
    ],
    [
      'title differs',
      htmlPage('<h1>A</h1>'),
      htmlPage('<h1>A</h1>', '<title>Other</title>'),
      'warn',
    ],
    [
      'schema only after render',
      htmlPage('<h1>A</h1>'),
      htmlPage(
        '<h1>A</h1>',
        '<script type="application/ld+json">{"@type":"Organization","name":"X"}</script>',
      ),
      'warn',
    ],
    [
      'text that depends on JS',
      htmlPage(`<h1>A</h1><p>${'short'}</p>`),
      htmlPage(`<h1>A</h1><p>${longText}</p>`),
      'warn',
    ],
  ])('%s gives %s', (_name, raw, rendered, severity) => {
    expect(findingFor(raw, rendered)).toMatchObject({ id: 'discovery:render', severity });
  });
  test('a link swapped for another keeps the count but warns with the new pageKey', () => {
    const finding = findingFor(
      htmlPage('<h1>A</h1><a href="/a">A</a><a href="/b">B</a>'),
      htmlPage('<h1>A</h1><a href="/a">A</a><a href="/c">C</a>'),
    );

    expect(finding).toMatchObject({ severity: 'warn' });
    expect(finding.detail).toContain('1 of 2 internal links only after render: example.com/c');
  });
  test('the same links in another order give no link warning', () => {
    expect(
      findingFor(
        htmlPage('<h1>A</h1><a href="/a">A</a><a href="/b">B</a>'),
        htmlPage('<h1>A</h1><a href="/b">B</a><a href="/a">A</a>'),
      ),
    ).toMatchObject({ severity: 'pass' });
  });
  test('a skipped render is info with the reason', () => {
    const bundle = bundleFromHtml(htmlPage('<h1>A</h1>'));

    expect(renderFinding(bundle)).toMatchObject({
      severity: 'info',
      detail: 'render skipped: not-requested',
    });
  });
  test('a failed render gates seo-check and audit, but not geo-check', () => {
    const fail = {
      ...renderFinding(bundleFromHtml(htmlPage('<h1>A</h1>'))),
      severity: 'fail' as const,
    };
    expect(kindThresholdStatus('seo', [], [fail])).toBe('fail');
    expect(kindThresholdStatus('geo', [], [fail])).toBe('pass');
  });
  test('the render does not change any score', () => {
    const plain = bundleFromHtml(htmlPage('<h1>A</h1>'));
    const rendered = bundleFromHtml(htmlPage('<h1>A</h1>'));

    rendered.renderedPage = renderedPageFrom(
      htmlPage('<h1>B</h1>', ''),
      rendered.auditedUrl,
      null,
      rendered.auditedPage.internalLinkIndex,
    );

    expect(computeAuditScores(rendered).overall).toBe(computeAuditScores(plain).overall);
    expect(collectFindings(rendered, []).some((f) => f.id === 'discovery:render')).toBe(true);
  });
});
