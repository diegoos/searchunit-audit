import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Auth } from 'googleapis';
import { isBlockedHostname, isBlockedIpString } from './ip-policy.ts';

/** Read-only Search Console scope. A write scope is refused. */
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const ALLOWED_SCOPES = new Set([
  'openid',
  // ponytail: tokeninfo returns these short names for the userinfo scopes below.
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  // ponytail: gcloud auth application-default login rejects a scope list that omits cloud-platform.
  'https://www.googleapis.com/auth/cloud-platform',
  GSC_SCOPE,
]);

/** Project id (6–30) or numeric project number. Keeps the quota header free of other characters. */
const QUOTA_PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const MAX_SAMPLE = 9;
/** Top query-page pairs. ponytail: 50 rows, clicks order; upgrade: paginate when the audit needs the long tail. */
const QUERY_PAGE_LIMIT = 50;
/** Queries for one sampled URL. */
const PAGE_QUERY_LIMIT = 10;

type JsonRecord = Record<string, unknown>;

interface SiteEntry {
  siteUrl?: string | null;
  permissionLevel?: string | null;
}

/** Search Analytics request body sent through `webmasters.searchanalytics.query`. */
export interface GscQueryBody {
  startDate: string;
  endDate: string;
  dataState: string;
  dimensions: string[];
  rowLimit: number;
  searchType?: string;
  dimensionFilterGroups?: {
    groupType: string;
    filters: { dimension: string; operator: string; expression: string }[];
  }[];
}

interface SitemapEntry {
  path?: string | null;
  lastSubmitted?: string | null;
  lastDownloaded?: string | null;
  isPending?: boolean | null;
  isSitemapsIndex?: boolean | null;
  errors?: string | null;
  warnings?: string | null;
  contents?: { type?: string | null; submitted?: string | null; indexed?: string | null }[] | null;
}

/**
 * Test double for the googleapis Search Console clients.
 * Production builds this from `google.webmasters` and `google.searchconsole`.
 */
export interface GscApi {
  /** User-token scopes. `null` means the token is invalid. Omit for a service-account double. */
  scopes?: () => Promise<string[] | null>;
  listSites(): Promise<SiteEntry[]>;
  listSitemaps(siteUrl: string): Promise<SitemapEntry[]>;
  query(siteUrl: string, body: GscQueryBody): Promise<JsonRecord>;
  inspect(siteUrl: string, inspectionUrl: string): Promise<JsonRecord>;
}

/** HTTP failure from a googleapis call. */
export class GscRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GscRequestError';
    this.status = status;
  }
}

/** googleapis auth client plus the user token when that is the credential. */
export interface GscAuth {
  client: Auth.OAuth2Client;
  userToken?: string;
  quotaProject?: string;
}

type CredentialSource =
  | { kind: 'token'; token: string }
  | { kind: 'service_account'; path: string; projectId?: string }
  | { skip: JsonRecord };

/** One Search Console read. `gsc URL` runs every read. */
export type GscSlice =
  | 'queries'
  | 'pages'
  | 'query-pages'
  | 'page-queries'
  | 'sampled-pages'
  | 'search-appearance'
  | 'discover'
  | 'google-news'
  | 'sitemaps';

interface GscQueryOptions {
  mode: 'check' | 'performance' | 'inspect';
  /** Set on a subcommand. Unset means every performance read. */
  slice?: GscSlice;
  url?: string;
  sample?: string[];
  token?: string;
  /** Explicit query start. With no end, the window runs 30 days forward. */
  initDate?: string;
  /** Explicit query end. With no start, the window runs 30 days back. */
  endDate?: string;
  /** Replaces the googleapis clients. Auth still comes from the env or `token`. */
  api?: GscApi;
  now?: Date;
}

/** Replaces credential-shaped substrings before anything is printed. */
export function redact(text: string): string {
  return text
    .replaceAll(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[redacted]',
    )
    .replaceAll(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replaceAll(/ya29\.[A-Za-z0-9_\-.]+/g, '[redacted]')
    .replaceAll(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replaceAll(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]');
}

/** Scopes outside the read-only allowlist. */
export function unexpectedScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter((scope) => !ALLOWED_SCOPES.has(scope)))].toSorted();
}

