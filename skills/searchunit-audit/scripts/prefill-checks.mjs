import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findingLevel, isLoopbackUrl, MECHANICAL_SLUGS } from './audit-vocabulary.mjs';

// Writes checks-prefill.json: one { slug, result, evidence, note } row for each mechanical slug
// that the run files decide: the primary audit payload, the cli-seo-<n>.json context payloads, and
// the Search Console files. A slug they cannot decide gets no row, and a worker judges it.
// Usage: prefill-checks.mjs --cli <cli-audit.json> [--out <checks-prefill.json>]
const OBSERVED = 'observed';
const NOT_OBSERVED = 'not observed';
const INSUFFICIENT = 'insufficient';
const DIRECT = 'direct';
const LAB = 'lab';
const TWO_MIB = 2 * 1024 * 1024;
const SALES_SITE_TYPES = ['saas', 'ecommerce', 'publisher'];
const PROXY = 'proxy';
// workstreams.md title and description bands, in characters.
const TITLE_BAND = [50, 60];
const DESCRIPTION_BAND = [70, 165];
// The five headers that move the technical component on a public URL (workstreams.md iframe-header).
const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
];
const ENTITY_TYPES = ['Organization', 'Person'];
// A sameAs host that points inside a network, never at a public profile (workstreams.md same-as).
const PRIVATE_HOST =
  /^(?:localhost\.?|metadata\.google\.internal\.?|::|::1|::(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}|0\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|198\.(?:18|19)\.\d+\.\d+|2(?:2[4-9]|3\d|4\d|5[0-5])\.\d+\.\d+\.\d+|::ffff:.+|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*|ff[0-9a-f]{2}:.*)$/;
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];

  return value === undefined || value.startsWith('--') ? null : value;
}

const observed = (note, evidence = DIRECT) => ({ result: OBSERVED, evidence, note });
const notObserved = (note, evidence = DIRECT) => ({ result: NOT_OBSERVED, evidence, note });
const undecided = (note) => ({ result: INSUFFICIENT, evidence: INSUFFICIENT, note });

// Ids of the findings that match the pattern and have a level in the list.
function flaggedIds(cli, pattern, levels = ['fail', 'warn']) {
  return (cli.findings ?? [])
    .filter((finding) => pattern.test(finding.id))
    .filter((finding) => levels.includes(findingLevel(finding)))
    .map((finding) => finding.id);
}

