import type { Check, CheckStatus } from '../types';
import { scoreToCheckStatus, statusWeightedScore } from '../types';
import type { MetaTags } from './parseMeta';
import { hasNoindexDirective, isIndexerBot } from './robotsTokens';

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

/** Scores meta tag presence and length against SEO best-practice thresholds. */

// eslint-disable-next-line complexity -- one check per meta field of the same catalog
export function analyzeMeta(tags: MetaTags, pageUrl: string): MetaAnalysis {
  const checks: Check[] = [];

  // Title — 50-60 chars ideal, warn 10-70
  const titleStatus = charRange(tags.title, 50, 60, 10, 70);

  checks.push({
    id: 'title',
    label: 'title',
    status: titleStatus,
    detail: lengthDetail(tags.title, 50, 60),
    value: tags.title,
  });
  // Description — 150-160 ideal, warn 70-165

  const descStatus = charRange(tags.description, 150, 160, 70, 165);

  checks.push({
    id: 'description',
    label: 'description',
    status: descStatus,
    detail: lengthDetail(tags.description, 150, 160),
    value: tags.description,
  });
  // Canonical

  let canonicalStatus: CheckStatus = 'fail';

  if (tags.canonical) {
    try {
      const canonUrl = new URL(tags.canonical, pageUrl);
      const pageOrigin = new URL(pageUrl);

      canonicalStatus = canonUrl.hostname === pageOrigin.hostname ? 'pass' : 'warn';
    } catch {
      canonicalStatus = 'warn';
    }
  }

  checks.push({
    id: 'canonical',
    label: 'canonical',
    status: canonicalStatus,
    detail: tags.canonical ?? 'missing',
    value: tags.canonical,
  });
  // Viewport

  const viewportOk = tags.viewport?.includes('width=device-width');
  let viewportStatus: CheckStatus = 'fail';

  if (viewportOk) {
    viewportStatus = 'pass';
  } else if (tags.viewport) {
    viewportStatus = 'warn';
  }

  checks.push({
    id: 'viewport',
    label: 'viewport',
    status: viewportStatus,
    detail: tags.viewport ?? 'missing',
    value: tags.viewport,
  });
  // Lang

  checks.push({
    id: 'lang',
    label: 'lang',
    status: tags.lang ? 'pass' : 'warn',
    detail: tags.lang ?? 'missing',
    value: tags.lang,
  });
  // Robots meta — flag noindex

  const botNoindex = Object.entries(tags.botRobots ?? {}).some(
    ([bot, content]) => isIndexerBot(bot) && hasNoindexDirective(content),
  );
  const hasNoindex = hasNoindexDirective(tags.robotsMeta) || botNoindex;

  checks.push({
    id: 'robots_meta',
    label: 'robots_meta',
    status: hasNoindex ? 'fail' : 'pass',
    detail: tags.robotsMeta ?? (botNoindex ? 'bot noindex' : 'index, follow (default)'),
    value: tags.robotsMeta,
  });
  // OG: title

  checks.push({
    id: 'og_title',
    label: 'og_title',
    status: tags.ogTitle ? 'pass' : 'fail',
    detail: tags.ogTitle ?? 'missing',
    value: tags.ogTitle,
  });
  // OG: description

  checks.push({
    id: 'og_description',
    label: 'og_description',
    status: tags.ogDescription ? 'pass' : 'fail',
    detail: tags.ogDescription ?? 'missing',
    value: tags.ogDescription,
  });
  // OG: image

  checks.push({
    id: 'og_image',
    label: 'og_image',
    status: tags.ogImage ? 'pass' : 'warn',
    detail: tags.ogImage ?? 'missing',
    value: tags.ogImage,
  });
  // OG: url

  checks.push({
    id: 'og_url',
    label: 'og_url',
    status: tags.ogUrl ? 'pass' : 'warn',
    detail: tags.ogUrl ?? 'missing',
    value: tags.ogUrl,
  });
  // OG: type

  checks.push({
    id: 'og_type',
    label: 'og_type',
    status: tags.ogType ? 'pass' : 'warn',
    detail: tags.ogType ?? 'missing',
    value: tags.ogType,
  });
  // Twitter: card

  checks.push({
    id: 'twitter_card',
    label: 'twitter_card',
    status: tags.twitterCard ? 'pass' : 'warn',
    detail: tags.twitterCard ?? 'missing',
    value: tags.twitterCard,
  });
  // Twitter: title

  checks.push({
    id: 'twitter_title',
    label: 'twitter_title',
    status: tags.twitterTitle || tags.ogTitle ? 'pass' : 'warn',
    detail: tags.twitterTitle ?? (tags.ogTitle ? 'falls back to og:title' : 'missing'),
    value: tags.twitterTitle ?? tags.ogTitle,
  });
  // Twitter: description

  checks.push({
    id: 'twitter_description',
    label: 'twitter_description',
    status: tags.twitterDescription || tags.ogDescription ? 'pass' : 'warn',
    detail:
      tags.twitterDescription ?? (tags.ogDescription ? 'falls back to og:description' : 'missing'),
    value: tags.twitterDescription ?? tags.ogDescription,
  });
  // Twitter: image

  checks.push({
    id: 'twitter_image',
    label: 'twitter_image',
    status: tags.twitterImage || tags.ogImage ? 'pass' : 'warn',
    detail: tags.twitterImage ?? (tags.ogImage ? 'falls back to og:image' : 'missing'),
    value: tags.twitterImage ?? tags.ogImage,
  });
  const score = statusWeightedScore(checks);
  const overallStatus = scoreToCheckStatus(score);

  return { score, overallStatus, checks, tags };
}
