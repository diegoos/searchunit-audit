import * as cheerio from 'cheerio';
import { hrefWithoutUserinfo } from '../../lib/url.ts';
import { linkHrefByRel, metaContentByName } from '../../tools/meta/parseMeta.ts';
import { collapseWhitespace } from './mainContent.ts';

export interface ImageItem {
  src: string;
  alt: string | null;
  width: string | null;
  height: string | null;
  srcset: string | null;
  loading: string | null;
  /** `fetchpriority` attribute, trimmed, as written. */
  fetchPriority: string | null;
  nearby: string | null;
  hero: boolean;
}

export interface VideoSignal {
  src: string | null;
  poster: string | null;
}

export interface DiscoverSignals {
  maxImagePreviewLarge: boolean;
  hasRepresentativeImage: boolean;
}

export interface ImageSignals {
  total: number;
  /** Images with an `alt` attribute, empty or not. */
  withAlt: number;
  /** Images with `alt=""` (marked decorative). Included in `withAlt`. */
  decorative: number;
  /** Images with no `alt` attribute. */
  missingAlt: number;
  items: ImageItem[];
}

const IMAGE_ITEM_CAP = 40;
const SRCSET_CAP = 240;

function imageAttr(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function firstSrcsetUrl(value: string | null): string | null {
  const candidate = value?.split(',')[0]?.trim().split(/\s+/)[0];

  return candidate || null;
}

function nearbyText($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): string | null {
  const caption = collapseWhitespace($(el).closest('figure').find('figcaption').first().text());

  if (caption) {
    return caption.slice(0, 160);
  }

  const next = collapseWhitespace($(el).next().text());

  return next ? next.slice(0, 160) : null;
}

const CONTENT_REGION = 'main, article, [role="main"]';
const LOGO_HINT = /logo|brand|icon|avatar/i;

/**
 * Hero candidate: inside main content, or inside a header only when the page
 * has no main content region. Logos and icons never count.
 */
function isHeroCandidate(
  $: cheerio.CheerioAPI,
  el: Parameters<cheerio.CheerioAPI>[0],
  hasContentRegion: boolean,
): boolean {
  const node = $(el);
  const hint = `${node.attr('class') ?? ''} ${node.attr('id') ?? ''} ${node.attr('alt') ?? ''} ${node.attr('src') ?? ''}`;

  if (LOGO_HINT.test(hint) || node.closest('nav, a[href="/"]').length > 0) {
    return false;
  }

  const region = hasContentRegion ? CONTENT_REGION : `${CONTENT_REGION}, header`;

  return node.closest(region).length > 0;
}

/** `src`, else a lazy-load `data-src` / `data-lazy-src`, else the first srcset URL. A `data:` placeholder is skipped. */
function imageSource(node: ReturnType<cheerio.CheerioAPI>, srcset: string | null): string | null {
  const candidates = [node.attr('src'), node.attr('data-src'), node.attr('data-lazy-src')]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value && !value.startsWith('data:'));

  return candidates[0] ?? firstSrcsetUrl(srcset ?? imageAttr(node.attr('data-srcset')));
}

/** Counts images and alt-text coverage (with/missing alt). */
export function extractImageSignals($: cheerio.CheerioAPI): ImageSignals {
  let total = 0;
  let withAlt = 0;
  let decorative = 0;
  const items: ImageItem[] = [];
  const hasContentRegion = $(CONTENT_REGION).length > 0;

  let heroSet = false;

  $('img').each((_, el) => {
    const ownSrcset = imageAttr($(el).attr('srcset'));
    const pictureSrcset = imageAttr(
      $(el).closest('picture').find('source[srcset]').first().attr('srcset'),
    );
    const srcset = ownSrcset ?? pictureSrcset;
    const rawSrc = imageSource($(el), srcset);

    if (!rawSrc) {
      return;
    }

    total++;
    const alt = $(el).attr('alt');

    if (alt !== undefined) {
      withAlt++;
    }

    if (alt !== undefined && alt.trim() === '') {
      decorative++;
    }

    if (items.length < IMAGE_ITEM_CAP) {
      const hero = !heroSet && isHeroCandidate($, el, hasContentRegion);

      if (hero) {
        heroSet = true;
      }

      items.push({
        src: hrefWithoutUserinfo(rawSrc) ?? rawSrc,
        alt: alt === undefined ? null : alt.trim(),
        width: imageAttr($(el).attr('width')),
        height: imageAttr($(el).attr('height')),
        srcset: srcset ? srcset.slice(0, SRCSET_CAP) : null,
        loading: imageAttr($(el).attr('loading')),
        fetchPriority: imageAttr($(el).attr('fetchpriority')),
        nearby: nearbyText($, el),
        hero,
      });
    }
  });

  return { total, withAlt, decorative, missingAlt: Math.max(0, total - withAlt), items };
}

const VIDEO_CAP = 10;

function absoluteMedia(value: string | undefined, base: URL): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return hrefWithoutUserinfo(new URL(trimmed, base).href);
  } catch {
    return null;
  }
}

/** Video elements and embedded YouTube or Vimeo frames, at most 10. */
export function extractVideoSignals($: cheerio.CheerioAPI, base: URL): VideoSignal[] {
  const videos: VideoSignal[] = [];

  $('video').each((_, el) => {
    if (videos.length >= VIDEO_CAP) {
      return false;
    }

    const src = $(el).attr('src') || $(el).find('source[src]').attr('src');

    videos.push({
      src: absoluteMedia(src, base),
      poster: absoluteMedia($(el).attr('poster'), base),
    });
  });
  $('iframe[src]').each((_, el) => {
    if (videos.length >= VIDEO_CAP) {
      return false;
    }

    const src = $(el).attr('src') ?? '';

    if (!/youtube|youtu\.be|vimeo/i.test(src)) {
      return;
    }

    videos.push({ src: absoluteMedia(src, base), poster: null });
  });

  return videos;
}

/** Detects Google Discover signals: `max-image-preview:large` and a representative image. */
export function extractDiscoverSignals($: cheerio.CheerioAPI): DiscoverSignals {
  const preview = metaContentByName($, 'robots') ?? '';
  const maxImagePreviewLarge = /max-image-preview:\s*large/i.test(preview);
  const hasRepresentativeImage = Boolean(
    $('meta[property="og:image"]').attr('content')?.trim() || linkHrefByRel($, 'image_src'),
  );

  return { maxImagePreviewLarge, hasRepresentativeImage };
}
