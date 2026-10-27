import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, expect, test } from 'bun:test';
import {
  auditRequestsLighthouse,
  auditStdoutWaitsForLighthouse,
  lighthouseAuditUrl,
} from '../src/commands/audit.ts';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIT_SOURCE,
  GATHERER_SOURCE,
  appendCapped,
  hostResolverRules,
  lighthouseDestinationAllowed,
  lighthouseKillPid,
  startLighthouse,
  type LighthouseSpawn,
  type LighthouseSpawnOutcome,
} from '../src/engine/lighthouse.ts';

const PIN = '93.184.216.34';

function fakeSpawn(
  outcome: Partial<LighthouseSpawnOutcome>,
  seen?: { command: string; args: readonly string[]; config: string },
): LighthouseSpawn {
  return (command, args) => {
    if (seen) {
      seen.command = command;
      seen.args = args;
      const configArg = args.find((arg) => arg.startsWith('--config-path='));

      seen.config = configArg ? readFileSync(configArg.slice('--config-path='.length), 'utf8') : '';
    }

    return {
      done: Promise.resolve({
        stdout: '',
        stderr: '',
        code: 0,
        signal: null,
        ...outcome,
      }),
      kill() {
        return undefined;
      },
    };
  };
}

function connectStatus(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let data = '';

    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      socket.end();
      resolve(data.split('\r\n')[0] ?? '');
    });
    socket.on('error', reject);
  });
}

