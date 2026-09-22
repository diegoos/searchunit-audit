import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';
import pkg from '../../package.json' with { type: 'json' };
import { isBlockedHostname, isBlockedIpString } from '../ip-policy.ts';
import { DEFAULT_MAX_BODY_BYTES, parseMaxBodyBytes } from './maxBodyBytes.ts';
import { pinnedFetch } from './pinnedFetch.ts';
import { normalizeUrl, stripUserinfo } from './url.ts';

type FetchErrorCode = 'timeout' | 'blocked' | 'not_found' | 'network' | 'invalid_url' | 'too_large';

const BODY_TOO_LARGE_MESSAGE = 'Response body exceeds the configured size cap';

/** Body is larger than the configured cap. Callers must not keep a partial body. */
export class BodyTooLargeError extends Error {
  constructor() {
    super(BODY_TOO_LARGE_MESSAGE);
    this.name = 'BodyTooLargeError';
  }
}

export interface FetchedPage {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  fetchedAt: string;
  headers: Record<string, string>;
  redirectChain: string[];
  responseTimeMs: number;
}

export interface FetchFailure {
  ok: false;
  requestedUrl: string;
  error: FetchErrorCode;
  status?: number;
}

export type FetchOutcome = FetchedPage | FetchFailure;

export interface FetchOptions {
  /** When true, HTTP 4xx/5xx still return the body instead of a failure. */
  allowHttpErrors?: boolean;
  /** Abort the whole hop chain after this many ms. Defaults to 8s. */
  timeoutMs?: number;
  /** Drop the body after headers (status-only checks). */
  headersOnly?: boolean;
  /** Body cap for this call. Defaults to the active CLI/config cap. */
  maxBytes?: number;
}

let activeMaxBodyBytes = DEFAULT_MAX_BODY_BYTES;

/** Sets the body cap used when a fetch omits `maxBytes`. */
export function setActiveMaxBodyBytes(bytes: number): void {
  activeMaxBodyBytes = parseMaxBodyBytes(String(bytes));
}

/** Active body cap after CLI/config merge (`--max-bytes` / `max_body_bytes`). */
export function currentMaxBodyBytes(): number {
  return activeMaxBodyBytes;
}

function bodyCap(options: FetchOptions): number {
  return options.maxBytes ?? activeMaxBodyBytes;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const PAGE_TIMEOUT_MS = 30_000;

/** Timeout used for the audited HTML page. */
export const DISCOVERY_PAGE_TIMEOUT_MS = PAGE_TIMEOUT_MS;

const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(['', '80', '443']);

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = `SearchUnitCLI/${pkg.version}`;

/**
 * True when every resolved address is public. Mixed public+private (dual-homed)
 * is rejected.
 */
export function allResolvedAddressesArePublic(records: readonly { address: string }[]): boolean {
  if (records.length === 0) {
    return false;
  }

  return records.every((record) => !isBlockedIpString(record.address));
}

interface PublicHop {
  ok: true;
  pinnedAddress: string;
}

export type HopResolve = PublicHop | { ok: false; error: 'blocked' | 'network' };

function abortError(): Error {
  const err = new Error('The operation was aborted');

  err.name = 'AbortError';

  return err;
}

/** DNS lookup that honors AbortSignal (Node dns.promises.lookup has no signal). */
async function lookupAll(hostname: string, signal?: AbortSignal): Promise<LookupAddress[]> {
  if (signal?.aborted) {
    throw abortError();
  }

  const pending = lookup(hostname, { all: true }) as Promise<LookupAddress[]>;

  if (!signal) {
    return pending;
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (records) => {
        signal.removeEventListener('abort', onAbort);
        resolve(records);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * SSRF preflight: scheme, port, hostname, and DNS. Returns the address to pin
 * on the TCP connection, or blocked/network when the hop must not be fetched.
 */
export async function resolvePublicHop(url: URL, signal?: AbortSignal): Promise<HopResolve> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'blocked' };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, error: 'blocked' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isBlockedHostname(url.hostname) || isBlockedHostname(hostname)) {
    return { ok: false, error: 'blocked' };
  }

  if (isIP(hostname)) {
    if (isBlockedIpString(hostname)) {
      return { ok: false, error: 'blocked' };
    }

    return { ok: true, pinnedAddress: hostname };
  }

  try {
    const records = await lookupAll(hostname, signal);

    if (!allResolvedAddressesArePublic(records)) {
      return { ok: false, error: 'blocked' };
    }

    const first = records[0];

    if (!first) {
      return { ok: false, error: 'network' };
    }

    return { ok: true, pinnedAddress: first.address };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }

    return { ok: false, error: 'network' };
  }
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function isGzipTooLarge(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
}

/** UTF-8-decodes a fetched body; gunzips when the payload still has gzip magic. */
export async function decodeFetchedBytes(
  bytes: Uint8Array,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  if (bytes.length > maxBytes) {
    throw new BodyTooLargeError();
  }

  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
    try {
      return new TextDecoder().decode(gunzipSync(bytes, { maxOutputLength: maxBytes }));
    } catch (error) {
      if (isGzipTooLarge(error)) {
        throw new BodyTooLargeError();
      }

      throw error;
    }
  }

  return new TextDecoder().decode(bytes);
}

