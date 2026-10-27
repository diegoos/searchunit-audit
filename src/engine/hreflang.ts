import { pageKey } from '../lib/url.ts';
import type { AuditedPageSnapshot } from './types.ts';

type HreflangPage = Pick<AuditedPageSnapshot, 'url' | 'hreflangLinks' | 'headerHreflang'>;

/** Language, optional script, optional region (ISO 3166-1 alpha-2 or UN M.49), or `x-default`. */
const HREFLANG_CODE = /^(?:x-default|[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?)$/i;

function pairKey(link: { lang: string; href: string }): string {
  return `${link.lang.toLowerCase()} ${pageKey(link.href) ?? link.href}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);

  return left.size === new Set(b).size && b.every((key) => left.has(key));
}

/**
 * hreflang problems visible on the audited page alone: bad codes, a code
 * mapped to two URLs, no self reference, no `x-default` in a multi-language
 * set, and HTML vs `Link` header sets that differ. Return links on the
 * alternate URLs are not checked (that needs other fetches).
 */
export function hreflangIssues(page: HreflangPage): string[] {
  const links = page.hreflangLinks.length > 0 ? page.hreflangLinks : page.headerHreflang;

  if (links.length === 0) {
    return [];
  }

  const issues: string[] = [];
  const invalid = links.filter((link) => !HREFLANG_CODE.test(link.lang)).map((link) => link.lang);

  if (invalid.length > 0) {
    issues.push(`invalid code: ${[...new Set(invalid)].join(', ')}`);
  }

  const targets = new Map<string, Set<string>>();

  for (const link of links) {
    const lang = link.lang.toLowerCase();
    const set = targets.get(lang) ?? new Set<string>();

    set.add(pageKey(link.href) ?? link.href);
    targets.set(lang, set);
  }

  const conflicting = [...targets].filter(([, set]) => set.size > 1).map(([lang]) => lang);

  if (conflicting.length > 0) {
    issues.push(`code points to more than one URL: ${conflicting.join(', ')}`);
  }

  const self = pageKey(page.url);

  if (!links.some((link) => pageKey(link.href) === self)) {
    issues.push('no self reference');
  }

  const languages = [...targets.keys()].filter((lang) => lang !== 'x-default');

  if (languages.length > 1 && !targets.has('x-default')) {
    issues.push('no x-default');
  }

  if (
    page.hreflangLinks.length > 0 &&
    page.headerHreflang.length > 0 &&
    !sameSet(page.hreflangLinks.map(pairKey), page.headerHreflang.map(pairKey))
  ) {
    issues.push('HTML and Link header sets differ');
  }

  return issues;
}
