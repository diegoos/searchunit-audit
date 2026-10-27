import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const LIGHTHOUSE_TIMEOUT_MS = 120_000;
const FAILED_AUDIT_CAP = 30;
const AUDIT_ITEM_CAP = 10;
const AUDIT_SNIPPET_CAP = 200;
/** Categories read for failed audits. Their scores come from the same lab run. */
const AUDIT_CATEGORIES = ['performance', 'seo', 'best-practices'] as const;
/** Informative audit (no score). Kept when it names an element. */
const LCP_ELEMENT_AUDIT = 'largest-contentful-paint-element';
const LIGHTHOUSE_OUTPUT_CAP = 8 * 1024 * 1024;
const RENDERED_TEXT_CAP = 8000;

const METRIC_FIELDS = {
  'largest-contentful-paint': 'lcpMs',
  'cumulative-layout-shift': 'cls',
  'total-blocking-time': 'tbtMs',
  'first-contentful-paint': 'fcpMs',
  'interaction-to-next-paint': 'inpMs',
} as const;

type MetricField = (typeof METRIC_FIELDS)[keyof typeof METRIC_FIELDS];

export type LighthouseReason =
  | 'not-requested'
  | 'binary-missing'
  | 'chrome-missing'
  | 'timeout'
  | 'error';

export interface LighthouseMetrics {
  lcpMs?: number;
  cls?: number;
  tbtMs?: number;
  fcpMs?: number;
  inpMs?: number;
}

export interface LighthouseAuditNode {
  selector: string;
  snippet: string;
  nodeLabel: string | null;
}

/** One row of an audit's `details.items`. Only rows with a URL or a DOM node are kept. */
export interface LighthouseAuditItem {
  url: string | null;
  node: LighthouseAuditNode | null;
  wastedMs: number | null;
  wastedBytes: number | null;
  totalBytes: number | null;
  /** `total` (ms) on bootup-time rows. */
  totalMs: number | null;
}

export interface LighthouseFailedAudit {
  id: string;
  category: (typeof AUDIT_CATEGORIES)[number];
  title: string;
  /** Null only for the informative LCP element audit. */
  score: number | null;
  displayValue: string | null;
  /** At most 10 rows, in Lighthouse order. */
  items: LighthouseAuditItem[];
}

export interface LighthouseReport {
  status: 'ok' | 'skipped' | 'error';
  reason?: LighthouseReason;
  formFactor: 'mobile';
  requestedUrl: string;
  finalUrl: string | null;
  metrics: LighthouseMetrics;
  failedAudits: LighthouseFailedAudit[];
  renderedText: string | null;
}

export interface LighthouseSpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  timedOut?: boolean;
  overflow?: boolean;
}

export interface LighthouseSpawnHandle {
  done: Promise<LighthouseSpawnOutcome>;
  kill: () => void;
}

export type LighthouseSpawn = (command: string, args: readonly string[]) => LighthouseSpawnHandle;

export interface LighthouseHandle {
  promise: Promise<LighthouseReport>;
  kill: () => void;
}

export function skippedLighthouse(requestedUrl: string): LighthouseReport {
  return {
    status: 'skipped',
    reason: 'not-requested',
    formFactor: 'mobile',
    requestedUrl,
    finalUrl: null,
    metrics: {},
    failedAudits: [],
    renderedText: null,
  };
}

function lighthouseFailure(requestedUrl: string, reason: LighthouseReason): LighthouseReport {
  return {
    status: 'error',
    reason,
    formFactor: 'mobile',
    requestedUrl,
    finalUrl: null,
    metrics: {},
    failedAudits: [],
    renderedText: null,
  };
}

/** Hop refused. Chrome does not start, and the audit still exits on discovery. */
export function refusedLighthouse(requestedUrl: string): LighthouseHandle {
  return {
    promise: Promise.resolve(lighthouseFailure(requestedUrl, 'error')),
    kill() {
      return undefined;
    },
  };
}

/**
 * First matching rule wins. `^NOTFOUND` fails DNS names in the host resolver.
 * IP literals skip that resolver. The loopback proxy is what refuses them.
 */
export function hostResolverRules(pageUrl: string, pinnedAddress: string): string | null {
  let url: URL;

  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }

  const address = pinnedAddress.trim();
  const host = url.hostname;

  if (!address || !host || /[\s,]/.test(address) || /[\s,]/.test(host)) {
    return null;
  }

  const port = url.port || (url.protocol === 'http:' ? '80' : '443');
  const replacement = address.includes(':') ? `[${address}]` : address;

  return `MAP ${host}:${port} ${replacement}:${port}, MAP * ^NOTFOUND`;
}

