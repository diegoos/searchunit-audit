import {
  fetchErrorCode,
  fetchPublicUrl,
  classifyWellKnownFetch,
  type FetchOutcome,
} from '../lib/fetch.ts';
import { hrefWithoutUserinfo, pageKey } from '../lib/url.ts';
import {
  parseLlmsTxt,
  type LlmsSyntaxError,
  type ParsedLlmsTxt,
} from '../tools/llmstxt/parseLlmsTxt.ts';
import type { LlmsTxtIssue, LlmsTxtResult } from './types.ts';

const LLMS_LINK_CAP = 100;
const ISSUE_TEXT_CAP = 120;

function structuralIssue(code: string): LlmsTxtIssue {
  return { code, line: null, text: null };
}

/** Syntax error from the parser, with its line and snippet. */
function syntaxIssue(error: LlmsSyntaxError): LlmsTxtIssue {
  const text = (error.snippet ?? error.section ?? '').trim().slice(0, ISSUE_TEXT_CAP);

  return { code: error.code, line: error.line, text: text || null };
}

/** Capped `{ title, url }` list from parsed llms.txt links. Drops notes. */
export function cappedLlmsLinks(
  links: readonly { title: string; url: string }[],
  pageUrl = '',
): {
  links: { title: string; url: string }[];
  linksTruncated: boolean;
  linksToAuditedUrl: boolean;
} {
  const auditedKey = pageUrl ? pageKey(pageUrl) : null;
  const linksToAuditedUrl =
    auditedKey !== null && links.some((link) => pageKey(link.url) === auditedKey);
  const capped = links.slice(0, LLMS_LINK_CAP).map((link) => ({
    title: link.title,
    url: hrefWithoutUserinfo(link.url) ?? link.url,
  }));

  return { links: capped, linksTruncated: links.length > capped.length, linksToAuditedUrl };
}

/** Missing title, sections, or links, then every syntax error with its line. */
export function parsedLlmsIssues(parsed: ParsedLlmsTxt): LlmsTxtIssue[] {
  const structural: LlmsTxtIssue[] = [];

  if (!parsed.h1) {
    structural.push(structuralIssue('missing_title'));
  }

  if (parsed.sections.length === 0) {
    structural.push(structuralIssue('missing_sections'));
  }

  if (parsed.links.length === 0) {
    structural.push(structuralIssue('missing_links'));
  }

  return [...structural, ...parsed.syntaxErrors.map(syntaxIssue)];
}

/** 404 is absence, not a parse issue. HTTP/network errors are recorded. */
export function issuesForNonPresentLlms(
  fetchStatus: LlmsTxtResult['fetchStatus'],
  response: FetchOutcome,
): LlmsTxtIssue[] {
  if (fetchStatus !== 'error') {
    return [];
  }

  if (response.ok) {
    return [{ code: 'http_status', line: null, text: String(response.status) }];
  }

  return [structuralIssue(response.error)];
}

/**
 * Fetches /llms.txt and /llms-full.txt using the CLI SSRF-safe client.
 */
export async function fetchLlmsTxt(siteUrl: string): Promise<LlmsTxtResult> {
  const parsed = new URL(siteUrl);
  const base = `${parsed.protocol}//${parsed.host}`;
  const llmsUrl = `${base}/llms.txt`;
  const llmsFullUrl = `${base}/llms-full.txt`;

  const result: LlmsTxtResult = {
    url: llmsUrl,
    exists: false,
    fetchStatus: 'missing',
    fetchError: null,
    format_valid: false,
    has_title: false,
    has_sections: false,
    has_links: false,
    section_count: 0,
    link_count: 0,
    links: [],
    linksTruncated: false,
    linksToAuditedUrl: false,
    issues: [],
    content: null,
    full_content: null,
    contentType: '',
    full_version: { url: llmsFullUrl, exists: false, contentType: '' },
  };
  const [response, full] = await Promise.all([
    fetchPublicUrl(llmsUrl, { allowHttpErrors: true }),
    fetchPublicUrl(llmsFullUrl, { allowHttpErrors: true }),
  ]);
  const fetchStatus = classifyWellKnownFetch(response, '/llms.txt');

  result.fetchStatus = fetchStatus;
  result.fetchError = fetchStatus === 'error' ? fetchErrorCode(response) : null;
  result.full_version.exists = classifyWellKnownFetch(full, '/llms-full.txt') === 'present';

  if (result.full_version.exists && full.ok) {
    result.full_content = full.body;
    result.full_version.contentType = full.contentType;
  }

  if (fetchStatus === 'present' && response.ok) {
    const content = response.body;

    result.content = content;
    result.contentType = response.contentType;
    result.exists = true;
    const parsedLlms = parseLlmsTxt(content);

    result.has_title = Boolean(parsedLlms.h1);
    result.section_count = parsedLlms.sections.length;
    result.has_sections = parsedLlms.sections.length > 0;
    result.link_count = parsedLlms.links.length;
    result.has_links = parsedLlms.links.length > 0;
    const capped = cappedLlmsLinks(parsedLlms.links, siteUrl);

    result.links = capped.links;
    result.linksTruncated = capped.linksTruncated;
    result.linksToAuditedUrl = capped.linksToAuditedUrl;
    result.format_valid = result.has_title && result.has_sections && result.has_links;

    result.issues.push(...parsedLlmsIssues(parsedLlms));

    return result;
  }

  result.issues.push(...issuesForNonPresentLlms(fetchStatus, response));

  return result;
}
