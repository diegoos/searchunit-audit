import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, expect, test } from 'bun:test';
import {
  auditRequestsLighthouse,
  auditStdoutWaitsForLighthouse,
  lighthouseAuditUrl,
  skipNotes,
} from '../src/commands/audit.ts';
import { appendCapped } from '../src/engine/childProcess.ts';
import { hostResolverRules, pinnedDestinationAllowed } from '../src/engine/pinnedChrome.ts';
import { unrenderedPage } from '../src/engine/render.ts';
import {
  skippedLighthouse,
  startLighthouse,
  type LighthouseReport,
  type LighthouseSpawn,
  type LighthouseSpawnOutcome,
} from '../src/engine/lighthouse.ts';

const PIN = '93.184.216.34';
const CONFIG_FLAG = '--config-path=';

function fakeSpawn(
  outcome: Partial<LighthouseSpawnOutcome>,
  seen?: { command: string; args: readonly string[]; config: string },
): LighthouseSpawn {
  return (command, args) => {
    if (seen) {
      seen.command = command;
      seen.args = args;

      const configArg = args.find((arg) => arg.startsWith(CONFIG_FLAG));

      seen.config = configArg ? readFileSync(configArg.slice(CONFIG_FLAG.length), 'utf8') : '';
    }

    return {
      done: Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, ...outcome }),
      kill() {
        return undefined;
      },
    };
  };
}

function labJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    categories: { performance: { auditRefs: [] } },
    audits: {},
    ...over,
  });
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