describe('lighthouse', () => {
  test('parses metrics and failed performance audits from fake stdout', async () => {
    const audits: Record<string, unknown> = {
      'largest-contentful-paint': {
        numericValue: 2500,
        score: 0.4,
        title: 'LCP',
        displayValue: '2.5 s',
      },
      'cumulative-layout-shift': { score: 1, title: 'CLS', displayValue: '0.1' },
      'total-blocking-time': {
        numericValue: 300,
        score: 0.2,
        title: 'TBT',
        displayValue: '300 ms',
      },
      'first-contentful-paint': { numericValue: 1800, score: 0.8, title: 'FCP' },
      'interaction-to-next-paint': {
        numericValue: 40,
        score: 0.9,
        title: 'INP',
        displayValue: '40 ms',
      },
      unscored: { score: null, title: 'Skip' },
    };
    const auditRefs: { id: string }[] = [
      { id: 'largest-contentful-paint' },
      { id: 'first-contentful-paint' },
      { id: 'cumulative-layout-shift' },
      { id: 'total-blocking-time' },
      { id: 'unscored' },
      { id: 'interaction-to-next-paint' },
    ];

    for (let index = 0; index < 28; index++) {
      const id = `extra-${index}`;

      audits[id] = { score: 0, title: id, displayValue: 'bad' };
      auditRefs.push({ id });
    }

    const stdout = JSON.stringify({
      requestedUrl: 'https://example.com/start',
      finalUrl: 'https://example.com/final',
      categories: { performance: { score: 0.42, auditRefs } },
      audits,
    });
    const seen = { command: '', args: [] as readonly string[], config: '' };
    const report = await startLighthouse('https://example.com/', PIN, fakeSpawn({ stdout }, seen))
      .promise;

    expect(seen.command).toBe('lighthouse');
    expect(seen.args.slice(0, 6)).toEqual([
      'https://example.com/',
      '--output=json',
      '--output-path=stdout',
      '--quiet',
      '--only-categories=performance,seo,best-practices,searchunit',
      '--form-factor=mobile',
    ]);
    expect(seen.args[6]?.startsWith('--config-path=')).toBe(true);
    expect(seen.config).toContain('MAP example.com:443 93.184.216.34:443, MAP * ^NOTFOUND');
    expect(seen.config).toContain('--headless');
    expect(seen.config).toContain('--proxy-server=http://127.0.0.1:');
    expect(seen.config).toContain('--proxy-bypass-list=<-loopback>');
    expect(seen.config).not.toContain('--host-rules=');
    expect(seen.config).toContain('--host-resolver-rules=');
    expect(seen.config).toContain('rendered-main-text');
    expect(seen.config).toContain('searchunit');
    expect(seen.config).toContain(
      '"skipAudits":["network-requests","screenshot-thumbnails","final-screenshot"]',
    );
    expect(seen.config).toContain('"disableFullPageScreenshot":true');
    expect(report.renderedText).toBeNull();
    expect(report.status).toBe('ok');
    expect(report.reason).toBeUndefined();
    expect(report.formFactor).toBe('mobile');
    expect(report.requestedUrl).toBe('https://example.com/start');
    expect(report.finalUrl).toBe('https://example.com/final');
    expect(report.metrics).toEqual({ lcpMs: 2500, tbtMs: 300, fcpMs: 1800, inpMs: 40 });
    expect(report.metrics.inpMs).not.toBe(report.metrics.tbtMs);
    expect(report.failedAudits).toHaveLength(30);
    expect(report.failedAudits[0]).toEqual({
      id: 'largest-contentful-paint',
      category: 'performance',
      title: 'LCP',
      score: 0.4,
      displayValue: '2.5 s',
      items: [],
    });
    expect(report.failedAudits.some((audit) => audit.id === 'cumulative-layout-shift')).toBe(false);
    expect(report.failedAudits.some((audit) => audit.id === 'unscored')).toBe(false);
    expect(report.failedAudits[1]?.displayValue).toBeNull();
    expect(report).not.toHaveProperty('categories');
  });
  test('maps ENOENT to binary-missing and does not start Chrome', async () => {
    const report = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ code: null, errorCode: 'ENOENT', stdout: '' }),
    ).promise;

    expect(report).toEqual({
      status: 'error',
      reason: 'binary-missing',
      formFactor: 'mobile',
      requestedUrl: 'https://example.com/',
      finalUrl: null,
      metrics: {},
      failedAudits: [],
      renderedText: null,
    });
  });
  test('copies rendered main text from the lab audit and ignores a blank one', async () => {
    const withText = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({
        stdout: JSON.stringify({
          requestedUrl: 'https://example.com/',
          finalUrl: 'https://example.com/',
          audits: {
            'rendered-main-text': {
              score: 1,
              details: { type: 'debugdata', items: [{ text: '  Visible after Chrome.  ' }] },
            },
          },
        }),
      }),
    ).promise;
    const blank = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({
        stdout: JSON.stringify({
          requestedUrl: 'https://example.com/',
          finalUrl: 'https://example.com/',
          audits: {
            'rendered-main-text': { score: 1, details: { items: [{ text: '   ' }] } },
          },
        }),
      }),
    ).promise;

    expect(withText.renderedText).toBe('Visible after Chrome.');
    expect(blank.renderedText).toBeNull();
  });
  test('keeps a parsed lab report when the process exits non-zero', async () => {
    const report = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({
        code: 1,
        stdout: JSON.stringify({
          requestedUrl: 'https://example.com/',
          finalUrl: 'https://example.com/',
          audits: { 'largest-contentful-paint': { numericValue: 1000, score: 0.9, title: 'LCP' } },
        }),
      }),
    ).promise;

    expect(report.status).toBe('ok');
    expect(report.metrics.lcpMs).toBe(1000);
    expect(report.renderedText).toBeNull();
  });
  test('maps a chrome-not-found stderr and a timeout', async () => {
    const missing = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ code: 1, stderr: 'ChromeNotInstalledError: No Chrome installations found.' }),
    ).promise;
    const timedOut = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ timedOut: true, code: null }),
    ).promise;

    expect(missing.reason).toBe('chrome-missing');
    expect(missing.status).toBe('error');
    expect(timedOut.reason).toBe('timeout');
    expect(timedOut.status).toBe('error');
  });
  test('drops a final URL on another host and an oversized lab buffer', async () => {
    const redirected = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({
        stdout: JSON.stringify({
          requestedUrl: 'https://example.com/',
          finalUrl: 'http://169.254.169.254/latest',
          categories: { performance: { auditRefs: [] } },
          audits: {},
        }),
      }),
    ).promise;
    const overflow = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ overflow: true, code: 0, stdout: '{}' }),
    ).promise;

    expect(redirected.status).toBe('error');
    expect(redirected.finalUrl).toBeNull();
    expect(overflow.status).toBe('error');
    expect(overflow.reason).toBe('error');
  });
  test('retries once after a crash, and not after a missing binary', async () => {
    const outcomes: Partial<LighthouseSpawnOutcome>[] = [
      { code: 1, stdout: '', stderr: 'Runtime error encountered' },
      {
        stdout: JSON.stringify({
          requestedUrl: 'https://example.com/',
          finalUrl: 'https://example.com/',
          categories: { performance: { auditRefs: [] } },
          audits: {},
        }),
      },
    ];
    let calls = 0;
    const flaky: LighthouseSpawn = (command, args) =>
      fakeSpawn(outcomes[calls++] ?? {})(command, args);
    const recovered = await startLighthouse('https://example.com/', PIN, flaky).promise;
    let missingCalls = 0;
    const missing: LighthouseSpawn = (command, args) => {
      missingCalls++;

      return fakeSpawn({ code: null, errorCode: 'ENOENT' })(command, args);
    };
    await startLighthouse('https://example.com/', PIN, missing).promise;
    expect(calls).toBe(2);
    expect(recovered.status).toBe('ok');
    expect(missingCalls).toBe(1);
  });
  test('does not spawn when the pin cannot be applied', async () => {
    let called = false;
    const report = await startLighthouse('https://example.com/', ' ', () => {
      called = true;

      return {
        done: Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null }),
        kill() {
          return undefined;
        },
      };
    }).promise;

    expect(called).toBe(false);
    expect(report.status).toBe('error');
    expect(hostResolverRules('https://example.com/', PIN)).toBe(
      'MAP example.com:443 93.184.216.34:443, MAP * ^NOTFOUND',
    );
    expect(hostResolverRules('http://example.com/path', '2001:db8::1')).toBe(
      'MAP example.com:80 [2001:db8::1]:80, MAP * ^NOTFOUND',
    );
    expect(appendCapped('abc', 'def', 4)).toEqual({ text: 'abcd', overflow: true });
    expect(lighthouseKillPid(12)).toBe(process.platform === 'win32' ? 12 : -12);
    expect(lighthouseDestinationAllowed('example.com', '443', 'example.com', PIN, '443')).toBe(
      true,
    );
    expect(lighthouseDestinationAllowed(PIN, '443', 'example.com', PIN, '443')).toBe(true);
    expect(lighthouseDestinationAllowed('169.254.169.254', '80', 'example.com', PIN, '443')).toBe(
      false,
    );
    expect(lighthouseDestinationAllowed('example.com', '80', 'example.com', PIN, '443')).toBe(
      false,
    );
  });
  test('the pin proxy refuses a CONNECT to an IP literal', async () => {
    let status = '';

    await startLighthouse('https://example.com/', PIN, (_command, args) => {
      const configArg = args.find((arg) => arg.startsWith('--config-path='));
      const config = configArg
        ? readFileSync(configArg.slice('--config-path='.length), 'utf8')
        : '';
      const port = Number(config.match(/127\.0\.0\.1:(\d+)/)?.[1]);

      return {
        done: connectStatus(port, '169.254.169.254:80').then((line) => {
          status = line;

          return { stdout: '', stderr: '', code: 0, signal: null };
        }),
        kill() {
          return undefined;
        },
      };
    }).promise;

    expect(status.startsWith('HTTP/1.1 403')).toBe(true);
  });
});