/** True when Chrome may dial this host. The socket still uses the pinned address. */
export function lighthouseDestinationAllowed(
  requestHost: string,
  requestPort: string,
  pageHost: string,
  pinnedAddress: string,
  pinnedPort: string,
): boolean {
  if (requestPort !== pinnedPort) {
    return false;
  }

  const host = requestHost.replace(/^\[|\]$/g, '').toLowerCase();

  return host === pageHost.toLowerCase() || host === pinnedAddress.toLowerCase();
}

function connectAuthority(authority: string): { host: string; port: string } | null {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');

    if (end < 0 || authority[end + 1] !== ':') {
      return null;
    }

    return { host: authority.slice(1, end), port: authority.slice(end + 2) };
  }

  const colon = authority.lastIndexOf(':');

  if (colon <= 0) {
    return null;
  }

  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

interface PinProxy {
  port: number;
  close: () => void;
}

function openPinProxy(pageUrl: string, pinnedAddress: string): Promise<PinProxy> {
  const page = new URL(pageUrl);
  const pinnedPort = page.port || (page.protocol === 'http:' ? '80' : '443');
  const pageHost = page.hostname;
  const sockets = new Set<{ destroy: () => void }>();
  const server = http.createServer((req, res) => {
    let target: URL;

    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(403);
      res.end();

      return;
    }

    const port = target.port || '80';
    const allowed =
      target.protocol === 'http:' &&
      lighthouseDestinationAllowed(target.hostname, port, pageHost, pinnedAddress, pinnedPort);

    if (!allowed) {
      res.writeHead(403);
      res.end();

      return;
    }

    const upstream = http.request(
      {
        host: pinnedAddress,
        port: Number(pinnedPort),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }

      res.end();
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, clientSocket, head) => {
    const parsed = connectAuthority(req.url ?? '');
    const allowed =
      parsed !== null &&
      lighthouseDestinationAllowed(parsed.host, parsed.port, pageHost, pinnedAddress, pinnedPort);

    if (!allowed) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');

      return;
    }

    const upstream = net.connect(Number(pinnedPort), pinnedAddress);

    sockets.add(upstream);
    sockets.add(clientSocket);
    upstream.on('error', () => {
      clientSocket.destroy();
    });
    clientSocket.on('error', () => {
      upstream.destroy();
    });
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head.length > 0) {
        upstream.write(head);
      }

      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('lighthouse proxy did not bind'));

        return;
      }

      resolve({
        port: address.port,
        close() {
          for (const socket of sockets) {
            socket.destroy();
          }

          server.close();
        },
      });
    });
  });
}

