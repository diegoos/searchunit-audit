import { pageKey } from '../lib/url.ts';
import type { DiscoveryBundle } from './discovery.ts';
import { directiveIsNoindex } from './robotsDirective.ts';
import { makeFinding } from './pageFindings.ts';
import type { AuditedPageSnapshot, Finding, RenderedPage } from './types.ts';

const TITLE = 'Rendered vs raw HTML';
const LINKS_ONLY_SHARE_CAP = 0.2;
const LINK_KEYS_SHOWN = 5;

interface RenderDiffs {
  fail: string[];
  warn: string[];
}

function fieldDiffs(raw: AuditedPageSnapshot, rendered: RenderedPage): RenderDiffs {
  const fail: string[] = [];
  const warn: string[] = [];
  const rawNoindex = directiveIsNoindex(raw.effectiveRobotsDirective);
  const renderedNoindex = directiveIsNoindex(rendered.effectiveRobotsDirective);

  if (rawNoindex && !renderedNoindex) {
    fail.push('noindex in raw HTML, indexable after render (Google may skip the render)');
  }

  if (!rawNoindex && renderedNoindex) {
    fail.push('indexable in raw HTML, noindex after render');
  }

  if (
    raw.canonicalUrl &&
    rendered.canonicalUrl &&
    pageKey(raw.canonicalUrl) !== pageKey(rendered.canonicalUrl)
  ) {
    fail.push(`canonical ${raw.canonicalUrl} vs rendered ${rendered.canonicalUrl}`);
  } else if (!raw.canonicalUrl && rendered.canonicalUrl) {
    warn.push('canonical only after render');
  }

  if (raw.title !== rendered.title) {
    warn.push('title differs');
  }

  if (raw.headings.h1.join(' ') !== (rendered.h1 ?? []).join(' ')) {
    warn.push('H1 differs');
  }

  if (raw.metaDescription !== rendered.metaDescription) {
    warn.push('meta description differs');
  }

  return { fail, warn };
}

function renderedDiffs(raw: AuditedPageSnapshot, rendered: RenderedPage): RenderDiffs {
  const diffs = fieldDiffs(raw, rendered);
  const rawTypes = new Set(raw.structuredData.types.map((type) => type.toLowerCase()));
  const schemaOnlyAfterRender = (rendered.structuredDataTypes ?? []).filter(
    (type) => !rawTypes.has(type.toLowerCase()),
  );
  const renderedWords = rendered.wordCount ?? 0;
  const renderedLinks = rendered.internalLinkCount ?? 0;
  const linksOnly = rendered.linksOnlyAfterRenderCount ?? 0;

  if (schemaOnlyAfterRender.length > 0) {
    diffs.warn.push(
      `schema only after render (AI crawlers do not see it): ${schemaOnlyAfterRender.join(', ')}`,
    );
  }

  if (raw.wordCount * 2 < renderedWords) {
    diffs.warn.push(`raw ${raw.wordCount} words vs ${renderedWords} rendered (text depends on JS)`);
  }

  if (renderedLinks > 0 && linksOnly / renderedLinks > LINKS_ONLY_SHARE_CAP) {
    const keys = (rendered.linksOnlyAfterRender ?? []).slice(0, LINK_KEYS_SHOWN);

    diffs.warn.push(
      `${linksOnly} of ${renderedLinks} internal links only after render: ${keys.join(', ')}`,
    );
  }

  return diffs;
}

/**
 * Raw HTML against the Chrome render. Not rendered (skipped or error) is info
 * with the reason. Feeds `--fail-on` of `seo-check` and `audit` (it is a discovery finding).
 */
export function renderFinding(bundle: DiscoveryBundle): Finding {
  const rendered = bundle.renderedPage;

  if (rendered.status !== 'ok') {
    return makeFinding(
      'discovery',
      'render',
      'info',
      TITLE,
      `render ${rendered.status}: ${rendered.reason ?? 'unknown'}`,
    );
  }

  const { fail, warn } = renderedDiffs(bundle.auditedPage, rendered);

  if (fail.length > 0) {
    return makeFinding('discovery', 'render', 'fail', TITLE, [...fail, ...warn].join('; '));
  }

  if (warn.length > 0) {
    return makeFinding('discovery', 'render', 'warn', TITLE, warn.join('; '));
  }

  return makeFinding('discovery', 'render', 'pass', TITLE, 'raw and rendered HTML agree');
}
