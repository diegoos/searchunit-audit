const DEFAULT_SCHEME = 'https://';

/**
 * Prepends https:// when the user omits a scheme.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${DEFAULT_SCHEME}${trimmed}`;
}

/**
 * Returns true when input parses as http(s) with a hostname.
 */
export function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(normalizeUrl(input));

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clears URL userinfo so credentials never appear in hrefs or reports.
 */
export function stripUserinfo(url: URL): URL {
  url.username = '';
  url.password = '';

  return url;
}

/**
 * Requires a non-empty http(s) URL and returns the normalized href.
 */
export function requireHttpUrl(input: string | undefined): string {
  if (!input || !input.trim()) {
    throw new Error('A URL is required. Example: searchunit schema-check https://example.com');
  }

  if (!isValidHttpUrl(input)) {
    throw new Error(`Invalid URL: ${redactUserinfo(input)}`);
  }

  return stripUserinfo(new URL(normalizeUrl(input))).href;
}

/** Drops userinfo from a parse-failed URL so secrets do not reach stderr. */
function redactUserinfo(input: string): string {
  try {
    return stripUserinfo(new URL(normalizeUrl(input))).href;
  } catch {
    return input.replace(/\/\/[^/?#]*@/u, '//');
  }
}