function endpointHost(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** Pid to signal. Negative on POSIX so the Chrome child dies with lighthouse. */
export function lighthouseKillPid(childPid: number): number {
  return process.platform === 'win32' ? childPid : -childPid;
}

export function appendCapped(
  current: string,
  chunk: string,
  cap = LIGHTHOUSE_OUTPUT_CAP,
): { text: string; overflow: boolean } {
  if (current.length >= cap) {
    return { text: current, overflow: true };
  }

  const next = current + chunk;

  if (next.length <= cap) {
    return { text: next, overflow: false };
  }

  return { text: next.slice(0, cap), overflow: true };
}

const RENDERED_TEXT_EXPRESSION = `(() => {
  const root = document.querySelector('main, [role="main"], article') || document.body;
  if (!root || typeof root.innerText !== 'string') return '';
  return root.innerText.replace(/\\s+/g, ' ').trim().slice(0, ${RENDERED_TEXT_CAP});
})()`;

/** CommonJS source of the Lighthouse gatherer that reads rendered main text. */
export const GATHERER_SOURCE = `'use strict';
class RenderedMainText {
  meta = { supportedModes: ['snapshot', 'navigation'] };

  // Lighthouse 12 calls every phase method on a gatherer, not only getArtifact.
  async startInstrumentation() {}
  async startSensitiveInstrumentation() {}
  async stopSensitiveInstrumentation() {}
  async stopInstrumentation() {}

  async getArtifact(context) {
    try {
      return await readText(context && context.driver);
    } catch {
      return '';
    }
  }
}

async function readText(driver) {
  const expression = ${JSON.stringify(RENDERED_TEXT_EXPRESSION)};

  if (!driver) return '';

  const context = driver.executionContext;

  // Lighthouse 12: evaluate() takes a function; a string expression needs evaluateAsync().
  if (context && typeof context.evaluateAsync === 'function') {
    const value = await context.evaluateAsync(expression);
    return typeof value === 'string' ? value : '';
  }

  if (typeof driver.evaluate === 'function') {
    const value = await driver.evaluate(expression, { args: [] });
    return typeof value === 'string' ? value : '';
  }

  const execution = driver.executionContext;

  if (execution && typeof execution.evaluate === 'function') {
    const value = await execution.evaluate(expression, { args: [] });
    return typeof value === 'string' ? value : '';
  }

  const session = driver.defaultSession;

  if (session && typeof session.sendCommand === 'function') {
    const response = await session.sendCommand('Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
    });
    const value = response && response.result && response.result.value;
    return typeof value === 'string' ? value : '';
  }

  return '';
}

module.exports = RenderedMainText;
`;

/** CommonJS source of the Lighthouse audit that exposes that text. */
export const AUDIT_SOURCE = `'use strict';
class RenderedMainTextAudit {
  static get meta() {
    return {
      id: 'rendered-main-text',
      title: 'Rendered main text',
      description: 'Main text after Chrome rendered the page.',
      scoreDisplayMode: 'informative',
      requiredArtifacts: ['RenderedMainText'],
    };
  }

  static audit(artifacts) {
    const text = typeof artifacts.RenderedMainText === 'string' ? artifacts.RenderedMainText : '';
    return { score: null, details: { type: 'debugdata', items: [{ text }] } };
  }
}

module.exports = RenderedMainTextAudit;
`;

function writePinConfig(rules: string, proxyPort: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'searchunit-lh-'));
  const gathererPath = join(dir, 'gatherer.cjs');
  const auditPath = join(dir, 'audit.cjs');
  const path = join(dir, 'config.cjs');
  const settings = {
    extends: 'lighthouse:default',
    settings: {
      onlyCategories: ['performance', 'seo', 'best-practices', 'searchunit'],
      formFactor: 'mobile',
      // Raw request lists and screenshots are megabytes the CLI never reads. On ad-heavy pages
      // they pushed the JSON past LIGHTHOUSE_OUTPUT_CAP, and the lab ended in `error`.
      disableFullPageScreenshot: true,
      skipAudits: ['network-requests', 'screenshot-thumbnails', 'final-screenshot'],
      chromeFlags: [
        '--headless',
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        '--proxy-bypass-list=<-loopback>',
        `--host-resolver-rules=${rules}`,
      ],
    },
    artifacts: [{ id: 'RenderedMainText', gatherer: { path: gathererPath } }],
    audits: [auditPath],
    categories: {
      searchunit: {
        title: 'SearchUnit',
        description: 'Rendered main text from this Chrome run.',
        auditRefs: [{ id: 'rendered-main-text', weight: 0 }],
      },
    },
  };
  writeFileSync(gathererPath, GATHERER_SOURCE);
  writeFileSync(auditPath, AUDIT_SOURCE);
  writeFileSync(path, `module.exports = ${JSON.stringify(settings)};\n`);

  return path;
}

