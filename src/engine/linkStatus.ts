import { fetchPublicUrl } from '../lib/fetch.ts';
import { pageKey } from '../lib/url.ts';
import type { LinkCheck, LinkStatusReport, PageLink } from './types.ts';

/** Most same-site links probed per audit. */
const INTERNAL_LINK_CHECK_CAP = 25;

const LINK_CHECK_TIMEOUT_MS = 5000;
const LINK_CHECK_CONCURRENCY = 6;

export function skippedLinkStatus(): LinkStatusReport {
  return { status: 'skipped', checked: 0, candidates: 0, results: [] };
}

function candidates(
  links: readonly PageLink[],
  cap: number,
  skip: Set<string>,
): { href: string }[] {
  const out: { href: string }[] = [];

  for (const link of links) {
    const key = pageKey(link.href) ?? link.href;

    if (skip.has(key)) {
      continue;
    }

    skip.add(key);
    out.push({ href: link.href });

    if (out.length >= cap) {
      break;
    }
  }

  return out;
}

async function probe(href: string, scope: LinkCheck['scope']): Promise<LinkCheck> {
  try {
    const res = await fetchPublicUrl(href, {
      allowHttpErrors: true,
      headersOnly: true,
      timeoutMs: LINK_CHECK_TIMEOUT_MS,
    });
    if (!res.ok) {
      return {
        href,
        scope,
        status: res.status ?? null,
        finalUrl: null,
        redirects: 0,
        error: res.error,
      };
    }

    return {
      href,
      scope,
      status: res.status,
      finalUrl: res.finalUrl,
      redirects: Math.max(0, res.redirectChain.length - 1),
      error: null,
    };
  } catch {
    return { href, scope, status: null, finalUrl: null, redirects: 0, error: 'network' };
  }
}

/**
 * Status-only GET of the first same-site links on the audited page (body
 * dropped). Outbound links are never requested: the audit only counts them.
 * Results keep page link order, so the same page gives the same list. A link
 * to the audited page itself is skipped.
 */
export async function checkPageLinks(
  pageUrl: string,
  internalLinks: readonly PageLink[],
): Promise<LinkStatusReport> {
  const skip = new Set([pageKey(pageUrl) ?? pageUrl]);
  const queue = candidates(internalLinks, INTERNAL_LINK_CHECK_CAP, skip);
  const results: LinkCheck[] = [];

  for (let index = 0; index < queue.length; index += LINK_CHECK_CONCURRENCY) {
    const batch = queue.slice(index, index + LINK_CHECK_CONCURRENCY);

    results.push(...(await Promise.all(batch.map((item) => probe(item.href, 'internal')))));
  }

  return {
    status: 'completed',
    checked: results.length,
    candidates: internalLinks.length,
    results,
  };
}