function blockerIds(cli) {
  return (cli.blockers ?? []).map((blocker) => blocker.id);
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function viewportRule({ page }) {
  if (typeof page.viewport !== 'boolean') return null;

  return page.viewport
    ? notObserved('Viewport meta tag present.')
    : observed('No viewport meta tag.');
}

function redirectsRule({ cli }) {
  return flaggedIds(cli, /^discovery:redirects$/).length > 0
    ? observed('discovery:redirects warns: a redirect chain is longer than one hop.')
    : notObserved('No redirect chain longer than one hop (discovery:redirects not flagged).');
}

function sitemapUrlRule({ discovery }) {
  const sitemap = discovery.sitemap ?? {};

  if (sitemap.fetchStatus === 'missing') {
    return notObserved('No sitemap file (fetchStatus missing).');
  }
  if (sitemap.fetchStatus === 'error') {
    return undecided('Sitemap fetch failed (fetchStatus error).');
  }
  if (sitemap.audited_url_listed === true) {
    return notObserved('The audited URL is listed in the sitemap.');
  }
  if (sitemap.coverage === 'partial') {
    return undecided(
      `Sitemap read partially (${sitemap.filesRead ?? 'some'} files). The audited URL may be in a file that was not read.`,
    );
  }
  if (sitemap.audited_url_listed === false && sitemap.coverage === 'complete') {
    return observed('The audited URL is missing from every sitemap file read.');
  }

  return null;
}

function htmlBytesRule({ cli, page }) {
  if (blockerIds(cli).includes('oversized_html')) {
    return observed('blocker:oversized_html: the body is above the 2 MiB cap.');
  }
  if (flaggedIds(cli, /^meta:charset$/).length > 0) {
    return observed('meta:charset warns: charset is missing or the header and meta differ.');
  }
  if (typeof page.byteLength !== 'number' || page.byteLength > TWO_MIB) return null;

  return notObserved(
    `Body is ${page.byteLength} bytes, under 2 MiB, and meta:charset is not flagged.`,
  );
}

function speakableRule({ page }) {
  if (typeof page.hasSpeakable !== 'boolean') return null;

  return page.hasSpeakable
    ? notObserved('A Speakable node is in JSON-LD.')
    : observed('No Speakable node in JSON-LD.');
}

function cruxRule({ cli, discovery }) {
  if (cli.cruxApiKeyAvailable === false) {
    return undecided('cruxApiKeyAvailable is false, so there is no field data.');
  }
  // With a key, the CLI still skips CrUX on a loopback URL.
  if (discovery.crux?.status === 'skipped') {
    return undecided('discovery.crux is skipped, so there is no field data.');
  }
  if (blockerIds(cli).includes('poor_core_web_vitals')) {
    return observed('blocker:poor_core_web_vitals: field data has a poor metric.');
  }

  return null;
}

function lighthouseLabRule({ cli }) {
  const lighthouse = cli.lighthouse;

  if (!lighthouse) return null;
  if (lighthouse.status !== 'ok') {
    const reason = lighthouse.reason ? `: ${lighthouse.reason}` : '';

    return undecided(`Lighthouse ${lighthouse.status}${reason}.`);
  }

  const failed = lighthouse.failedAudits ?? [];

  if (failed.length === 0) {
    return notObserved('Lighthouse ran and reports no failed audits.', LAB);
  }

  return observed(`Lighthouse failed audits: ${failed.map((audit) => audit.id).join(', ')}.`, LAB);
}

function mobileParityRule({ cli, discovery }) {
  if (discovery.mobilePage == null) {
    return undecided(`No mobile snapshot: ${discovery.mobileFetchError ?? 'fetch error'}.`);
  }
  if (flaggedIds(cli, /^discovery:mobile$/).length > 0) {
    return observed('discovery:mobile warns or fails: the mobile snapshot differs.');
  }

  return notObserved('discovery:mobile is not flagged: the mobile snapshot matches.');
}

function paginationRule({ page, discovery }) {
  const pagination = page.pagination ?? {};

  if (pagination.next != null || pagination.prev != null) return null;
  if ((page.pageKind ?? discovery.pageKind) === 'listing') {
    return observed('Listing page with no next or prev link.');
  }

  return notObserved('No next or prev link, and the page is not a listing.');
}

function hreflangRule({ cli, page }) {
  if (flaggedIds(cli, /^meta:hreflang$/).length > 0) {
    return observed('meta:hreflang warns or fails on the audited page.');
  }

  const hasMarkup = (page.hreflangLinks ?? []).length > 0 || (page.headerHreflang ?? []).length > 0;

  // Return links on context URLs need judgment, so markup present stays undecided here.
  if (hasMarkup) return null;

  return notObserved(
    'No hreflang markup on the audited page, so the single-language rule applies.',
  );
}

function h1TextRule({ page }) {
  const headings = page.headings ?? {};

  if (typeof headings.h1Count !== 'number' || typeof headings.h1ElementCount !== 'number') {
    return null;
  }
  if (headings.h1ElementCount === 0) return observed('No H1 element on the page.');
  if (headings.h1Count === 0) return observed('H1 element present with no text.');
  if (headings.h1Count > 1) return observed(`${headings.h1Count} H1 texts on the page.`);

  return notObserved('One H1 with text.');
}

function headingHierarchyRule({ cli, page }) {
  if (flaggedIds(cli, /^content:heading-order$/).length > 0) {
    return observed('content:heading-order warns: a heading level is skipped.');
  }

  // The outline stops at 60 headings, so a clean result past that cut stays undecided.
  if ((page.headings?.outline ?? []).length >= 60) return null;

  return notObserved('Heading levels do not skip (content:heading-order not flagged).');
}

function questionHeadingsRule({ page }) {
  const count = page.contentSignals?.question_heading_count;

  if (typeof count !== 'number') return null;
  if (count > 0) return notObserved(`${count} question heading(s) in H2 or H3.`);

  return observed('No question heading in H2 or H3.');
}

function schemaInventoryRule({ page }) {
  const structured = page.structuredData ?? {};
  const types = structured.types ?? [];
  const formats = page.markupFormats ?? structured.markupFormats ?? {};
  const missingType = formats.jsonld_blocks_missing_type ?? 0;
  const otherTypes = [...(formats.microdata_types ?? []), ...(formats.rdfa_types ?? [])];

  if (types.length === 0) return observed('No JSON-LD types on the page.');
  if (missingType > 0) return observed(`${missingType} JSON-LD block(s) with no @type.`);
  if (otherTypes.length > 0 && !otherTypes.some((type) => types.includes(type))) {
    return observed('Microdata or RDFa types share no type with the JSON-LD types.');
  }

  // Type names come from the page, so each one is a JSON string, never bare text.
  return notObserved(`JSON-LD types: ${types.map((type) => JSON.stringify(type)).join(', ')}.`);
}

function socialTagsRule({ cli, page }) {
  if (!page.social) return null;

  const openGraph = page.social.openGraph ?? {};
  const twitter = page.social.twitter ?? {};
  const missing = [
    ['og:title', openGraph.title],
    ['og:image', openGraph.image],
    ['og:type', openGraph.type],
    ['twitter:card', twitter.card],
  ]
    .filter(([, value]) => value == null)
    .map(([name]) => name);

  if (missing.length > 0) return observed(`Missing social tag: ${missing.join(', ')}.`);
  // meta:og_url maps to the canonical slug in cli-facts.md, not to social-tags.
  if (flaggedIds(cli, /^meta:(og_(?!url$)|twitter_|og-image-hero)/).length > 0) {
    return observed('A social tag finding warns or fails.');
  }
  if (page.title && normalize(openGraph.title) !== normalize(page.title)) {
    return observed('og:title differs from the page title.');
  }

  return notObserved('Open Graph and Twitter tags are present and og:title matches the title.');
}

function llmsTxtRule({ cli }) {
  if (flaggedIds(cli, /^(discovery:llms|llms:|llms-full:)/).length > 0) {
    return observed('An llms.txt finding warns or fails.');
  }

  return notObserved('No llms.txt finding warns or fails.');
}

function urlStructureRule({ cli }) {
  const finding = (cli.findings ?? []).find((item) => item.id === 'content:url-structure');
  const level = finding == null ? null : findingLevel(finding);

  if (level === 'warn' || level === 'info') {
    return observed(`content:url-structure is ${level}.`);
  }

  return notObserved('content:url-structure is not flagged.');
}

function lengthRule({ value, band, label, contexts, field }) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  const length = value.trim().length;
  const shared = contexts.filter((page) => normalize(page[field] ?? '') === normalize(value));

  if (length < band[0] || length > band[1]) {
    return observed(`${label} is ${length} characters, outside ${band[0]}-${band[1]}.`);
  }
  if (shared.length > 0) {
    return observed(
      `${label} repeats on a context URL: ${shared.map((page) => page.url).join(', ')}.`,
    );
  }

  return notObserved(`${label} is ${length} characters, and no context URL repeats it.`);
}