describe('audit lighthouse wait', () => {
  test('human stdout does not wait unless -o is set; agent and json wait', () => {
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'table', outputPath: undefined }),
    ).toBe(false);
    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'table' })).toBe(false);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'html', outputPath: undefined }),
    ).toBe(false);
    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'html' })).toBe(false);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'html', outputPath: 'out.json' }),
    ).toBe(true);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'table', outputPath: 'report.md' }),
    ).toBe(false);
    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'html' })).toBe(false);
    expect(auditStdoutWaitsForLighthouse({ agent: true, outFormat: 'table' })).toBe(true);
    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'json' })).toBe(true);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'json', outputPath: undefined }),
    ).toBe(true);
    expect(lighthouseAuditUrl('https://example.com/', 'https://www.example.com/')).toBe(
      'https://www.example.com/',
    );
  });
});

function loadCjs(name: string, source: string): any {
  const path = join(mkdtempSync(join(tmpdir(), 'su-lh-src-')), name);

  writeFileSync(path, source);

  return createRequire(import.meta.url)(path);
}

describe('generated Lighthouse plugin sources', () => {
  test('the gatherer has every Lighthouse 12 phase method and reads text through evaluateAsync', async () => {
    const Gatherer = loadCjs('gatherer.cjs', GATHERER_SOURCE);
    const gatherer = new Gatherer();

    for (const phase of [
      'startInstrumentation',
      'startSensitiveInstrumentation',
      'stopSensitiveInstrumentation',
      'stopInstrumentation',
      'getArtifact',
    ]) {
      expect(typeof gatherer[phase]).toBe('function');
    }

    const driver = { executionContext: { evaluateAsync: async () => 'Rendered text' } };

    expect(await gatherer.getArtifact({ driver })).toBe('Rendered text');
  });
  test('the audit is informative, so Lighthouse does not require a failureTitle', () => {
    const Audit = loadCjs('audit.cjs', AUDIT_SOURCE);

    expect(Audit.meta.scoreDisplayMode).toBe('informative');
    expect(Audit.audit({ RenderedMainText: 'x' }).details.items[0].text).toBe('x');
  });
});
