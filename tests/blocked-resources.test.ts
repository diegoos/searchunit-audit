import { describe, expect, test } from 'bun:test';
import type { DiscoveryBundle } from '../src/engine/discovery.ts';
import { collectFindings } from '../src/engine/findings.ts';
import { parseHtmlPage } from '../src/engine/htmlParser.ts';
import { parseRobots } from '../src/tools/robots/parseRobots.ts';
import { bundleFromHtml } from './engine-fixtures.ts';

const PAGE = 'https://example.com/app';

function bundleWith(html: string, robots: string): DiscoveryBundle {
  const bundle = bundleFromHtml(html);

  bundle.parsedRobots = parseRobots(robots);

  return bundle;
}

function blockedResourcesFinding(bundle: DiscoveryBundle) {
  return collectFindings(bundle, []).find((f) => f.id === 'robots:blocked-resources');
}

describe('sameHostResources', () => {
  test('keeps same-site scripts and stylesheets only', () => {
    const html = `<html><head>
      <script src="/a.js"></script>
      <script src="https://cdn.other.example/x.js"></script>
      <link rel="stylesheet" href="/s.css">
      <link rel="icon" href="/i.png">
    </head><body></body></html>`;

    expect(parseHtmlPage(html, PAGE).sameHostResources).toEqual([
      'https://example.com/a.js',
      'https://example.com/s.css',
    ]);
  });
  test('stops at 30 resources', () => {
    const scripts = Array.from({ length: 40 }, (_, i) => `<script src="/x${i}.js"></script>`);
    const html = `<html><body>${scripts.join('')}</body></html>`;

    expect(parseHtmlPage(html, PAGE).sameHostResources).toHaveLength(30);
  });
});

describe('robots:blocked-resources', () => {
  test('warns when Googlebot is blocked from a same-host script', () => {
    const bundle = bundleWith(
      '<html><head><script src="/static/app.js"></script></head><body></body></html>',
      'User-agent: Googlebot\nDisallow: /static/\n',
    );

    expect(blockedResourcesFinding(bundle)).toMatchObject({
      severity: 'warn',
      detail: expect.stringContaining('https://example.com/static/app.js'),
    });
  });
  test('passes when the resources are allowed', () => {
    const bundle = bundleWith(
      '<html><head><link rel="stylesheet" href="/static/site.css"></head><body></body></html>',
      'User-agent: Googlebot\nDisallow: /private/\n',
    );

    expect(blockedResourcesFinding(bundle)?.severity).toBe('pass');
  });
  test('is info when robots.txt could not be read', () => {
    const bundle = bundleWith(
      '<html><head><script src="/a.js"></script></head><body></body></html>',
      '',
    );

    bundle.parsedRobots = null;
    bundle.auditedPage.robotsStatus = 'error';

    expect(blockedResourcesFinding(bundle)?.severity).toBe('info');
  });
});