/** True when the value can be sent as `x-goog-user-project`. */
function isGscQuotaProject(value: string): boolean {
  return QUOTA_PROJECT.test(value);
}

/**
 * Quota project for Search Console.
 * `GSC_QUOTA_PROJECT`, then `GOOGLE_CLOUD_QUOTA_PROJECT`, then the service account `project_id`, then `quota_project_id` in Application Default Credentials.
 * An explicit value that is not a project id or number is invalid.
 */
export function resolveQuotaProject(serviceAccountProject?: string): {
  id?: string;
  invalid: boolean;
} {
  const explicit =
    process.env.GSC_QUOTA_PROJECT?.trim() || process.env.GOOGLE_CLOUD_QUOTA_PROJECT?.trim();

  if (explicit) {
    return isGscQuotaProject(explicit) ? { id: explicit, invalid: false } : { invalid: true };
  }

  const fromAccount = serviceAccountProject?.trim();

  if (fromAccount && isGscQuotaProject(fromAccount)) {
    return { id: fromAccount, invalid: false };
  }

  return { id: adcQuotaProject(), invalid: false };
}

/** Public http(s) page URL, or empty when Search Console must not see it. */
export function safeAuditUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  if (parsed.username || parsed.password) {
    return '';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (!host || isBlockedHostname(host)) {
    return '';
  }

  if (isIP(host) && isBlockedIpString(host)) {
    return '';
  }

  return url;
}

/** 28-day window ending three days ago, in America/Los_Angeles. API dates are PT. */
export function gscWindow(
  now = new Date(),
  range?: { initDate?: string; endDate?: string },
): { startDate: string; endDate: string } {
  const initDate = range?.initDate;
  const endDate = range?.endDate;

  if (initDate && endDate) {
    return { startDate: initDate, endDate };
  }

  if (initDate) {
    return { startDate: initDate, endDate: shiftIsoDate(initDate, 30) };
  }

  if (endDate) {
    return { startDate: shiftIsoDate(endDate, -30), endDate };
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  const end = new Date(Date.UTC(part('year'), part('month') - 1, part('day') - 3));
  const start = new Date(end);

  start.setUTCDate(end.getUTCDate() - 27);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/** Adds calendar days to a `YYYY-MM-DD` date. */
function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

/**
 * Most specific URL-prefix property, else the longest matching domain property.
 * `siteUnverifiedUser` is ignored.
 */
export function pickSite(entries: SiteEntry[], pageUrl: string): string | null {
  const host = stripWww(hostOf(pageUrl));
  const prefixes: string[] = [];
  const domains: string[] = [];

  for (const entry of entries) {
    const site = String(entry.siteUrl ?? '');

    if (entry.permissionLevel === 'siteUnverifiedUser' || !site) {
      continue;
    }

    if (site.startsWith('sc-domain:')) {
      const domain = stripWww(site.slice('sc-domain:'.length));

      if (host === domain || host.endsWith(`.${domain}`)) {
        domains.push(site);
      }

      continue;
    }

    if (prefixMatch(site, pageUrl)) {
      prefixes.push(site);
    }
  }

  if (prefixes.length > 0) {
    return prefixes.reduce((best, site) => (prefixRank(site) > prefixRank(best) ? site : best));
  }

  if (domains.length > 0) {
    return domains.reduce((best, site) => (site.length > best.length ? site : best));
  }

  return null;
}

/** Builds a googleapis auth client from the env or `explicit` token. Does not call Google. */
export async function gscAuth(explicit?: string): Promise<GscAuth | { skip: JsonRecord }> {
  const preview = resolveQuotaProject();

  if (preview.invalid) {
    return { skip: { status: 'skipped', reason: 'quota-project-invalid' } };
  }

  const source = credentialSource(explicit);

  if ('skip' in source) {
    return source;
  }

  const { google } = await import('googleapis');

  if (source.kind === 'token') {
    const client = new google.auth.OAuth2();

    client.setCredentials({ access_token: source.token });

    if (preview.id) {
      client.quotaProjectId = preview.id;
    }

    return { client, userToken: source.token, quotaProject: preview.id };
  }

  const quota = resolveQuotaProject(source.projectId);

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: source.path,
      scopes: [GSC_SCOPE],
    });
    const client = (await auth.getClient()) as Auth.OAuth2Client;

    client.quotaProjectId = quota.id;

    return { client, quotaProject: quota.id };
  } catch (err) {
    return {
      skip: {
        status: 'skipped',
        reason: 'credentials-invalid',
        message: shortMessage(err instanceof Error ? err.message : 'cannot load credentials'),
      },
    };
  }
}

