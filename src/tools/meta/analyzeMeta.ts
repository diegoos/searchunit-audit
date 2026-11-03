import type { Check, CheckStatus } from '../types';
import { scoreToCheckStatus, statusWeightedScore } from '../types';
import type { MetaTags } from './parseMeta';
import { hasNoindexDirective, isIndexerBot } from './robotsTokens';
import { pageKey } from '../../lib/url';

export interface MetaAnalysis {
  score: number;
  overallStatus: CheckStatus;
  checks: Check[];
  tags: MetaTags;
}

/** Maps string length to pass/warn/fail against ideal and tolerance ranges. */
function charRange(
  value: string | undefined,
  min: number,
  max: number,
  warnMin: number,
  warnMax: number,
): CheckStatus {
  if (!value) {
    return 'fail';
  }

  const len = value.length;

  if (len >= min && len <= max) {
    return 'pass';
  }

  if (len >= warnMin && len <= warnMax) {
    return 'warn';
  }

  return 'fail';
}

/** Length plus the ideal range when the value is outside it. */
function lengthDetail(value: string | undefined, min: number, max: number): string {
  if (!value) {
    return 'missing';
  }

  const len = value.length;

  if (len >= min && len <= max) {
    return `${len} chars`;
  }

  return `${len} chars (ideal ${min}–${max})`;
}

function tagCheck(
  id: string,
  status: CheckStatus,
  detail: string,
  value: string | undefined,
): Check {
  return { id, label: id, status, detail, value };
}

/** Passes when the tag has a value; otherwise reports `missingStatus`. */
function presenceCheck(id: string, value: string | undefined, missingStatus: CheckStatus): Check {
  return tagCheck(id, value ? 'pass' : missingStatus, value ?? 'missing', value);
}

/** Twitter tag that falls back to its Open Graph twin when the Twitter tag is absent. */
function fallbackCheck(
  id: string,
  value: string | undefined,
  fallback: string | undefined,
  fallbackName: string,
): Check {
  const status: CheckStatus = value || fallback ? 'pass' : 'warn';
  const detail = value ?? (fallback ? `falls back to ${fallbackName}` : 'missing');

  return tagCheck(id, status, detail, value ?? fallback);
}

/**
 * Canonical vs the fetched page: missing is fail; another page (different
 * `pageKey`), another host, or an `http:` canonical on an `https:` page is warn.
 */
function canonicalCheck(canonical: string | undefined, pageUrl: string): Check {
  const base = { id: 'canonical', label: 'canonical', value: canonical };

  if (!canonical) {
    return { ...base, status: 'fail', detail: 'missing' };
  }

  let canonUrl: URL;

  try {
    canonUrl = new URL(canonical, pageUrl);
  } catch {
    return { ...base, status: 'warn', detail: `invalid: ${canonical}` };
  }

  const page = new URL(pageUrl);

  if (canonUrl.hostname !== page.hostname) {
    return { ...base, status: 'warn', detail: `other host: ${canonUrl.href}` };
  }

  if (page.protocol === 'https:' && canonUrl.protocol === 'http:') {
    return { ...base, status: 'warn', detail: `http canonical on https page: ${canonUrl.href}` };
  }

  if (pageKey(canonUrl.href) !== pageKey(page.href)) {
    return { ...base, status: 'warn', detail: `points to another page: ${canonUrl.href}` };
  }

  return { ...base, status: 'pass', detail: canonical };
}

/** `og:url` should name the canonical page (or the fetched page when no canonical). */
function ogUrlCheck(tags: MetaTags, pageUrl: string): Check {
  const base = { id: 'og_url', label: 'og_url', value: tags.ogUrl };

  if (!tags.ogUrl) {
    return { ...base, status: 'warn', detail: 'missing' };
  }

  let target = pageUrl;
  let og: string | null = null;

  try {
    target = tags.canonical ? new URL(tags.canonical, pageUrl).href : pageUrl;
    og = new URL(tags.ogUrl, pageUrl).href;
  } catch {
    return { ...base, status: 'warn', detail: `invalid: ${tags.ogUrl}` };
  }

  if (pageKey(og) !== pageKey(target)) {
    return { ...base, status: 'warn', detail: `differs from canonical: ${og}` };
  }

  return { ...base, status: 'pass', detail: tags.ogUrl };
}

/** Viewport passes only with `width=device-width`; any other viewport is a warn. */
function viewportCheck(viewport: string | undefined): Check {
  if (viewport?.includes('width=device-width')) {
    return tagCheck('viewport', 'pass', viewport, viewport);
  }

  return tagCheck('viewport', viewport ? 'warn' : 'fail', viewport ?? 'missing', viewport);
}

/** Flags `noindex` / `none` in the page robots meta or in an indexer bot meta. */
function robotsMetaCheck(tags: MetaTags): Check {
  const botNoindex = Object.entries(tags.botRobots ?? {}).some(
    ([bot, content]) => isIndexerBot(bot) && hasNoindexDirective(content),
  );
  const hasNoindex = hasNoindexDirective(tags.robotsMeta) || botNoindex;
  const detail = tags.robotsMeta ?? (botNoindex ? 'bot noindex' : 'index, follow (default)');

  return tagCheck('robots_meta', hasNoindex ? 'fail' : 'pass', detail, tags.robotsMeta);
}

function headChecks(tags: MetaTags, pageUrl: string): Check[] {
  return [
    tagCheck(
      'title',
      charRange(tags.title, 50, 60, 10, 70),
      lengthDetail(tags.title, 50, 60),
      tags.title,
    ),
    tagCheck(
      'description',
      charRange(tags.description, 150, 160, 70, 165),
      lengthDetail(tags.description, 150, 160),
      tags.description,
    ),
    canonicalCheck(tags.canonical, pageUrl),
    viewportCheck(tags.viewport),
    presenceCheck('lang', tags.lang, 'warn'),
  ];
}

function openGraphChecks(tags: MetaTags, pageUrl: string): Check[] {
  return [
    presenceCheck('og_title', tags.ogTitle, 'fail'),
    presenceCheck('og_description', tags.ogDescription, 'fail'),
    presenceCheck('og_image', tags.ogImage, 'warn'),
    ogUrlCheck(tags, pageUrl),
    presenceCheck('og_type', tags.ogType, 'warn'),
  ];
}

function twitterChecks(tags: MetaTags): Check[] {
  return [
    presenceCheck('twitter_card', tags.twitterCard, 'warn'),
    fallbackCheck('twitter_title', tags.twitterTitle, tags.ogTitle, 'og:title'),
    fallbackCheck(
      'twitter_description',
      tags.twitterDescription,
      tags.ogDescription,
      'og:description',
    ),
    fallbackCheck('twitter_image', tags.twitterImage, tags.ogImage, 'og:image'),
  ];
}

/** Scores meta tag presence and length against SEO best-practice thresholds. */
export function analyzeMeta(tags: MetaTags, pageUrl: string): MetaAnalysis {
  const checks: Check[] = [
    ...headChecks(tags, pageUrl),
    robotsMetaCheck(tags),
    ...openGraphChecks(tags, pageUrl),
    ...twitterChecks(tags),
  ];
  const score = statusWeightedScore(checks);
  const overallStatus = scoreToCheckStatus(score);

  return { score, overallStatus, checks, tags };
}