/** Maps robots.txt / llms.txt HTTP to present (200), missing (404), or error. */
export function classifyRobotsHttp(ok: boolean, status?: number): 'present' | 'missing' | 'error' {
  if (!ok) {
    return 'error';
  }

  if (status === 200) {
    return 'present';
  }

  if (status === 404) {
    return 'missing';
  }

  return 'error';
}

function wellKnownPathMatches(finalUrl: string, expectedPath: string): boolean {
  try {
    const path = new URL(finalUrl).pathname;

    return path === expectedPath || path === `${expectedPath}/`;
  } catch {
    return false;
  }
}

/**
 * Classifies a well-known text file fetch. A 200 that landed on another path
 * (homepage HTML) is missing unless the content-type is text/plain.
 */
export function classifyWellKnownFetch(
  response: FetchOutcome,
  expectedPath: string,
): 'present' | 'missing' | 'error' {
  const kind = classifyRobotsHttp(response.ok, response.status);

  if (kind !== 'present' || !response.ok) {
    return kind;
  }

  if (wellKnownPathMatches(response.finalUrl, expectedPath)) {
    return 'present';
  }

  if (response.contentType.toLowerCase().includes('text/plain')) {
    return 'present';
  }

  return 'missing';
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');

  if (!raw) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

/** Reads the full body. Throws {@link BodyTooLargeError} when it is over `maxBytes`. */
export async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = contentLength(response);

  if (declared !== undefined && declared > maxBytes) {
    await response.body?.cancel();

    throw new BodyTooLargeError();
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.length;
    chunks.push(value);

    if (totalBytes > maxBytes) {
      await reader.cancel();

      throw new BodyTooLargeError();
    }
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

async function maybeReadBody(
  response: Response,
  headersOnly: boolean | undefined,
  maxBytes: number,
): Promise<string> {
  if (!headersOnly) {
    const bytes = await readCappedBody(response, maxBytes);

    return decodeFetchedBytes(bytes, maxBytes);
  }

  await response.body?.cancel();

  return '';
}

/** Lowercases all response header names for analyzer compatibility. */

function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return headers;
}

/**
 * Fetches a public http(s) URL with SSRF checks on every redirect hop.
 */
export async function fetchPublicUrl(
  requestedUrl: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  let parsed: URL;

  try {
    parsed = stripUserinfo(new URL(normalizeUrl(requestedUrl)));
  } catch {
    return { ok: false, requestedUrl, error: 'invalid_url' };
  }

  const safeUrl = parsed.href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const redirectChain: string[] = [parsed.href];
  const requestHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,text/plain,application/json,*/*',
  };
  try {
    const firstHop = await resolvePublicHop(parsed, controller.signal);

    if (!firstHop.ok) {
      return { ok: false, requestedUrl: safeUrl, error: firstHop.error };
    }

    let current = parsed;
    let pinnedAddress = firstHop.pinnedAddress;
    let response: Response;

    for (let hop = 0; ; hop++) {
      response = await pinnedFetch(current.href, pinnedAddress, {
        signal: controller.signal,
        headers: requestHeaders,
        redirect: 'manual',
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        break;
      }

      const location = response.headers.get('location');

      if (!location) {
        break;
      }

      if (hop >= MAX_REDIRECTS) {
        await discardResponseBody(response);

        return { ok: false, requestedUrl: safeUrl, error: 'network' };
      }

      await discardResponseBody(response);

      let next: URL;

      try {
        next = stripUserinfo(new URL(location, current.href));
      } catch {
        return { ok: false, requestedUrl: safeUrl, error: 'network' };
      }

      const nextHop = await resolvePublicHop(next, controller.signal);

      if (!nextHop.ok) {
        return { ok: false, requestedUrl: safeUrl, error: nextHop.error };
      }

      current = next;
      pinnedAddress = nextHop.pinnedAddress;
      redirectChain.push(current.href);
    }

    const status = response.status;

    if (!options.allowHttpErrors) {
      if (status === 404) {
        return { ok: false, requestedUrl: safeUrl, error: 'not_found', status };
      }

      if (status >= 400) {
        return { ok: false, requestedUrl: safeUrl, error: 'network', status };
      }
    }

    const body = await maybeReadBody(response, options.headersOnly, bodyCap(options));
    const finalUrl = current.href;

    if (redirectChain[redirectChain.length - 1] !== finalUrl) {
      redirectChain.push(finalUrl);
    }

    return {
      ok: true,
      requestedUrl: safeUrl,
      finalUrl,
      status,
      contentType: response.headers.get('content-type') ?? '',
      body,
      fetchedAt: new Date().toISOString(),
      headers: collectHeaders(response),
      redirectChain,
      responseTimeMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return { ok: false, requestedUrl: safeUrl, error: 'too_large' };
    }

    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, requestedUrl: safeUrl, error: 'timeout' };
    }

    return { ok: false, requestedUrl: safeUrl, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a fetch failure to a short CLI error string. */
export function formatFetchError(result: FetchFailure): string {
  switch (result.error) {
    case 'blocked':
      return 'URL blocked by SSRF policy (private/localhost/metadata host)';
    case 'not_found':
      return 'Resource not found (HTTP 404)';
    case 'timeout':
      return 'Fetch timed out';
    case 'invalid_url':
      return 'Invalid URL';
    case 'too_large':
      return BODY_TOO_LARGE_MESSAGE;
    default:
      return result.status ? `Network error (HTTP ${result.status})` : 'Network error';
  }
}