/** Runs check, performance, or inspect. A skip is a payload, not a throw. */
export async function runGscQuery(opts: GscQueryOptions): Promise<JsonRecord> {
  if (opts.mode !== 'check') {
    const bad = rejectUrl(opts.url);

    if (bad) {
      return bad;
    }
  }

  if (opts.api) {
    return runWithApi(opts, opts.api);
  }

  const auth = await gscAuth(opts.token);

  if ('skip' in auth) {
    return auth.skip;
  }

  const denied = await userScopeSkip(auth);

  if (denied) {
    return denied;
  }

  if (opts.mode === 'check') {
    const failed = await proveServiceAccount(auth);

    if (failed) {
      return failed;
    }

    return { status: 'ok', gsc: 'ready' };
  }

  return runReport(opts, await googleApi(auth.client));
}

/** Access token from the environment. The value stays out of reports. */
function accessToken(): string | undefined {
  const token = process.env.GSC_ACCESS_TOKEN?.trim();

  return token || undefined;
}

/** Token, service-account file, or a skip payload. */
function credentialSource(explicit: string | undefined): CredentialSource {
  const token = explicit?.trim() || accessToken();

  if (token) {
    return { kind: 'token', token };
  }

  const configured = process.env.GSC_CREDENTIALS?.trim();
  const path = configured || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

  if (!path) {
    return { skip: { status: 'skipped', reason: 'token-missing' } };
  }

  const loaded = readServiceAccountMeta(path);

  if (loaded.kind === 'service_account') {
    return { kind: 'service_account', path, projectId: loaded.projectId };
  }

  // A missing ADC file, or one that is not a service account, is no GSC credential.

  if (!configured && (loaded.kind === 'other' || loaded.message === 'cannot read credentials')) {
    return { skip: { status: 'skipped', reason: 'token-missing' } };
  }

  return {
    skip: {
      status: 'skipped',
      reason: 'credentials-invalid',
      message: loaded.kind === 'error' ? loaded.message : 'expected a service account key',
    },
  };
}

/** Reads `type` and `project_id`. The private key stays in the file for googleapis. */
function readServiceAccountMeta(
  path: string,
):
  | { kind: 'service_account'; projectId?: string }
  | { kind: 'other' }
  | { kind: 'error'; message: string } {
  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'error', message: 'cannot read credentials' };
  }

  let parsed: {
    type?: unknown;
    client_email?: unknown;
    private_key?: unknown;
    project_id?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { kind: 'error', message: 'expected a service account key' };
  }

  if (parsed.type !== 'service_account') {
    return { kind: 'other' };
  }

  const email = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';

  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !privateKey.includes('PRIVATE KEY')) {
    return {
      kind: 'error',
      message: 'service account key is missing client_email or private_key',
    };
  }

  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';

  return { kind: 'service_account', projectId: projectId || undefined };
}

/** Refuses a user token whose scopes are not the read-only allowlist. */
async function userScopeSkip(auth: GscAuth): Promise<JsonRecord | null> {
  if (!auth.userToken) {
    return scopeSkip(scopesOf(auth.client));
  }

  try {
    const info = await auth.client.getTokenInfo(auth.userToken);

    return scopeSkip(info.scopes);
  } catch {
    return { status: 'skipped', reason: 'token-invalid' };
  }
}

/** Scopes requested on the service-account client. */
function scopesOf(client: Auth.OAuth2Client): string[] {
  const scopes = (client as { scopes?: string | string[] }).scopes;

  if (Array.isArray(scopes)) {
    return scopes;
  }

  if (typeof scopes === 'string') {
    return scopes.split(/\s+/).filter(Boolean);
  }

  return [GSC_SCOPE];
}

