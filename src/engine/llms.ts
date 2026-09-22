import { fetchPublicUrl, classifyWellKnownFetch, type FetchOutcome } from '../lib/fetch.ts';
import { parseLlmsTxt } from '../tools/llmstxt/parseLlmsTxt.ts';
import type { LlmsTxtResult } from './types.ts';

/** 404 is absence, not a parse issue. HTTP/network errors are recorded. */
export function issuesForNonPresentLlms(
  fetchStatus: LlmsTxtResult['fetchStatus'],
  response: FetchOutcome,
): string[] {
  if (fetchStatus !== 'error') {
    return [];
  }

  if (response.ok) {
    return [`llms.txt returned status ${response.status}`];
  }

  return [response.error];
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
    format_valid: false,
    has_title: false,
    has_sections: false,
    has_links: false,
    section_count: 0,
    link_count: 0,
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
    result.format_valid = result.has_title && result.has_sections && result.has_links;

    if (!result.has_title) {
      result.issues.push('Missing title (# Site Name)');
    }

    if (!result.has_sections) {
      result.issues.push('Missing sections (## …)');
    }

    if (!result.has_links) {
      result.issues.push('Missing markdown links');
    }

    return result;
  }

  result.issues.push(...issuesForNonPresentLlms(fetchStatus, response));

  return result;
}
