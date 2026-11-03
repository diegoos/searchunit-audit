import { describe, expect, test } from 'bun:test';
import {
  isNoindexCombined,
  isPageIndexable,
  mergeRobotsDirectives,
} from '../src/engine/robotsDirective.ts';

describe('mergeRobotsDirectives', () => {
  test('joins meta and header, or returns null when both are empty', () => {
    expect(mergeRobotsDirectives(null, null)).toBeNull();
    expect(mergeRobotsDirectives('  ', null)).toBeNull();
    expect(mergeRobotsDirectives('index', 'nofollow')).toBe('index, nofollow');
  });
});

describe('isNoindexCombined', () => {
  test.each([
    [null, null, undefined, false],
    ['index, follow', null, undefined, false],
    ['noindex', null, undefined, true],
    ['none', null, undefined, true],
    ['noindexifembedded', null, undefined, false],
    [null, 'NOINDEX, nofollow', undefined, true],
    [null, 'googlebot: noindex', undefined, true],
    [null, 'googlebot noindex', undefined, true],
    [null, 'max-image-preview:large', undefined, false],
    [null, 'gptbot: noindex', undefined, false],
    ['index, follow', null, { googlebot: 'noindex' }, true],
    ['index, follow', null, { gptbot: 'noindex' }, false],
  ])('meta %p, header %p, by-bot %p -> %p', (meta, header, byBot, expected) => {
    expect(isNoindexCombined(meta, header, byBot)).toBe(expected);
  });
});

describe('isPageIndexable', () => {
  test.each([
    [404, null, false],
    [200, null, true],
    [200, 'noindex', false],
  ])('status %p, directive %p -> %p', (status, directive, expected) => {
    expect(isPageIndexable(status, directive, null)).toBe(expected);
  });
});
