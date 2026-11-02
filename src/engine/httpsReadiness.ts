import type { ParsedPage } from './htmlParser.ts';
import { isLoopbackHost } from '../ip-policy.ts';
import { isLocalTarget } from './localTarget.ts';

export interface UrlField {
  field: string;
  url: string;
}

/** What breaks when a loopback page is served over HTTPS. Each list is capped at 10. */
export interface HttpsReadiness {
  insecureSubresources: string[];
  insecureUrls: UrlField[];
  devHostUrls: UrlField[];
}

const LIST_CAP = 10;
const JSON_LD_URL_KEYS = ['url', '@id'] as const;

function jsonLdUrls(node: unknown, found: UrlField[] = []): UrlField[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      jsonLdUrls(item, found);
    }

    return found;
  }

  if (!node || typeof node !== 'object') {
    return found;
  }

  const record = node as Record<string, unknown>;

  for (const key of JSON_LD_URL_KEYS) {
    const value = record[key];

    if (typeof value === 'string') {
      found.push({ field: `jsonld.${key}`, url: value });
    }
  }

  for (const value of Object.values(record)) {
    jsonLdUrls(value, found);
  }

  return found;
}

function absoluteUrlFields(page: ParsedPage): UrlField[] {
  const fields: UrlField[] = [];

  if (page.canonicalUrl) {
    fields.push({ field: 'canonical', url: page.canonicalUrl });
  }

  if (page.social.openGraph.url) {
    fields.push({ field: 'og:url', url: page.social.openGraph.url });
  }

  for (const link of page.hreflangLinks) {
    fields.push({ field: `hreflang:${link.lang}`, url: link.href });
  }

  return [...fields, ...jsonLdUrls(page.schemaBlocks.map((block) => block.json))];
}

function parseAbsolute(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * What would break if a loopback page were served over HTTPS. A dev host is a
 * loopback host, or the dev server's own port on any host. Null for any other URL.
 */
export function httpsReadinessOfPage(pageUrl: string, page: ParsedPage): HttpsReadiness | null {
  if (!isLocalTarget(pageUrl)) {
    return null;
  }

  const pagePort = new URL(pageUrl).port;
  const insecureUrls: UrlField[] = [];
  const devHostUrls: UrlField[] = [];

  for (const field of absoluteUrlFields(page)) {
    const url = parseAbsolute(field.url);

    if (!url) {
      continue;
    }

    if (isLoopbackHost(url.hostname) || (pagePort !== '' && url.port === pagePort)) {
      devHostUrls.push(field);
    } else if (url.protocol === 'http:') {
      insecureUrls.push(field);
    }
  }

  // A dev-host absolute subresource (http://localhost:PORT/x.js) also breaks on the
  // production URL, and mixed content skips it because the host is loopback.

  for (const value of page.sameHostResources) {
    const url = parseAbsolute(value);

    if (url && (isLoopbackHost(url.hostname) || (pagePort !== '' && url.port === pagePort))) {
      devHostUrls.push({ field: 'subresource', url: value });
    }
  }

  return {
    insecureSubresources: page.mixedContent.samples.slice(0, LIST_CAP),
    insecureUrls: insecureUrls.slice(0, LIST_CAP),
    devHostUrls: devHostUrls.slice(0, LIST_CAP),
  };
}
