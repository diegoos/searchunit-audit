import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { AsyncLocalStorage } from 'node:async_hooks';
import { connect, isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';
import pkg from '../../package.json' with { type: 'json' };
import {
  isBlockedHostname,
  isBlockedIpString,
  isLoopbackHost,
  isLoopbackHostname,
  isLoopbackIpString,
} from '../ip-policy.ts';
import { CliError } from './errors.ts';
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
  /** When set, replaces `SearchUnitCLI/<version>` on this call. */
  userAgent?: string;
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

function requestHeaders(options: FetchOptions): Record<string, string> {
  return {
    'User-Agent': options.userAgent ?? USER_AGENT,
    Accept: 'text/html,text/plain,application/json,*/*',
  };
}

const DEFAULT_TIMEOUT_MS = 8_000;
const PAGE_TIMEOUT_MS = 30_000;

/** Timeout used for the audited HTML page. */
export const DISCOVERY_PAGE_TIMEOUT_MS = PAGE_TIMEOUT_MS;

const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(['', '80', '443']);

type ConnectProbe = (address: string, port: number) => Promise<boolean>;

interface LocalScope {
  port: string;
  canConnect: ConnectProbe;
}

/** Port of the command target when that target is loopback. Null keeps loopback blocked. */
const localTargetScope = new AsyncLocalStorage<LocalScope | null>();

function numericPort(url: URL): string {
  if (url.port) {
    return url.port;
  }

  return url.protocol === 'https:' ? '443' : '80';
}

/** Hostname without the brackets WHATWG URL keeps around an IPv6 literal. */
function unbracketedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function loopbackPort(target: string | undefined): string | null {
  if (!target?.trim()) {
    return null;
  }

  try {
    const url = stripUserinfo(new URL(normalizeUrl(target)));

    if (!isLoopbackHost(url.hostname)) {
      return null;
    }

    return numericPort(url);
  } catch {
    return null;
  }
}

/**
 * Runs `fn` with loopback fetches allowed on the same port as `target`.
 * A public target, or no target, leaves loopback blocked. `canConnect` picks
 * the loopback address that accepts a connection on that port.
 */
export function withLocalTarget<T>(
  target: string | undefined,
  fn: () => Promise<T>,
  canConnect: ConnectProbe = tcpConnects,
): Promise<T> {
  const port = loopbackPort(target);

  return localTargetScope.run(port ? { port, canConnect } : null, fn);
}

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

/** Picks the pinned address from an accepted record set. Undefined means none. */
type AddressChooser = (records: readonly LookupAddress[]) => Promise<string | undefined>;

async function firstRecordAddress(records: readonly LookupAddress[]): Promise<string | undefined> {
  return records[0]?.address;
}

/**
 * Pins the address `choose` picks when `accepts` approves the whole record set.
 * A rejected set is blocked. A lookup error (other than abort) is a network failure.
 */
async function pinResolvedAddress(
  hostname: string,
  signal: AbortSignal | undefined,
  accepts: (records: readonly LookupAddress[]) => boolean,
  choose: AddressChooser = firstRecordAddress,
): Promise<HopResolve> {
  try {
    const records = await lookupAll(hostname, signal);

    if (!accepts(records)) {
      return { ok: false, error: 'blocked' };
    }

    const pinnedAddress = await choose(records);

    if (!pinnedAddress) {
      return { ok: false, error: 'network' };
    }

    return { ok: true, pinnedAddress };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }

    return { ok: false, error: 'network' };
  }
}

/** True when there is at least one record and every record is loopback. */
function allLoopbackAddresses(records: readonly LookupAddress[]): boolean {
  return records.length > 0 && records.every((record) => isLoopbackIpString(record.address));
}

const LOOPBACK_PROBE_TIMEOUT_MS = 300;

/** TCP connect test for one address. Closes the socket at once and sends no bytes. */
function tcpConnects(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    const finish = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(LOOPBACK_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * First record, in lookup order, whose address accepts a TCP connect on `port`.
 * Nothing accepts: the first record, so the fetch fails as it did before the probe.
 */
export async function firstReachableLoopback(
  records: readonly LookupAddress[],
  port: number,
  canConnect: ConnectProbe = tcpConnects,
): Promise<string | undefined> {
  for (const record of records) {
    if (await canConnect(record.address, port)) {
      return record.address;
    }
  }

  return records[0]?.address;
}

/**
 * Loopback hop for a local dev target. Null means the public SSRF checks decide.
 * A loopback name that does not resolve to loopback is blocked.
 */
async function resolveLoopbackHop(url: URL, signal?: AbortSignal): Promise<HopResolve | null> {
  const local = localTargetScope.getStore();

  if (!local || numericPort(url) !== local.port) {
    return null;
  }

  const hostname = unbracketedHostname(url);

  if (isIP(hostname)) {
    if (!isLoopbackIpString(hostname)) {
      return null;
    }

    return { ok: true, pinnedAddress: hostname };
  }

  if (!isLoopbackHostname(hostname)) {
    return null;
  }

  const port = Number(local.port);

  return pinResolvedAddress(hostname, signal, allLoopbackAddresses, (records) =>
    firstReachableLoopback(records, port, local.canConnect),
  );
}

/**
 * SSRF preflight: scheme, port, hostname, and DNS. Returns the address to pin
 * on the TCP connection, or blocked/network when the hop must not be fetched.
 * Loopback is allowed only inside `withLocalTarget`, and only on that port.
 */
export async function resolvePublicHop(url: URL, signal?: AbortSignal): Promise<HopResolve> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'blocked' };
  }

  const loopback = await resolveLoopbackHop(url, signal);

  if (loopback) {
    return loopback;
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, error: 'blocked' };
  }

  const hostname = unbracketedHostname(url);

  if (isBlockedHostname(url.hostname) || isBlockedHostname(hostname)) {
    return { ok: false, error: 'blocked' };
  }

  if (isIP(hostname)) {
    if (isBlockedIpString(hostname)) {
      return { ok: false, error: 'blocked' };
    }

    return { ok: true, pinnedAddress: hostname };
  }

  return pinResolvedAddress(hostname, signal, allResolvedAddressesArePublic);
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

  return Number.isFinite(value) ? value : undefined;
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