function titleLengthRule({ page, contexts }) {
  return lengthRule({
    value: page.title,
    band: TITLE_BAND,
    label: 'Title',
    contexts,
    field: 'title',
  });
}

function metaLengthRule({ page, contexts }) {
  if (page.metaDescription == null || page.metaDescription.trim() === '') {
    return observed('The meta description is empty.');
  }

  return lengthRule({
    value: page.metaDescription,
    band: DESCRIPTION_BAND,
    label: 'Meta description',
    contexts,
    field: 'metaDescription',
  });
}

function crawlerStatuses(discovery) {
  return discovery.crawlerAccess?.crawlers ?? [];
}

function crawlerAccessRule({ discovery }) {
  const crawlers = crawlerStatuses(discovery);

  if (crawlers.length === 0) return null;

  const closed = crawlers.filter((crawler) => crawler.status !== 'allowed');

  return closed.length > 0
    ? observed(
        `Not allowed: ${closed.map((crawler) => `${crawler.bot} ${crawler.status}`).join(', ')}.`,
      )
    : notObserved('Every catalog crawler is allowed for the audited path.');
}

function httpsRule({ cli, page }) {
  const url = page.url ?? cli.url;

  if (typeof url !== 'string') return null;
  if (isLoopbackUrl(url)) {
    const level = (cli.findings ?? []).find((item) => item.id === 'discovery:https');
    const severity = level == null ? null : findingLevel(level);

    if (severity === 'warn')
      return observed('discovery:https warns: a value breaks on the HTTPS production URL.');
    if (severity === 'pass')
      return notObserved('discovery:https passes for the HTTPS production URL.');

    // An info result names a dev host URL or a passive subresource, which the worker judges.
    return null;
  }
  if (!url.startsWith('https://')) return observed('The final URL is not https.');
  if (flaggedIds(cli, /^content:mixed-content$/).length > 0) {
    return observed('content:mixed-content flags an http: subresource on the https page.');
  }

  return notObserved('The final URL is https and content:mixed-content is not flagged.');
}