/** Skip payload when scopes are missing, unexpected, or not read-only. `null` means allowed. */
function scopeSkip(scopes: string[] | null): JsonRecord | null {
  if (!scopes) {
    return { status: 'skipped', reason: 'token-invalid' };
  }

  const unexpected = unexpectedScopes(scopes);

  if (unexpected.length > 0) {
    return { status: 'skipped', reason: 'scopes-not-readonly', unexpected };
  }

  if (!scopes.includes(GSC_SCOPE)) {
    return { status: 'skipped', reason: 'gsc-scope-missing' };
  }

  return null;
}

/** Exchanges the service-account JWT. A user token was already checked. */
async function proveServiceAccount(auth: GscAuth): Promise<JsonRecord | null> {
  if (auth.userToken) {
    return null;
  }

  try {
    await auth.client.getAccessToken();

    return null;
  } catch (err) {
    return {
      status: 'skipped',
      reason: 'credentials-invalid',
      message: shortMessage(err instanceof Error ? err.message : 'token exchange failed'),
    };
  }
}

/** Runs a query with an injected client. Skips Google auth calls. */
async function runWithApi(opts: GscQueryOptions, api: GscApi): Promise<JsonRecord> {
  const quota = resolveQuotaProject();

  if (quota.invalid) {
    return { status: 'skipped', reason: 'quota-project-invalid' };
  }

  const source = credentialSource(opts.token);

  if ('skip' in source) {
    return source.skip;
  }

  const scopes = api.scopes ? await api.scopes() : [GSC_SCOPE];
  const denied = scopeSkip(scopes);

  if (denied) {
    return denied;
  }

  if (opts.mode === 'check') {
    return { status: 'ok', gsc: 'ready' };
  }

  return runReport(opts, api);
}

/** Sites, then performance or URL inspection. */
async function runReport(opts: GscQueryOptions, api: GscApi): Promise<JsonRecord> {
  const sites = await loadSites(api);

  if ('skip' in sites) {
    return sites.skip;
  }

  const pageUrl = opts.url ?? '';
  const site = pickSite(sites.entries, pageUrl);

  if (!site) {
    return { status: 'skipped', reason: 'no-property' };
  }

  const urls = sameHostUrls(pageUrl, opts.sample ?? []);

  if (opts.mode === 'inspect') {
    return inspectUrls(api, site, urls);
  }

  return performanceReport(api, site, urls, opts);
}

/** `webmasters` v3 and `searchconsole` v1 bound to one auth client. */
async function googleApi(auth: Auth.OAuth2Client): Promise<GscApi> {
  const { google } = await import('googleapis');
  const webmasters = google.webmasters({ version: 'v3', auth });
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  return {
    listSites() {
      return callGoogle(async () => {
        const response = await webmasters.sites.list();

        return response.data.siteEntry ?? [];
      });
    },
    listSitemaps(siteUrl) {
      return callGoogle(async () => {
        const response = await webmasters.sitemaps.list({ siteUrl });

        return response.data.sitemap ?? [];
      });
    },
    query(siteUrl, body) {
      return callGoogle(async () => {
        const response = await webmasters.searchanalytics.query({
          siteUrl,
          requestBody: body,
        });

        return response.data as JsonRecord;
      });
    },
    inspect(siteUrl, inspectionUrl) {
      return callGoogle(async () => {
        const response = await searchconsole.urlInspection.index.inspect({
          requestBody: {
            inspectionUrl,
            siteUrl,
            languageCode: 'en-US',
          },
        });

        return response.data as JsonRecord;
      });
    },
  };
}

/** googleapis rejection becomes `GscRequestError`. */
async function callGoogle<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw failureOf(err);
  }
}

/** Maps a googleapis error onto `GscRequestError`. */
function failureOf(err: unknown): GscRequestError {
  if (err instanceof GscRequestError) {
    return err;
  }

  return new GscRequestError(httpStatus(err), httpMessage(err));
}

/** HTTP status from a gaxios error, or 0 when the call never got a response. */
function httpStatus(err: unknown): number {
  if (!isRecord(err)) {
    return 0;
  }

  if (typeof err.status === 'number') {
    return err.status;
  }

  const response = err.response;

  if (isRecord(response) && typeof response.status === 'number') {
    return response.status;
  }

  return 0;
}