describe('lighthouse lab run', () => {
  test('parses lab metrics, failed performance audits and the spawn arguments', async () => {
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
      'largest-contentful-paint',
      'first-contentful-paint',
      'cumulative-layout-shift',
      'total-blocking-time',
      'unscored',
      'interaction-to-next-paint',
    ].map((id) => ({ id }));

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
      '--only-categories=performance,seo,best-practices',
      '--form-factor=mobile',
    ]);
    expect(seen.args[6]?.startsWith(CONFIG_FLAG)).toBe(true);

    // The pin keeps Chrome on the audited host and blocks every other name.
    expect(seen.config).toContain('MAP example.com:443 93.184.216.34:443, MAP * ^NOTFOUND');
    expect(seen.config).toContain('--proxy-server=http://127.0.0.1:');
    expect(seen.config).toContain('--proxy-bypass-list=<-loopback>');
    expect(seen.config).toContain('--host-resolver-rules=');
    expect(seen.config).not.toContain('--host-rules=');

    expect(report).toMatchObject({
      status: 'ok',
      formFactor: 'mobile',
      requestedUrl: 'https://example.com/start',
      finalUrl: 'https://example.com/final',
      metrics: { lcpMs: 2500, tbtMs: 300, fcpMs: 1800, inpMs: 40 },
    });
    expect(report).not.toHaveProperty('categories');
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
  });
  test('a missing lighthouse binary maps to binary-missing', async () => {
    const report = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ code: null, errorCode: 'ENOENT', stdout: '' }),
    ).promise;

    expect(report).toEqual({
      status: 'skipped',
      reason: 'binary-missing',
      install: 'npm install -g lighthouse',
      formFactor: 'mobile',
      requestedUrl: 'https://example.com/',
      finalUrl: null,
      metrics: {},
      failedAudits: [],
    });
  });
  test('keeps a parsed lab report when the process exits non-zero', async () => {
    const report = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({
        code: 1,
        stdout: labJson({
          audits: { 'largest-contentful-paint': { numericValue: 1000, score: 0.9, title: 'LCP' } },
        }),
      }),
    ).promise;

    expect(report.status).toBe('ok');
    expect(report.metrics.lcpMs).toBe(1000);
  });
  test('a missing Chrome is skipped and a timeout is an error', async () => {
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

    expect(missing).toMatchObject({
      status: 'skipped',
      reason: 'chrome-missing',
      install: 'Install Google Chrome, or set CHROME_PATH',
    });
    expect(timedOut).toMatchObject({ status: 'error', reason: 'timeout', install: null });
  });
  test('a final URL on another host is dropped, and an oversized lab buffer is an error', async () => {
    const redirected = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ stdout: labJson({ finalUrl: 'http://169.254.169.254/latest' }) }),
    ).promise;
    const overflow = await startLighthouse(
      'https://example.com/',
      PIN,
      fakeSpawn({ overflow: true, code: 0, stdout: '{}' }),
    ).promise;

    expect(redirected).toMatchObject({ status: 'error', finalUrl: null });
    expect(overflow).toMatchObject({ status: 'error', reason: 'error' });
  });
  test('retries once after a crash, and not after a missing binary', async () => {
    const outcomes: Partial<LighthouseSpawnOutcome>[] = [
      { code: 1, stdout: '', stderr: 'Runtime error encountered' },
      { stdout: labJson() },
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
  test('does not spawn Chrome without a usable pin', async () => {
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
  });
  test('the pin proxy refuses a CONNECT to an IP literal', async () => {
    let status = '';

    await startLighthouse('https://example.com/', PIN, (_command, args) => {
      const configArg = args.find((arg) => arg.startsWith(CONFIG_FLAG));
      const config = configArg ? readFileSync(configArg.slice(CONFIG_FLAG.length), 'utf8') : '';
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

describe('lighthouse helpers', () => {
  test('hostResolverRules maps the audited host to the pinned address, IPv6 included', () => {
    expect(hostResolverRules('https://example.com/', PIN)).toBe(
      'EXCLUDE 127.0.0.1, MAP example.com:443 93.184.216.34:443, MAP * ^NOTFOUND',
    );
    expect(hostResolverRules('http://example.com/path', '2001:db8::1')).toBe(
      'EXCLUDE 127.0.0.1, MAP example.com:80 [2001:db8::1]:80, MAP * ^NOTFOUND',
    );
  });
  test('hostResolverRules refuses a non-URL, a URL without a host, or a malformed pinned address', () => {
    expect(hostResolverRules('not a url', PIN)).toBeNull();
    expect(hostResolverRules('mailto:someone@example.com', PIN)).toBeNull();
    expect(hostResolverRules('https://example.com/', '  ')).toBeNull();
    expect(hostResolverRules('https://example.com/', '127.0.0.1, 10.0.0.1')).toBeNull();
  });
  test('appendCapped marks overflow past the cap', () => {
    expect(appendCapped('abc', 'def', 4)).toEqual({ text: 'abcd', overflow: true });
  });
  test.each([
    ['the audited host on its port', 'example.com', '443', true],
    ['the pinned address', PIN, '443', true],
    ['another host', '169.254.169.254', '80', false],
    ['the audited host on another port', 'example.com', '80', false],
  ])('destination allowed for %s: %p', (_name, host, port, allowed) => {
    expect(pinnedDestinationAllowed(host, port, 'example.com', PIN, '443')).toBe(allowed);
  });
});

describe('audit skip notes', () => {
  const missingLab: LighthouseReport = {
    ...skippedLighthouse('https://example.com/'),
    reason: 'binary-missing',
    install: 'npm install -g lighthouse',
  };
  const render = unrenderedPage('chrome-missing');
  const human = { silent: false, outFormat: 'table' as const, agent: false };

  test('a missing lighthouse and Chrome each get one note with the install hint', () => {
    expect(skipNotes(missingLab, render, human)).toEqual([
      'Lighthouse lab skipped: lighthouse is not on PATH. Install it with: npm install -g lighthouse',
      'Chrome render skipped: Chrome not found. Install Google Chrome, or set CHROME_PATH',
    ]);
  });
  test('--silent and machine output print no note', () => {
    expect(skipNotes(missingLab, render, { ...human, silent: true })).toEqual([]);
    expect(skipNotes(missingLab, render, { ...human, agent: true })).toEqual([]);
    expect(skipNotes(missingLab, render, { ...human, outFormat: 'json' })).toEqual([]);
  });
  test('a skip without an install hint prints no note', () => {
    expect(
      skipNotes(skippedLighthouse('https://example.com/'), unrenderedPage('not-requested'), human),
    ).toEqual([]);
  });
});

describe('audit lighthouse wait', () => {
  test('human stdout waits only when -o asks for a .json file or the output is json', () => {
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'table', outputPath: undefined }),
    ).toBe(false);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'html', outputPath: 'out.json' }),
    ).toBe(true);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'table', outputPath: 'report.md' }),
    ).toBe(false);
    expect(
      auditRequestsLighthouse({ agent: false, outFormat: 'json', outputPath: undefined }),
    ).toBe(true);

    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'table' })).toBe(false);
    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'html' })).toBe(false);
    expect(auditStdoutWaitsForLighthouse({ agent: true, outFormat: 'table' })).toBe(true);
    expect(auditStdoutWaitsForLighthouse({ agent: false, outFormat: 'json' })).toBe(true);
  });
  test('the audited URL is kept as the lighthouse target', () => {
    expect(lighthouseAuditUrl('https://example.com/', 'https://www.example.com/')).toBe(
      'https://www.example.com/',
    );
  });
});

describe('lighthouse lab profile', () => {
  test('the config has no custom gatherer or rendered-text category', async () => {
    const seen = { command: '', args: [] as readonly string[], config: '' };

    await startLighthouse('https://example.com/', PIN, fakeSpawn({ stdout: labJson() }, seen))
      .promise;

    expect(seen.config).toContain('--headless');
    expect(seen.config).not.toContain('gatherer');
    expect(seen.config).not.toContain('searchunit');
  });
});
