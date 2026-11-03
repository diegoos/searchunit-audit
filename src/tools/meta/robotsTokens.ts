export const INDEXER_BOTS = new Set(['googlebot', 'bingbot']);

export function isIndexerBot(name: string): boolean {
  return INDEXER_BOTS.has(name.trim().toLowerCase());
}

/**
 * True for robots tokens `noindex` / `none`, including indexer UA prefixes
 * (`googlebot: noindex`). Not `noindexifembedded` or `max-image-preview:large`.
 */
export function hasNoindexDirective(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  return value.split(',').some((raw) => {
    const token = raw.trim().toLowerCase();

    if (token === 'noindex' || token === 'none') {
      return true;
    }

    const prefixed = /^([\w-]+)[:\s]+(noindex|none)$/.exec(token);

    return Boolean(prefixed?.[1] && isIndexerBot(prefixed[1]));
  });
}
