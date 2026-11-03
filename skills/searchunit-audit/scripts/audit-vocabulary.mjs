// Values shared by the audit scripts. workstreams.md defines them in the return schema.
// Keep this file the only copy.
export const CHECK_RESULTS = new Set(['observed', 'not observed', 'insufficient']);
export const EVIDENCE = new Set(['direct', 'proxy', 'lab', 'mixed', 'inferred', 'insufficient']);
export const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
export const RECURRENCE_STATES = new Set(['new', 'recurring', 'worsened', 'improved', 'resolved']);
// A fix that is code, a header, server config, or schema needs a copy-pasteable example.
export const EXAMPLE_KINDS = new Set(['markup', 'header', 'config', 'schema']);
// A finding's level: its severity, or its status when the payload has no severity.
export const findingLevel = (finding) => finding.severity ?? finding.status;

// Loopback targets: localhost, *.localhost, 127.0.0.0/8, and ::1.
export function isLoopbackUrl(url) {
  let host;

  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

// Slugs the run files can decide without judgment: the CLI payloads and the Search Console files.
// prefill-checks.mjs writes a row only when its rule decides the slug. The validator compares a Checks row with that row.
export const MECHANICAL_SLUGS = [
  'viewport',
  'redirects',
  'sitemap-url',
  'html-bytes',
  'speakable',
  'crux',
  'lighthouse-lab',
  'mobile-parity',
  'pagination',
  'hreflang',
  'h1-text',
  'heading-hierarchy',
  'question-headings',
  'schema-inventory',
  'social-tags',
  'llms-txt',
  'url-structure',
  'backlinks',
  'crawl-logs',
  'observed-citations',
  'gbp-nap',
  'conversions',
  'crawler-access',
  'https',
  'iframe-header',
  'title-length-uniqueness',
  'meta-length-uniqueness',
  'platform-aio',
  'platform-chatgpt',
  'platform-copilot',
  'same-as',
  'cannibalization',
  'url-inspection',
];
