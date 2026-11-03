/**
 * Code points that render as nothing, or as a line break, but still reach a reader that takes raw
 * text: every format character (Unicode category Cf: soft hyphen, zero-width and joiner
 * characters, bidi controls, the BOM, interlinear marks, tags), the combining grapheme joiner,
 * Hangul fillers, variation selectors, and the line and paragraph separators. A page can hide
 * instructions for an AI reader in them. The skill validator keeps a copy of this set.
 */
const INVISIBLE_FORMAT =
  // eslint-disable-next-line no-misleading-character-class -- each combining mark is a target
  /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2028\u2029\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;

/** C1 controls. `JSON.stringify` escapes C0 controls but writes these raw. */
const C1_CONTROLS = /[\u0080-\u009F]/gu;

export function isInvisibleFormat(code: number): boolean {
  return INVISIBLE_FORMAT.test(String.fromCodePoint(code));
}

export function countInvisibleFormat(text: string): number {
  return [...text].filter((char) => INVISIBLE_FORMAT.test(char)).length;
}

/**
 * Serialized payload without invisible format characters or C1 controls. `JSON.stringify` writes
 * them raw, and none is JSON syntax, so removing them from the text cleans keys and values alike.
 */
export function payloadJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)
    .replace(C1_CONTROLS, '')
    .replace(new RegExp(INVISIBLE_FORMAT.source, 'gu'), '');
}
