import type * as cheerio from 'cheerio';

export interface HeadingOutlineItem {
  level: number;
  text: string;
}

export interface MixedContent {
  /** `http:` scripts, stylesheets, frames, and objects on an `https:` page. */
  activeCount: number;
  /** `http:` images, audio, and video on an `https:` page. */
  passiveCount: number;
  samples: string[];
}

export interface HiddenText {
  /** Elements hidden by inline style or the `hidden` attribute that hold 50+ characters. */
  elementCount: number;
  samples: string[];
}

export interface TrustPages {
  about: string | null;
  contact: string | null;
  privacy: string | null;
  terms: string | null;
}

const OUTLINE_CAP = 60;
const HEADING_TEXT_CAP = 160;
const MIXED_SAMPLE_CAP = 10;
const HIDDEN_SAMPLE_CAP = 3;
const HIDDEN_MIN_CHARS = 50;
const SAMPLE_TEXT_CAP = 120;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** H1–H6 in document order, empty headings kept as an empty `text`. */
export function extractHeadingOutline($: cheerio.CheerioAPI): HeadingOutlineItem[] {
  return $('h1, h2, h3, h4, h5, h6')
    .slice(0, OUTLINE_CAP)
    .toArray()
    .map((el) => ({
      level: Number(el.tagName.slice(1)),
      text: collapse($(el).text()).slice(0, HEADING_TEXT_CAP),
    }));
}

/** First level jump of more than one step after the first heading, e.g. H1 then H3. */
export function firstHeadingSkip(
  outline: readonly HeadingOutlineItem[],
): { from: number; to: number; text: string } | null {
  for (let index = 1; index < outline.length; index++) {
    const previous = outline[index - 1]!;
    const current = outline[index]!;

    if (current.level > previous.level + 1) {
      return { from: previous.level, to: current.level, text: current.text };
    }
  }

  return null;
}

const ACTIVE_SOURCES: readonly [string, string][] = [
  ['script[src]', 'src'],
  ['link[rel~="stylesheet"][href]', 'href'],
  ['iframe[src]', 'src'],
  ['object[data]', 'data'],
  ['embed[src]', 'src'],
];

const PASSIVE_SOURCES: readonly [string, string][] = [
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['audio[src]', 'src'],
];

function insecureUrls($: cheerio.CheerioAPI, sources: readonly [string, string][]): string[] {
  const urls: string[] = [];

  for (const [selector, attr] of sources) {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr)?.trim() ?? '';

      if (/^http:\/\//i.test(value)) {
        urls.push(value);
      }
    });
  }

  return urls;
}

/** Plain `http:` subresources. Empty unless the page itself is `https:`. */
export function extractMixedContent($: cheerio.CheerioAPI, base: URL): MixedContent {
  if (base.protocol !== 'https:') {
    return { activeCount: 0, passiveCount: 0, samples: [] };
  }

  const active = insecureUrls($, ACTIVE_SOURCES);
  const passive = insecureUrls($, PASSIVE_SOURCES);

  return {
    activeCount: active.length,
    passiveCount: passive.length,
    samples: [...active, ...passive].slice(0, MIXED_SAMPLE_CAP),
  };
}

const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const HIDDEN_UI =
  'nav, header, footer, dialog, menu, template, noscript, [role="dialog"], [role="menu"]';

/**
 * Substantive text hidden by inline CSS or the `hidden` attribute, outside
 * nav, dialogs, and menus. Class-based CSS hiding is not visible in static
 * HTML, so this is a lower bound.
 */
export function extractHiddenText($: cheerio.CheerioAPI): HiddenText {
  const samples: string[] = [];
  let elementCount = 0;

  $('body [style], body [hidden]').each((_, el) => {
    const node = $(el);

    if (!isHidden($, el) || node.closest(HIDDEN_UI).length > 0) {
      return;
    }

    // Count the outermost hidden element only.

    if (node.parents('[hidden], [style]').filter((_, parent) => isHidden($, parent)).length > 0) {
      return;
    }

    const text = collapse(node.text());

    if (text.length < HIDDEN_MIN_CHARS) {
      return;
    }

    elementCount++;

    if (samples.length < HIDDEN_SAMPLE_CAP) {
      samples.push(text.slice(0, SAMPLE_TEXT_CAP));
    }
  });

  return { elementCount, samples };
}

function isHidden($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const node = $(el);

  return node.is('[hidden]') || HIDDEN_STYLE.test(node.attr('style') ?? '');
}

/** `<meta charset>` or the charset in a `Content-Type` http-equiv meta. */
export function extractCharset($: cheerio.CheerioAPI): string | null {
  const direct = $('meta[charset]').first().attr('charset')?.trim();

  if (direct) {
    return direct.toLowerCase();
  }

  const equiv = $('meta[http-equiv]')
    .filter((_, el) => ($(el).attr('http-equiv') ?? '').toLowerCase() === 'content-type')
    .first()
    .attr('content');
  const match = equiv?.match(/charset=([^;\s]+)/i);

  return match?.[1]?.toLowerCase() ?? null;
}

const TRUST_LABELS: Record<keyof TrustPages, readonly string[]> = {
  about: ['about', 'about-us', 'sobre', 'sobre-nos', 'quem-somos'],
  contact: ['contact', 'contact-us', 'contato', 'fale-conosco', 'contacto'],
  privacy: ['privacy', 'privacy-policy', 'privacidade', 'politica-de-privacidade', 'lgpd', 'gdpr'],
  terms: ['terms', 'terms-of-service', 'terms-of-use', 'termos', 'termos-de-uso', 'condicoes'],
};

/** Lowercase words joined by `-`, accents removed: "Política de Privacidade" becomes `politica-de-privacidade`. */
function labelSlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Slug of each path segment, extension dropped: `/en/about.html` gives `['', 'en', 'about']`. */
function pathSlugs(pathname: string): string[] {
  return pathname
    .split('/')
    .map((segment) => labelSlug(safeDecode(segment).replace(/\.[a-z0-9]+$/i, '')));
}

function siteHost(value: URL): string {
  return value.hostname.replace(/^www\./i, '').toLowerCase();
}

function sameSite(url: URL, base: URL): boolean {
  return siteHost(url) === siteHost(base);
}

/**
 * First same-site link per trust page. A label matches a whole URL path segment,
 * or the whole anchor text. A headline that only contains a label word does not match.
 */
export function extractTrustPages($: cheerio.CheerioAPI, base: URL): TrustPages {
  const found: TrustPages = { about: null, contact: null, privacy: null, terms: null };
  const keys = Object.keys(TRUST_LABELS) as (keyof TrustPages)[];

  $('a[href]').each((_, el) => {
    let url: URL;

    try {
      url = new URL($(el).attr('href') ?? '', base);
    } catch {
      return;
    }

    if (!/^https?:$/.test(url.protocol) || !sameSite(url, base)) {
      return;
    }

    const textSlug = labelSlug(collapse($(el).text()));
    const segments = pathSlugs(url.pathname);

    for (const key of keys) {
      const labels = TRUST_LABELS[key];

      if (
        found[key] === null &&
        (labels.includes(textSlug) || labels.some((label) => segments.includes(label)))
      ) {
        url.username = '';
        url.password = '';
        found[key] = url.href;
      }
    }
  });

  return found;
}