function lighthouseArgs(url: string, configPath: string): string[] {
  return [
    url,
    '--output=json',
    '--output-path=stdout',
    '--quiet',
    '--only-categories=performance,seo,best-practices,searchunit',
    '--form-factor=mobile',
    `--config-path=${configPath}`,
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function readMetrics(audits: Record<string, unknown>): LighthouseMetrics {
  const metrics: LighthouseMetrics = {};

  for (const [auditId, field] of Object.entries(METRIC_FIELDS) as [string, MetricField][]) {
    const value = finiteNumber(asRecord(audits[auditId])?.numericValue);

    if (value !== null) {
      metrics[field] = value;
    }
  }

  return metrics;
}

function readRenderedText(audits: Record<string, unknown>): string | null {
  const details = asRecord(asRecord(audits['rendered-main-text'])?.details);
  const items = details?.items;
  const text = Array.isArray(items) ? asRecord(items[0])?.text : null;

  if (typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim().slice(0, RENDERED_TEXT_CAP);

  return trimmed.length > 0 ? trimmed : null;
}

function categoryAuditIds(lhr: Record<string, unknown>, category: string): string[] {
  const refs = asRecord(asRecord(lhr.categories)?.[category])?.auditRefs;

  if (!Array.isArray(refs)) {
    return [];
  }

  return refs.map((ref) => asRecord(ref)?.id).filter((id): id is string => typeof id === 'string');
}

function nodeOf(value: unknown): LighthouseAuditNode | null {
  const node = asRecord(value);

  if (typeof node?.selector !== 'string') {
    return null;
  }

  return {
    selector: node.selector,
    snippet: typeof node.snippet === 'string' ? node.snippet.slice(0, AUDIT_SNIPPET_CAP) : '',
    nodeLabel: typeof node.nodeLabel === 'string' ? node.nodeLabel : null,
  };
}

function auditItem(row: Record<string, unknown>): LighthouseAuditItem | null {
  const url = typeof row.url === 'string' ? row.url : null;
  const node = nodeOf(row.node);

  if (url === null && node === null) {
    return null;
  }

  return {
    url,
    node,
    wastedMs: finiteNumber(row.wastedMs),
    wastedBytes: finiteNumber(row.wastedBytes),
    totalBytes: finiteNumber(row.totalBytes),
    totalMs: finiteNumber(row.total),
  };
}

/** Rows of `details.items`. The LCP element list nests its nodes one level down. */
function auditRows(audit: Record<string, unknown> | null): Record<string, unknown>[] {
  const items = asRecord(audit?.details)?.items;

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .flatMap((entry) => {
      const nested = asRecord(entry)?.items;

      return Array.isArray(nested) ? nested : [entry];
    })
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
}

function auditItems(audit: Record<string, unknown> | null): LighthouseAuditItem[] {
  return auditRows(audit)
    .map(auditItem)
    .filter((item): item is LighthouseAuditItem => item !== null)
    .slice(0, AUDIT_ITEM_CAP);
}

function failedAuditFrom(
  id: string,
  audit: Record<string, unknown> | null,
  category: LighthouseFailedAudit['category'],
): LighthouseFailedAudit | null {
  const score = finiteNumber(audit?.score);
  const items = auditItems(audit);
  const failed = score !== null && score < 1;
  const namesElement = id === LCP_ELEMENT_AUDIT && items.length > 0;

  if (!failed && !namesElement) {
    return null;
  }

  const title = audit?.title;
  const displayValue = audit?.displayValue;

  return {
    id,
    category,
    title: typeof title === 'string' ? title : id,
    score,
    displayValue: typeof displayValue === 'string' ? displayValue : null,
    items,
  };
}

function readFailedAudits(lhr: Record<string, unknown>): LighthouseFailedAudit[] {
  const audits = asRecord(lhr.audits) ?? {};
  const seen = new Set<string>();

  return AUDIT_CATEGORIES.flatMap((category) => {
    const failed: LighthouseFailedAudit[] = [];

    for (const id of categoryAuditIds(lhr, category)) {
      if (failed.length >= FAILED_AUDIT_CAP) {
        break;
      }

      if (seen.has(id)) {
        continue;
      }

      seen.add(id);

      const failedAudit = failedAuditFrom(id, asRecord(audits[id]), category);

      if (failedAudit) {
        failed.push(failedAudit);
      }
    }

    return failed;
  });
}

function parseLighthouseStdout(stdout: string, requestedUrl: string): LighthouseReport | null {
  let json: unknown;

  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }

  const lhr = asRecord(json);

  if (!lhr) {
    return null;
  }

  const reportedUrl = lhr.requestedUrl;
  const finalUrl = lhr.finalUrl;
  const final = typeof finalUrl === 'string' ? finalUrl : null;
  const requestedHost = endpointHost(requestedUrl);
  const audits = asRecord(lhr.audits) ?? {};

  if (final && endpointHost(final) !== requestedHost) {
    return lighthouseFailure(requestedUrl, 'error');
  }

  return {
    status: 'ok',
    formFactor: 'mobile',
    requestedUrl: typeof reportedUrl === 'string' ? reportedUrl : requestedUrl,
    finalUrl: final,
    metrics: readMetrics(audits),
    failedAudits: readFailedAudits(lhr),
    renderedText: readRenderedText(audits),
  };
}

function stderrSaysChromeMissing(stderr: string): boolean {
  return /no chrome installations found|chrome installation not found|chrome not found|cannot find chrome|could not find chrome/i.test(
    stderr,
  );
}

function classifyLighthouseOutcome(
  outcome: LighthouseSpawnOutcome,
  requestedUrl: string,
): LighthouseReport {
  if (outcome.overflow) {
    return lighthouseFailure(requestedUrl, 'error');
  }

  if (outcome.timedOut) {
    return lighthouseFailure(requestedUrl, 'timeout');
  }

  if (outcome.errorCode === 'ENOENT') {
    return lighthouseFailure(requestedUrl, 'binary-missing');
  }

  if (stderrSaysChromeMissing(outcome.stderr)) {
    return lighthouseFailure(requestedUrl, 'chrome-missing');
  }

  if (outcome.code !== 0) {
    const parsed = parseLighthouseStdout(outcome.stdout, requestedUrl);

    if (parsed?.status === 'ok') {
      return parsed;
    }

    return lighthouseFailure(requestedUrl, 'error');
  }

  return (
    parseLighthouseStdout(outcome.stdout, requestedUrl) ?? lighthouseFailure(requestedUrl, 'error')
  );
}

function safeKill(child: ChildProcess): void {
  const pid = child.pid;

  if (pid === undefined) {
    return;
  }

  try {
    process.kill(lighthouseKillPid(pid), 'SIGKILL');
  } catch (err) {
    if (err instanceof Error) {
      return;
    }

    throw err;
  }
}

function collectChild(
  child: ChildProcess,
  resolve: (outcome: LighthouseSpawnOutcome) => void,
): void {
  let stdout = '';
  let stderr = '';
  let errorCode: string | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;

  const finish = (outcome: LighthouseSpawnOutcome): void => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);
    resolve(outcome);
  };
  const take = (current: string, chunk: string): string => {
    const next = appendCapped(current, chunk);

    if (next.overflow) {
      safeKill(child);
      finish({
        stdout,
        stderr,
        code: null,
        signal: 'SIGKILL',
        errorCode,
        timedOut: false,
        overflow: true,
      });
    }

    return next.text;
  };
  timer = setTimeout(() => {
    safeKill(child);
    finish({
      stdout,
      stderr,
      code: null,
      signal: 'SIGKILL',
      errorCode,
      timedOut: true,
    });
  }, LIGHTHOUSE_TIMEOUT_MS);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout = take(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr = take(stderr, chunk);
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    errorCode = err.code;

    if (err.code === 'ENOENT') {
      finish({ stdout, stderr, code: null, signal: null, errorCode, timedOut: false });
    }
  });
  child.on('close', (code, signal) => {
    finish({ stdout, stderr, code, signal, errorCode, timedOut: false });
  });
}