/** Error text from a gaxios body, then the Error message. */
function httpMessage(err: unknown): string {
  if (!isRecord(err)) {
    return 'network';
  }

  const response = err.response;

  if (isRecord(response) && response.data !== undefined) {
    const data = response.data;

    return shortMessage(typeof data === 'string' ? data : JSON.stringify(data));
  }

  if (typeof err.message === 'string' && err.message) {
    return shortMessage(err.message);
  }

  return 'network';
}

/** At most nine http(s) URLs on the primary host. */
function sameHostUrls(primary: string, sample: string[]): string[] {
  const host = hostOf(primary);
  const kept: string[] = [];

  for (const url of [primary, ...sample]) {
    if (kept.includes(url)) {
      continue;
    }

    const pageHost = hostOf(url);

    if (pageHost && hostsMatch(pageHost, host)) {
      kept.push(url);
    }

    if (kept.length >= MAX_SAMPLE) {
      break;
    }
  }

  return kept;
}

/** Property list, or a skip payload when Google refuses the call. */
async function loadSites(api: GscApi): Promise<{ entries: SiteEntry[] } | { skip: JsonRecord }> {
  try {
    return { entries: await api.listSites() };
  } catch (err) {
    const failure = failureOf(err);

    return { skip: httpSkip(failure.status, failure.message) };
  }
}

/** Performance slices for one property. A slice runs that read only. */
async function performanceReport(
  api: GscApi,
  site: string,
  urls: string[],
  opts: GscQueryOptions,
): Promise<JsonRecord> {
  const window = gscWindow(opts.now, opts);
  const base = {
    startDate: window.startDate,
    endDate: window.endDate,
    dataState: 'final',
  };
  const result: JsonRecord = {
    status: 'ok',
    siteUrl: site,
    urls,
  };
  if (opts.slice !== 'sitemaps') {
    result.window = window;
  }

  for (const [name, body] of analyticsSlices(opts.slice)) {
    result[name] = await queryGsc(api, site, { ...base, ...body });
  }

  if (!opts.slice || opts.slice === 'sampled-pages') {
    result.sampledPages = await sampledPages(api, site, urls, base);
  }

  if (!opts.slice || opts.slice === 'page-queries') {
    result.pageQueries = await pageQueries(api, site, urls, base);
  }

  if (!opts.slice || opts.slice === 'sitemaps') {
    result.sitemaps = await loadSitemaps(api, site);
  }

  return result;
}

type AnalyticsBody = Omit<GscQueryBody, 'startDate' | 'endDate' | 'dataState'>;

/** Search Analytics reads. `command` is the subcommand. `field` is the payload key. */
const ANALYTICS: { command: GscSlice; field: string; body: AnalyticsBody }[] = [
  { command: 'queries', field: 'queries', body: { dimensions: ['query'], rowLimit: 10 } },
  { command: 'pages', field: 'pages', body: { dimensions: ['page'], rowLimit: 25 } },
  {
    command: 'search-appearance',
    field: 'searchAppearance',
    body: { dimensions: ['searchAppearance'], rowLimit: 25 },
  },
  {
    command: 'discover',
    field: 'discover',
    body: { searchType: 'discover', dimensions: ['page'], rowLimit: 5 },
  },
  {
    command: 'google-news',
    field: 'googleNews',
    body: { searchType: 'googleNews', dimensions: ['page'], rowLimit: 5 },
  },
  {
    command: 'query-pages',
    field: 'queryPages',
    body: { dimensions: ['query', 'page'], rowLimit: QUERY_PAGE_LIMIT },
  },
];

/** Search Analytics bodies. One entry when a subcommand names that slice. */
function analyticsSlices(slice?: GscSlice): [string, AnalyticsBody][] {
  const matched = slice ? ANALYTICS.filter((item) => item.command === slice) : ANALYTICS;

  return matched.map((item) => [item.field, item.body]);
}

