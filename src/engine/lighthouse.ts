import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  spawnCapped,
  type ProcessHandle,
  type ProcessOutcome,
  type ProcessSpawn,
} from './childProcess.ts';
import { CHROME_INSTALL, LIGHTHOUSE_INSTALL } from './installHints.ts';
import { hostResolverRules, openPinProxy, pinnedChromeFlags } from './pinnedChrome.ts';
import { asRecord } from '../lib/guards.ts';

const LIGHTHOUSE_TIMEOUT_MS = 120_000;
const LIGHTHOUSE_OUTPUT_CAP = 8 * 1024 * 1024;
const FAILED_AUDIT_CAP = 30;
const AUDIT_ITEM_CAP = 10;
const AUDIT_SNIPPET_CAP = 200;
/** Lab categories. Their scores come from the same run, and failed audits are read from them. */
const LAB_CATEGORIES = ['performance', 'seo', 'best-practices'] as const;

type AuditCategory = (typeof LAB_CATEGORIES)[number];
/** Informative audit (no score). Kept when it names an element. */
const LCP_ELEMENT_AUDIT = 'largest-contentful-paint-element';

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
  category: AuditCategory;
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
  /** Install command or phrase for `binary-missing` and `chrome-missing`. Null otherwise. */
  install: string | null;
  formFactor: 'mobile';
  requestedUrl: string;
  finalUrl: string | null;
  metrics: LighthouseMetrics;
  failedAudits: LighthouseFailedAudit[];
}

export type LighthouseSpawnOutcome = ProcessOutcome;
export type LighthouseSpawnHandle = ProcessHandle;
export type LighthouseSpawn = ProcessSpawn;

export interface LighthouseHandle {
  promise: Promise<LighthouseReport>;
  kill: () => void;
}

export function skippedLighthouse(requestedUrl: string): LighthouseReport {
  return {
    status: 'skipped',
    reason: 'not-requested',
    install: null,
    formFactor: 'mobile',
    requestedUrl,
    finalUrl: null,
    metrics: {},
    failedAudits: [],
  };
}

function lighthouseInstall(reason: LighthouseReason): string | null {
  if (reason === 'binary-missing') {
    return LIGHTHOUSE_INSTALL;
  }

  if (reason === 'chrome-missing') {
    return CHROME_INSTALL;
  }

  return null;
}

/** A missing tool is `skipped`, like the Chrome render. A lab run that failed is `error`. */
function lighthouseFailure(requestedUrl: string, reason: LighthouseReason): LighthouseReport {
  const install = lighthouseInstall(reason);

  return {
    status: install ? 'skipped' : 'error',
    reason,
    install,
    formFactor: 'mobile',
    requestedUrl,
    finalUrl: null,
    metrics: {},
    failedAudits: [],
  };
}

/** Hop refused. Chrome does not start, and the audit still exits on discovery. */
export function refusedLighthouse(requestedUrl: string): LighthouseHandle {
  return {
    promise: Promise.resolve(lighthouseFailure(requestedUrl, 'error')),
    kill: noop,
  };
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

  return LAB_CATEGORIES.flatMap((category) => {
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

function endpointHost(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
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
    install: null,
    formFactor: 'mobile',
    requestedUrl: typeof reportedUrl === 'string' ? reportedUrl : requestedUrl,
    finalUrl: final,
    metrics: readMetrics(audits),
    failedAudits: readFailedAudits(lhr),
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

  // A usable report counts even when Chrome exited non-zero.

  const parsed = parseLighthouseStdout(outcome.stdout, requestedUrl);

  return parsed?.status === 'ok' ? parsed : lighthouseFailure(requestedUrl, 'error');
}

/** Lab profile: the lab categories, mobile form factor, and the pinned Chrome flags. */
function writePinConfig(chromeFlags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'searchunit-lh-'));
  const path = join(dir, 'config.cjs');
  const settings = {
    extends: 'lighthouse:default',
    settings: {
      onlyCategories: [...LAB_CATEGORIES],
      formFactor: 'mobile',
      // Raw request lists and screenshots are megabytes the CLI never reads. On ad-heavy pages
      // they pushed the JSON past LIGHTHOUSE_OUTPUT_CAP, and the lab ended in `error`.
      disableFullPageScreenshot: true,
      skipAudits: ['network-requests', 'screenshot-thumbnails', 'final-screenshot'],
      chromeFlags: ['--headless', ...chromeFlags],
    },
  };
  writeFileSync(path, `module.exports = ${JSON.stringify(settings)};\n`);

  return path;
}

function lighthouseArgs(url: string, configPath: string): string[] {
  return [
    url,
    '--output=json',
    '--output-path=stdout',
    '--quiet',
    `--only-categories=${LAB_CATEGORIES.join(',')}`,
    '--form-factor=mobile',
    `--config-path=${configPath}`,
  ];
}

function defaultLighthouseSpawn(command: string, args: readonly string[]): ProcessHandle {
  return spawnCapped(command, args, {
    timeoutMs: LIGHTHOUSE_TIMEOUT_MS,
    outputCap: LIGHTHOUSE_OUTPUT_CAP,
  });
}

function noop(): void {
  return undefined;
}

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

/** Spawns the `lighthouse` binary pinned to `pinnedAddress`. A lab failure stays on the report. */
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

      configPath = writePinConfig(pinnedChromeFlags(rules, proxy.port));
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
        if (!(err instanceof Error)) {
          throw err;
        }
      }
    },
  };
}
