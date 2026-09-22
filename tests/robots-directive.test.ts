import { describe, expect, test } from 'bun:test';
import {
  isNoindexCombined,
  isPageIndexable,
  mergeRobotsDirectives,
} from '../src/engine/robotsDirective.ts';

describe('mergeRobotsDirectives', () => {
  test('joins meta and header or returns null', () => {
    expect(mergeRobotsDirectives(null, null)).toBeNull();
    expect(mergeRobotsDirectives('  ', null)).toBeNull();
    expect(mergeRobotsDirectives('noindex', null)).toBe('noindex');
    expect(mergeRobotsDirectives('index', 'nofollow')).toBe('index, nofollow');
  });
});

describe('isNoindexCombined', () => {
  test('is true only when a robots token is noindex or none', () => {
    expect(isNoindexCombined(null, null)).toBe(false);
    expect(isNoindexCombined('index, follow', null)).toBe(false);
    expect(isNoindexCombined('noindex', null)).toBe(true);
    expect(isNoindexCombined('none', null)).toBe(true);
    expect(isNoindexCombined('noindexifembedded', null)).toBe(false);
    expect(isNoindexCombined(null, 'NOINDEX, nofollow')).toBe(true);
    expect(isNoindexCombined(null, 'googlebot: noindex', undefined)).toBe(true);
    expect(isNoindexCombined(null, 'googlebot noindex')).toBe(true);
    expect(isNoindexCombined(null, 'max-image-preview:large')).toBe(false);
    expect(isNoindexCombined(null, 'gptbot: noindex')).toBe(false);
    expect(isNoindexCombined('index, follow', null, { googlebot: 'noindex' })).toBe(true);
    expect(isNoindexCombined('index, follow', null, { gptbot: 'noindex' })).toBe(false);
  });
  test('isPageIndexable is false for 4xx even without noindex', () => {
    expect(isPageIndexable(404, null, null)).toBe(false);
    expect(isPageIndexable(200, null, null)).toBe(true);
    expect(isPageIndexable(200, 'noindex', null)).toBe(false);
  });
});
