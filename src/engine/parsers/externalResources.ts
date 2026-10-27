import type * as cheerio from 'cheerio';

export type ExternalOriginKind =
  | 'scripts'
  | 'stylesheets'
  | 'frames'
  | 'images'
  | 'fonts'
  | 'media'
  | 'forms';

export interface ExternalResources {
  /** Cross-origin `https://` or `http://` origins per kind, sorted, at most 30 each. */
  scripts: string[];
  stylesheets: string[];
  frames: string[];
  images: string[];
  fonts: string[];
  media: string[];
  forms: string[];
  /** `<script>` elements without `src` that run as JavaScript. */
  inlineScripts: number;
  /** `<style>` elements. */
  inlineStyles: number;
}

const ORIGIN_CAP = 30;
const JS_TYPE = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/;

const ORIGIN_SOURCES: [ExternalOriginKind, string, string][] = [
  ['scripts', 'script[src]', 'src'],
  ['stylesheets', 'link[rel~="stylesheet"][href]', 'href'],
  ['frames', 'iframe[src]', 'src'],
  ['images', 'img[src]', 'src'],
  ['images', 'img[srcset], source[srcset]', 'srcset'],
  ['fonts', 'link[rel~="preload"][as="font"][href]', 'href'],
  ['media', 'video[src], audio[src], video source[src], audio source[src]', 'src'],
  ['forms', 'form[action]', 'action'],
];

/** URLs in one attribute. A srcset keeps the first URL of each candidate. */
function attributeUrls(value: string | undefined, attr: string): string[] {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return [];
  }

  if (attr !== 'srcset') {
    return [trimmed];
  }

  return trimmed
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((url): url is string => Boolean(url));
}

/** Origin of an http(s) URL when it differs from the audited page origin. */
function externalOrigin(value: string, base: URL): string | null {
  try {
    const url = new URL(value, base);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return url.origin === base.origin ? null : url.origin;
  } catch {
    return null;
  }
}

function countInlineScripts($: cheerio.CheerioAPI): number {
  return $('script:not([src])').filter((_, el) => {
    const type = ($(el).attr('type') ?? '').trim().toLowerCase();

    return JS_TYPE.test(type);
  }).length;
}

/**
 * Third-party origin inventory for a CSP review, plus inline script and style
 * counts. Only origins that differ from the audited page are listed.
 */
export function extractExternalResources($: cheerio.CheerioAPI, base: URL): ExternalResources {
  const found: Record<ExternalOriginKind, Set<string>> = {
    scripts: new Set(),
    stylesheets: new Set(),
    frames: new Set(),
    images: new Set(),
    fonts: new Set(),
    media: new Set(),
    forms: new Set(),
  };
  for (const [kind, selector, attr] of ORIGIN_SOURCES) {
    $(selector).each((_, el) => {
      for (const value of attributeUrls($(el).attr(attr), attr)) {
        const origin = externalOrigin(value, base);

        if (origin) {
          found[kind].add(origin);
        }
      }
    });
  }

  const capped = (kind: ExternalOriginKind): string[] =>
    [...found[kind]].toSorted().slice(0, ORIGIN_CAP);

  return {
    scripts: capped('scripts'),
    stylesheets: capped('stylesheets'),
    frames: capped('frames'),
    images: capped('images'),
    fonts: capped('fonts'),
    media: capped('media'),
    forms: capped('forms'),
    inlineScripts: countInlineScripts($),
    inlineStyles: $('style').length,
  };
}