function defaultLighthouseSpawn(command: string, args: readonly string[]): LighthouseSpawnHandle {
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  return {
    done: new Promise((resolve) => {
      collectChild(child, resolve);
    }),
    kill() {
      safeKill(child);
    },
  };
}

function noop(): void {
  return undefined;
}

/** Spawns the `lighthouse` binary pinned to `pinnedAddress`. A lab failure stays on the report. */
/** Lab runs per audit: one retry when Chrome or Lighthouse crashes on a heavy page. */
const LIGHTHOUSE_ATTEMPTS = 2;

/**
 * A crash (non-zero exit with no usable report) is worth one retry. A missing
 * binary or Chrome, a timeout, an output overflow, or a parsed report is not.
 */
function isTransientLabFailure(outcome: LighthouseSpawnOutcome, report: LighthouseReport): boolean {
  return (
    report.status === 'error' &&
    report.reason === 'error' &&
    outcome.code !== 0 &&
    !outcome.overflow &&
    !outcome.timedOut &&
    outcome.errorCode === undefined
  );
}

export function startLighthouse(
  url: string,
  pinnedAddress: string,
  spawnImpl: LighthouseSpawn = defaultLighthouseSpawn,
): LighthouseHandle {
  const rules = hostResolverRules(url, pinnedAddress);

  if (!rules) {
    return refusedLighthouse(url);
  }

  let closeProxy = noop;
  let killSpawn = noop;
  let stopped = false;
  const promise = (async (): Promise<LighthouseReport> => {
    let configPath: string | undefined;

    try {
      const proxy = await openPinProxy(url, pinnedAddress);

      closeProxy = proxy.close;

      if (stopped) {
        return lighthouseFailure(url, 'error');
      }

      configPath = writePinConfig(rules, proxy.port);
      let report = lighthouseFailure(url, 'error');

      for (let attempt = 1; attempt <= LIGHTHOUSE_ATTEMPTS; attempt++) {
        // kill() sets `stopped` from outside this loop.
        if (stopped) {
          break;
        }

        const spawned = spawnImpl('lighthouse', lighthouseArgs(url, configPath));

        killSpawn = () => {
          spawned.kill();
        };
        const outcome = await spawned.done;

        report = classifyLighthouseOutcome(outcome, url);

        if (!isTransientLabFailure(outcome, report)) {
          break;
        }
      }

      return report;
    } finally {
      closeProxy();

      if (configPath) {
        rmSync(dirname(configPath), { recursive: true, force: true });
      }
    }
  })().catch(() => lighthouseFailure(url, 'error'));

  return {
    promise,
    kill() {
      stopped = true;
      closeProxy();

      try {
        killSpawn();
      } catch (err) {
        if (err instanceof Error) {
          return;
        }

        throw err;
      }
    },
  };
}
