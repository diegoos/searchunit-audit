import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { currentMaxBodyBytes } from '../lib/fetch.ts';
import { spawnCapped, type ProcessOutcome, type ProcessSpawn } from './childProcess.ts';
import { parseHtmlPage } from './htmlParser.ts';
import { mergeRobotsDirectives } from './robotsDirective.ts';
import { MAIN_TEXT_CAP } from './parsers/mainContent.ts';
import { CHROME_INSTALL } from './installHints.ts';
import { hostResolverRules, openPinProxy, pinnedChromeFlags } from './pinnedChrome.ts';
import type { RenderedPage, RenderReason } from './types.ts';

const RENDER_TIMEOUT_MS = 30_000;
const VIRTUAL_TIME_BUDGET_MS = 10_000;
const LINKS_ONLY_LIST_CAP = 20;
const SKIPPED_REASONS: ReadonlySet<RenderReason> = new Set(['not-requested', 'chrome-missing']);
const NO_CONTENT = {
  title: null,
  metaDescription: null,
  canonicalUrl: null,
  effectiveRobotsDirective: null,
  h1: null,
  wordCount: null,
  mainText: null,
  mainTextTruncated: null,
  structuredDataTypes: null,
  internalLinkCount: null,
  hreflang: null,
  visibleTextSha256: null,
  linksOnlyAfterRender: null,
  linksOnlyAfterRenderCount: null,
};

const MAC_CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const UNIX_CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** A render that did not produce a DOM. `skipped` for a choice or a missing Chrome, else `error`. */
export function unrenderedPage(reason: RenderReason): RenderedPage {
  return {
    status: SKIPPED_REASONS.has(reason) ? 'skipped' : 'error',
    reason,
    install: reason === 'chrome-missing' ? CHROME_INSTALL : null,
    ...NO_CONTENT,
  };
}

function windowsChromeCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.PROGRAMFILES ?? 'C:\\Program Files', env['PROGRAMFILES(X86)'] ?? ''];

  return roots
    .filter((root) => root !== '')
    .map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`);
}

function chromeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return MAC_CHROME;
  }

  if (platform === 'win32') {
    return windowsChromeCandidates(env);
  }

  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);

  return UNIX_CHROME_NAMES.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

/**
 * Chrome binary: `CHROME_PATH` when it exists, else the first default path for
 * the platform. Null when none exists.
 */
export function resolveChromeBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const override = env.CHROME_PATH?.trim();

  if (override && exists(override)) {
    return override;
  }

  return chromeCandidates(env, platform).find((path) => exists(path)) ?? null;
}

function renderArgs(url: string, chromeFlags: string[], profileDir: string): string[] {
  return [
    '--headless',
    '--dump-dom',
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    ...chromeFlags,
    url,
  ];
}

/** Rendered pageKeys that the raw link index does not contain, in rendered order. */
function linksOnlyAfterRender(
  renderedIndex: readonly string[],
  rawIndex: readonly string[],
): string[] {
  const raw = new Set(rawIndex);

  return renderedIndex.filter((key) => !raw.has(key));
}

/**
 * DOM snapshot of a rendered page, read with the same parser as the raw HTML.
 * `rawLinkIndex` is the raw page's internal link index, to diff the links by pageKey.
 */
export function renderedPageFrom(
  html: string,
  finalUrl: string,
  xRobotsTag: string | null,
  rawLinkIndex: readonly string[],
): RenderedPage {
  const parsed = parseHtmlPage(html, finalUrl);
  const onlyAfterRender = linksOnlyAfterRender(parsed.internalLinkIndex, rawLinkIndex);

  return {
    status: 'ok',
    reason: null,
    install: null,
    title: parsed.title,
    metaDescription: parsed.metaDescription,
    canonicalUrl: parsed.canonicalUrl,
    effectiveRobotsDirective: mergeRobotsDirectives(parsed.robotsDirective, xRobotsTag),
    h1: parsed.headings.h1,
    wordCount: parsed.wordCount,
    mainText: parsed.mainText.slice(0, MAIN_TEXT_CAP),
    mainTextTruncated: parsed.mainText.length > MAIN_TEXT_CAP,
    structuredDataTypes: parsed.structuredData.types,
    internalLinkCount: parsed.internalLinkCount,
    hreflang: parsed.hreflang,
    visibleTextSha256: parsed.visibleTextSha256,
    linksOnlyAfterRender: onlyAfterRender.slice(0, LINKS_ONLY_LIST_CAP),
    linksOnlyAfterRenderCount: onlyAfterRender.length,
  };
}

function renderOutcome(
  outcome: ProcessOutcome,
  url: string,
  xRobotsTag: string | null,
  rawLinkIndex: readonly string[],
): RenderedPage {
  if (outcome.overflow || Buffer.byteLength(outcome.stdout) > currentMaxBodyBytes()) {
    return unrenderedPage('too_large');
  }

  if (outcome.timedOut) {
    return unrenderedPage('timeout');
  }

  if (outcome.errorCode === 'ENOENT') {
    return unrenderedPage('chrome-missing');
  }

  // Chrome can exit non-zero after a usable dump, so the DOM decides.

  if (!/<html[\s>]/i.test(outcome.stdout)) {
    return unrenderedPage('error');
  }

  return renderedPageFrom(outcome.stdout, url, xRobotsTag, rawLinkIndex);
}

export interface RenderDeps {
  /** Chrome binary. Undefined resolves it from the environment; null means not installed. */
  chrome?: string | null;
  spawn?: ProcessSpawn;
}

function defaultRenderSpawn(command: string, args: readonly string[]) {
  return spawnCapped(command, args, {
    timeoutMs: RENDER_TIMEOUT_MS,
    outputCap: currentMaxBodyBytes(),
  });
}

/**
 * Renders `url` in headless Chrome, with the host pinned to `pinnedAddress`.
 * The DOM comes back on stdout (`--dump-dom`). `xRobotsTag` and `rawLinkIndex` come from the raw fetch.
 */
export async function renderPage(
  url: string,
  pinnedAddress: string,
  xRobotsTag: string | null,
  rawLinkIndex: readonly string[],
  deps: RenderDeps = {},
): Promise<RenderedPage> {
  const chrome = deps.chrome === undefined ? resolveChromeBinary() : deps.chrome;

  if (chrome === null) {
    return unrenderedPage('chrome-missing');
  }

  const rules = hostResolverRules(url, pinnedAddress);

  if (!rules) {
    return unrenderedPage('error');
  }

  const proxy = await openPinProxy(url, pinnedAddress).catch(() => null);

  if (!proxy) {
    return unrenderedPage('error');
  }

  try {
    const profileDir = mkdtempSync(join(tmpdir(), 'searchunit-render-'));

    try {
      const spawnImpl = deps.spawn ?? defaultRenderSpawn;
      const args = renderArgs(url, pinnedChromeFlags(rules, proxy.port), profileDir);
      const outcome = await spawnImpl(chrome, args).done;

      return renderOutcome(outcome, url, xRobotsTag, rawLinkIndex);
    } finally {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Cleanup must not mask the render outcome.
      }
    }
  } catch {
    return unrenderedPage('error');
  } finally {
    proxy.close();
  }
}