function iframeHeaderRule({ cli, page }) {
  // No security finding means the header check did not run, so the row stays with the worker.
  if (!(cli.findings ?? []).some((finding) => finding.id.startsWith('security:'))) return null;

  const loopback = isLoopbackUrl(page.url ?? cli.url ?? '');
  const headers = SECURITY_HEADERS.filter(
    (id) => !(loopback && id === 'strict-transport-security'),
  );
  const securityIds = flaggedIds(cli, /^security:/);
  const flagged = headers.filter((id) => securityIds.includes(`security:${id}`));

  return flagged.length > 0
    ? observed(`Missing or weak: ${flagged.join(', ')}.`)
    : notObserved(`Present: ${headers.join(', ')}.`);
}

function crawlerStatus(discovery, bot) {
  return crawlerStatuses(discovery).find((crawler) => crawler.bot === bot)?.status ?? null;
}

function hasEntityType(page) {
  return (page.structuredData?.types ?? []).some((type) => ENTITY_TYPES.includes(type));
}

function platformAioRule({ page, discovery }) {
  const questions = page.contentSignals?.question_heading_count;
  const summary = page.contentSignals?.hasTopSummary;
  const faq = discovery.platform_signals?.faq_pattern;

  if (typeof questions !== 'number' || typeof summary !== 'boolean' || typeof faq !== 'boolean') {
    return null;
  }

  return questions === 0 && !summary && !faq
    ? observed('No question heading, no top summary, and no FAQ pattern.')
    : notObserved(
        'At least one answer format: a question heading, a top summary, or an FAQ pattern.',
      );
}

function platformChatgptRule({ page, discovery }) {
  const bots = ['OAI-SearchBot', 'ChatGPT-User'].map((bot) => [bot, crawlerStatus(discovery, bot)]);

  if (bots.some(([, status]) => status == null)) return null;

  const closed = bots.filter(([, status]) => status !== 'allowed');

  if (closed.length > 0) {
    return observed(
      `Not allowed: ${closed.map(([bot, status]) => `${bot} ${status}`).join(', ')}.`,
    );
  }
  if (!hasEntityType(page) && page.trustPages?.about == null) {
    return observed('No Organization or Person type and no about page link.');
  }

  return notObserved('Both bots are allowed, and the page names its entity.');
}

function platformCopilotRule({ page, discovery }) {
  const bingbot = crawlerStatus(discovery, 'Bingbot');

  if (bingbot == null) return null;
  if (bingbot !== 'allowed') return observed(`Bingbot is ${bingbot}.`);
  if (!hasEntityType(page)) {
    return notObserved('Bingbot is allowed, and the page has no Organization or Person type.');
  }

  const profiles = (page.structuredData?.blocks ?? [])
    .filter((block) => ENTITY_TYPES.includes(block.type))
    .flatMap((block) => block.sameAs ?? []);

  return profiles.some((url) => /linkedin\.com|github\.com/i.test(url))
    ? notObserved('Bingbot is allowed, and the entity sameAs names LinkedIn or GitHub.')
    : observed('The entity sameAs names no LinkedIn or GitHub profile.');
}

// A sameAs value that is not a public https URL: userinfo, another scheme, or a private host.
function isUnsafeSameAs(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    return (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      PRIVATE_HOST.test(host)
    );
  } catch {
    return true;
  }
}

function sameAsRule({ page }) {
  const values = (page.structuredData?.blocks ?? []).flatMap((block) => block.sameAs ?? []);

  if (values.length === 0) return notObserved('No sameAs value in the page JSON-LD.');

  const unsafe = values.filter(isUnsafeSameAs);

  return unsafe.length > 0
    ? observed(`Unsafe sameAs: ${unsafe.map((value) => JSON.stringify(value)).join(', ')}.`)
    : notObserved(`${values.length} sameAs value(s), each a public https URL.`, PROXY);
}

function cannibalizationRule({ gsc }) {
  const rows = gsc.performance?.queryPages?.rows;

  if (!Array.isArray(rows))
    return undecided('Search Console was not used, or it returned no query-page rows.');

  const pagesByQuery = new Map();

  for (const row of rows) {
    const [query, url] = row.keys ?? [];

    if (query == null || url == null || !(row.impressions > 0)) continue;

    pagesByQuery.set(query, new Set([...(pagesByQuery.get(query) ?? []), url]));
  }

  const shared = [...pagesByQuery].filter(([, urls]) => urls.size > 1).map(([query]) => query);

  return shared.length > 0
    ? observed(
        `Queries with impressions on more than one page: ${shared.map((query) => JSON.stringify(query)).join(', ')}.`,
      )
    : notObserved('No query in the top query-page pairs has impressions on more than one page.');
}