/** Tries per fetch: the first try plus two retries on transient failures. */
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFailure(outcome: FetchOutcome): boolean {
  if (!outcome.ok) {
    return outcome.error === 'network' || outcome.error === 'timeout';
  }

  return outcome.status === 429 || outcome.status >= 500;
}

/**
 * Fetches with retries on network errors, timeouts, 429, and 5xx. Returns the
 * last outcome and how many tries ran, so the audit can report the failure.
 */
export async function fetchPublicUrlWithAttempts(
  requestedUrl: string,
  options: FetchOptions = {},
): Promise<{ outcome: FetchOutcome; attempts: number }> {
  let outcome = await fetchPublicUrlOnce(requestedUrl, options);
  let attempts = 1;

  while (attempts < FETCH_ATTEMPTS && isTransientFailure(outcome)) {
    await sleep(RETRY_DELAY_MS * attempts);
    outcome = await fetchPublicUrlOnce(requestedUrl, options);
    attempts++;
  }

  return { outcome, attempts };
}

/** Fetches a public http(s) URL with SSRF checks on every redirect hop. Retries transient failures. */
export async function fetchPublicUrl(
  requestedUrl: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  return (await fetchPublicUrlWithAttempts(requestedUrl, options)).outcome;
}

/** Short error code for a failed outcome, such as `timeout` or `http_503`. Null when usable. */
export function fetchErrorCode(outcome: FetchOutcome): string | null {
  if (!outcome.ok) {
    return outcome.error;
  }

  return outcome.status >= 400 ? `http_${outcome.status}` : null;
}

type RedirectOutcome =
  | { ok: true; response: Response; current: URL }
  | { ok: false; error: FetchErrorCode };

/**
 * Sends the request and follows redirects. Every hop passes `resolvePublicHop`
 * and is pinned to its own address. Each hop URL is appended to `redirectChain`.
 */
async function fetchAlongRedirects(
  first: URL,
  firstAddress: string,
  request: { headers: Record<string, string>; signal: AbortSignal },
  redirectChain: string[],
): Promise<RedirectOutcome> {
  let current = first;
  let pinnedAddress = firstAddress;

  for (let hop = 0; ; hop++) {
    const response = await pinnedFetch(current.href, pinnedAddress, {
      signal: request.signal,
      headers: request.headers,
      redirect: 'manual',
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ok: true, response, current };
    }

    const location = response.headers.get('location');

    if (!location) {
      return { ok: true, response, current };
    }

    if (hop >= MAX_REDIRECTS) {
      await discardResponseBody(response);

      return { ok: false, error: 'network' };
    }

    await discardResponseBody(response);

    let next: URL;

    try {
      next = stripUserinfo(new URL(location, current.href));
    } catch {
      return { ok: false, error: 'network' };
    }

    const nextHop = await resolvePublicHop(next, request.signal);

    if (!nextHop.ok) {
      return { ok: false, error: nextHop.error };
    }

    current = next;
    pinnedAddress = nextHop.pinnedAddress;
    redirectChain.push(current.href);
  }
}

async function fetchPublicUrlOnce(
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

  try {
    const firstHop = await resolvePublicHop(parsed, controller.signal);

    if (!firstHop.ok) {
      return { ok: false, requestedUrl: safeUrl, error: firstHop.error };
    }

    const followed = await fetchAlongRedirects(
      parsed,
      firstHop.pinnedAddress,
      { headers: requestHeaders(options), signal: controller.signal },
      redirectChain,
    );

    if (!followed.ok) {
      return { ok: false, requestedUrl: safeUrl, error: followed.error };
    }

    const { response, current } = followed;
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

/**
 * Throws a CliError when policy refused the URL (blocked host or invalid URL).
 * Other failures, such as a 404 or a network error, pass through for the caller to read.
 */
export function throwIfRefusedFetch(outcome: FetchOutcome): void {
  if (outcome.ok) {
    return;
  }

  if (outcome.error !== 'blocked' && outcome.error !== 'invalid_url') {
    return;
  }

  throw new CliError(formatFetchError(outcome));
}

/** Fetches a page and throws a CliError with the failure text when it is not usable. */
export async function fetchPageOrThrow(url: string): Promise<FetchedPage> {
  const page = await fetchPublicUrl(url);

  if (!page.ok) {
    throw new CliError(formatFetchError(page));
  }

  return page;
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
