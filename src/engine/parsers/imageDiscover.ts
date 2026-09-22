import * as cheerio from 'cheerio';
import { linkHrefByRel, metaContentByName } from '../../tools/meta/parseMeta.ts';

export interface ImageSignals {
  total: number;
  withAlt: number;
  missingAlt: number;
}

export interface DiscoverSignals {
  maxImagePreviewLarge: boolean;
  hasRepresentativeImage: boolean;
}

/** Counts images and alt-text coverage (with/missing alt). */
export function extractImageSignals($: cheerio.CheerioAPI): ImageSignals {
  let total = 0;
  let withAlt = 0;

  $('img').each((_, el) => {
    const src = $(el).attr('src')?.trim();

    if (!src) {
      return;
    }

    total++;
    const alt = $(el).attr('alt');

    if (alt && alt.trim().length > 0) {
      withAlt++;
    }
  });

  return { total, withAlt, missingAlt: Math.max(0, total - withAlt) };
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