function urlInspectionRule({ gsc }) {
  // With an inspection file, the indexed version needs a reader, so the worker judges it.
  if (gsc.inspect != null) return null;

  return undecided(
    gsc.performance == null
      ? 'Search Console was not used, so this run did not read the indexed version.'
      : 'The URL inspection file is absent, so this run did not read the indexed version.',
  );
}

function backlinksRule() {
  return undecided('This run does not fetch an off-page source.');
}

function crawlLogsRule() {
  return undecided('This run has no server logs.');
}

function observedCitationsRule() {
  return undecided('This run has no pasted platform test.');
}

function conversionsRule() {
  return undecided('This run does not read analytics.');
}

function gbpNapRule({ discovery, page }) {
  const siteType = page.siteType ?? discovery.siteType;

  if (!SALES_SITE_TYPES.includes(siteType)) return null;

  return notObserved(`Business type is ${siteType}, not local-business.`);
}

const RULES = new Map([
  ['viewport', viewportRule],
  ['redirects', redirectsRule],
  ['sitemap-url', sitemapUrlRule],
  ['html-bytes', htmlBytesRule],
  ['speakable', speakableRule],
  ['crux', cruxRule],
  ['lighthouse-lab', lighthouseLabRule],
  ['mobile-parity', mobileParityRule],
  ['pagination', paginationRule],
  ['hreflang', hreflangRule],
  ['h1-text', h1TextRule],
  ['heading-hierarchy', headingHierarchyRule],
  ['question-headings', questionHeadingsRule],
  ['schema-inventory', schemaInventoryRule],
  ['social-tags', socialTagsRule],
  ['llms-txt', llmsTxtRule],
  ['url-structure', urlStructureRule],
  ['backlinks', backlinksRule],
  ['crawl-logs', crawlLogsRule],
  ['observed-citations', observedCitationsRule],
  ['gbp-nap', gbpNapRule],
  ['conversions', conversionsRule],
  ['crawler-access', crawlerAccessRule],
  ['https', httpsRule],
  ['iframe-header', iframeHeaderRule],
  ['title-length-uniqueness', titleLengthRule],
  ['meta-length-uniqueness', metaLengthRule],
  ['platform-aio', platformAioRule],
  ['platform-chatgpt', platformChatgptRule],
  ['platform-copilot', platformCopilotRule],
  ['same-as', sameAsRule],
  ['cannibalization', cannibalizationRule],
  ['url-inspection', urlInspectionRule],
]);

// `contexts` are the audited pages of the cli-seo-<n>.json files. `gsc` holds the parsed
// gsc-performance.json and gsc-inspect.json, or null for a file the run did not write.
export function prefillChecks(cli, { contexts = [], gsc = {} } = {}) {
  const discovery = cli.discovery ?? {};
  const context = { cli, discovery, page: discovery.auditedPage ?? {}, contexts, gsc };
  const rows = [];

  for (const slug of MECHANICAL_SLUGS) {
    const rule = RULES.get(slug);

    if (rule == null) throw new Error(`no prefill rule for mechanical slug ${slug}`);

    const verdict = rule(context);

    if (verdict != null) rows.push({ slug, ...verdict });
  }

  return rows;
}

function readJsonIfPresent(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// The context payloads and the Search Console files next to cli-audit.json.
function runFiles(dir) {
  const contexts = readdirSync(dir)
    .filter((name) => /^cli-seo-\d+\.json$/.test(name))
    .map((name) => readJsonIfPresent(join(dir, name))?.discovery?.auditedPage)
    .filter((page) => page != null);

  return {
    contexts,
    gsc: {
      performance: readJsonIfPresent(join(dir, 'gsc-performance.json')),
      inspect: readJsonIfPresent(join(dir, 'gsc-inspect.json')),
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliPath = argValue('--cli');

  if (cliPath == null) {
    process.stderr.write(
      'Usage: prefill-checks.mjs --cli <cli-audit.json> [--out <checks-prefill.json>]\n',
    );
    process.exitCode = 1;
  } else {
    const outPath = argValue('--out') ?? join(dirname(cliPath), 'checks-prefill.json');

    try {
      const cli = JSON.parse(readFileSync(cliPath, 'utf8'));

      writeFileSync(
        outPath,
        `${JSON.stringify(prefillChecks(cli, runFiles(dirname(cliPath))), null, 2)}\n`,
      );
    } catch (error) {
      process.stderr.write(`cannot prefill checks: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