/** One page-equals query per sampled URL. */
async function sampledPages(
  api: GscApi,
  site: string,
  urls: string[],
  base: Pick<GscQueryBody, 'startDate' | 'endDate' | 'dataState'>,
): Promise<JsonRecord> {
  const rows: JsonRecord[] = [];
  const errors: JsonRecord[] = [];

  for (const url of urls) {
    const slice = await queryGsc(api, site, {
      ...base,
      dimensions: ['page'],
      rowLimit: 1,
      dimensionFilterGroups: pageEquals(url),
    });
    if (typeof slice.error === 'number') {
      errors.push({ url, error: slice.error, message: slice.message });
      continue;
    }

    const sliceRows = slice.rows;

    if (Array.isArray(sliceRows)) {
      rows.push(...sliceRows.filter(isRecord));
    }
  }

  if (errors.length === 0) {
    return { rows };
  }

  return { rows, errors };
}

/** Queries that hit each sampled URL. One Search Analytics call per URL. */
async function pageQueries(
  api: GscApi,
  site: string,
  urls: string[],
  base: Pick<GscQueryBody, 'startDate' | 'endDate' | 'dataState'>,
): Promise<JsonRecord> {
  const pages: JsonRecord[] = [];

  for (const url of urls) {
    const slice = await queryGsc(api, site, {
      ...base,
      dimensions: ['query'],
      rowLimit: PAGE_QUERY_LIMIT,
      dimensionFilterGroups: pageEquals(url),
    });
    if (typeof slice.error === 'number') {
      pages.push({ url, error: slice.error, message: slice.message });
      continue;
    }

    pages.push({ url, rows: slice.rows });
  }

  return { pages };
}

/** Submitted sitemaps for the property. An error stays on this slice. */
async function loadSitemaps(api: GscApi, site: string): Promise<JsonRecord> {
  try {
    const entries = (await api.listSitemaps(site)).map(trimSitemap);

    return { entries };
  } catch (err) {
    const failure = failureOf(err);

    return { error: failure.status, message: failure.message };
  }
}

/** Sitemap path, dates, and error counts. Drops the rest of the payload. */
function trimSitemap(entry: SitemapEntry): JsonRecord {
  return {
    path: entry.path,
    lastSubmitted: entry.lastSubmitted,
    lastDownloaded: entry.lastDownloaded,
    isPending: entry.isPending,
    isSitemapsIndex: entry.isSitemapsIndex,
    errors: entry.errors,
    warnings: entry.warnings,
    contents: Array.isArray(entry.contents)
      ? entry.contents.map((item) => ({
          type: item.type,
          submitted: item.submitted,
          indexed: item.indexed,
        }))
      : [],
  };
}

/** Indexed version of each URL. Stops after HTTP 429. */
async function inspectUrls(api: GscApi, site: string, urls: string[]): Promise<JsonRecord> {
  const inspections: JsonRecord[] = [];

  for (const url of urls) {
    try {
      inspections.push(trimInspection(await api.inspect(site, url), url));
    } catch (err) {
      const failure = failureOf(err);

      inspections.push({ url, error: failure.status, message: failure.message });

      if (failure.status === 429) {
        break;
      }
    }
  }

  return {
    status: 'ok',
    siteUrl: site,
    urls,
    indexedVersion: true,
    inspections,
  };
}

/** Search Analytics filter: this page URL only. */
function pageEquals(url: string): GscQueryBody['dimensionFilterGroups'] {
  return [
    {
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'equals', expression: url }],
    },
  ];
}

/** One Search Analytics query, trimmed to the requested row limit. */
async function queryGsc(api: GscApi, site: string, body: GscQueryBody): Promise<JsonRecord> {
  try {
    return trimRows(await api.query(site, body), body.rowLimit);
  } catch (err) {
    const failure = failureOf(err);

    return { error: failure.status, message: failure.message };
  }
}

/** Keeps `rowLimit` rows and the four metrics. */
function trimRows(payload: JsonRecord, limit: number): JsonRecord {
  const raw = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = raw.slice(0, limit).filter(isRecord).map(trimRow);

  return { rows };
}

/** One Search Analytics row. */
function trimRow(row: JsonRecord): JsonRecord {
  return {
    keys: Array.isArray(row.keys) ? row.keys : [],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round(row.ctr, 4),
    position: round(row.position, 2),
  };
}

/** Indexed-version fields. Drops the rest of the inspection payload. */
function trimInspection(payload: JsonRecord, inspectionUrl: string): JsonRecord {
  const result = isRecord(payload.inspectionResult) ? payload.inspectionResult : {};
  const index = isRecord(result.indexStatusResult) ? result.indexStatusResult : {};
  const rich = isRecord(result.richResultsResult) ? result.richResultsResult : {};

  return {
    url: inspectionUrl,
    verdict: index.verdict,
    coverageState: index.coverageState,
    indexingState: index.indexingState,
    robotsTxtState: index.robotsTxtState,
    pageFetchState: index.pageFetchState,
    lastCrawlTime: index.lastCrawlTime,
    crawledAs: index.crawledAs,
    googleCanonical: index.googleCanonical,
    userCanonical: index.userCanonical,
    richResultsVerdict: rich.verdict,
  };
}

/** Skip payload for a URL Search Console must not see. */
function rejectUrl(url: string | undefined): JsonRecord | null {
  if (url && safeAuditUrl(url)) {
    return null;
  }

  return { status: 'skipped', reason: 'bad-url' };
}

/** One short line safe to print. */
function shortMessage(raw: string): string {
  let message = raw;

  try {
    const payload = JSON.parse(raw) as { error?: { message?: string } | string };
    const error = payload.error;

    message = typeof error === 'string' ? error : String(error?.message ?? '');
  } catch {
    // Plain text stays as the message.
  }

  return redact(message).replaceAll('\n', ' ').trim().slice(0, 180);
}

/** Rounds a metric. Non-finite values become 0. */
function round(value: unknown, digits: number): number {
  const number = Number(value ?? 0);

  if (!Number.isFinite(number)) {
    return 0;
  }

  const factor = 10 ** digits;

  return Math.round(number * factor) / factor;
}

/** Host without a leading `www.`. */
function stripWww(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '');

  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/** True when both hosts match after `www.` is removed. */
function hostsMatch(left: string, right: string): boolean {
  return Boolean(left) && stripWww(left) === stripWww(right);
}

/** Hostname of a public URL, or empty when the URL is refused. */
function hostOf(url: string): string {
  if (!safeAuditUrl(url)) {
    return '';
  }

  return new URL(url).hostname.toLowerCase();
}

/** True when `pageUrl` is under the URL-prefix property. */
function prefixMatch(site: string, pageUrl: string): boolean {
  let siteParts: URL;
  let pageParts: URL;

  try {
    siteParts = new URL(site);
    pageParts = new URL(pageUrl);
  } catch {
    return false;
  }

  if (!hostsMatch(siteParts.hostname, pageParts.hostname)) {
    return false;
  }

  const sitePath = withSlash(siteParts.pathname || '/');
  const pagePath = withSlash(pageParts.pathname || '/');

  return pagePath.startsWith(sitePath);
}

/** Adds a trailing slash. */
function withSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/** Longer path wins. `https` wins a tie. */
function prefixRank(site: string): number {
  const path = new URL(site).pathname || '/';

  return path.length * 2 + (site.startsWith('https://') ? 1 : 0);
}

/** Skip payload for a failed Search Console call. */
function httpSkip(status: number, message: string): JsonRecord {
  if (status === 403 && /quota project/i.test(message)) {
    return { status: 'skipped', reason: 'quota-project-missing', http: status, message };
  }

  return { status: 'skipped', reason: 'http-error', http: status, message };
}

/** `quota_project_id` from the Application Default Credentials file. */
function adcQuotaProject(): string | undefined {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const path = explicit || defaultAdcPath();
  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as { quota_project_id?: unknown };
    const id = typeof parsed.quota_project_id === 'string' ? parsed.quota_project_id.trim() : '';

    return isGscQuotaProject(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Default gcloud ADC path for this platform. */
function defaultAdcPath(): string {
  const fromSdk = process.env.CLOUDSDK_CONFIG?.trim();

  if (fromSdk) {
    return join(fromSdk, 'application_default_credentials.json');
  }

  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    return join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json');
  }

  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

/** Plain object, not an array. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
