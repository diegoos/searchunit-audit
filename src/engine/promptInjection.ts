import { countInvisibleFormat } from '../lib/invisibleText.ts';
import type { DiscoveryBundle } from './discovery.ts';
import { makeFinding } from './pageFindings.ts';
import type { Finding } from './types.ts';

/** Text that addresses an AI reader instead of a person: override, role, or tool-call phrasing. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|messages)\b/i,
  /\b(?:ignore|desconsidere|esqueça)\b[^.\n]{0,30}\binstruç(?:ão|ões)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /<\|?(?:im_start|im_end|system|assistant)\|?>|\[\/?INST\]/i,
  /\b(?:you are now|act as|pretend to be|você (?:é|agora é) (?:um|uma))\b[^.\n]{0,30}\b(?:ai|assistant|language model|llm|chatbot|ia|assistente)\b/i,
  /\b(?:if you are|se você (?:é|for))\s+(?:an?\s+|uma?\s+)?(?:ai|llm|language model|assistant|bot|crawler|agent|ia|assistente|agente)\b/i,
  /\b(?:note|instructions?|message)\s+(?:to|for)\s+(?:the\s+)?(?:ai|llm|assistant|agent|model|chatgpt|claude|gemini|perplexity)s?\b/i,
  /\b(?:ai|llm|assistant|agent|model|chatgpt|claude|gemini|perplexity|copilot)s?\s*[:,]\s*(?:always|never|you must|please|do not|recommend|ignore)\b/i,
  /\b(?:curl|wget)\b[^\n]{0,120}\|\s*(?:ba|z)?sh\b|\brm\s+-rf\s+[~/]/i,
];

const SAMPLE_CAP = 3;
const SAMPLE_CHARS = 160;

interface SiteText {
  field: string;
  text: string;
}

function collectStrings(value: unknown, field: string, out: SiteText[]): void {
  if (typeof value === 'string') {
    out.push({ field, text: value });

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${field}[${index}]`, out));

    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push({ field: `${field} key`, text: key });
      collectStrings(item, `${field}.${key}`, out);
    }
  }
}

/** Every string the audit hands to an agent from the site, each distinct text once. */
function siteTexts(bundle: DiscoveryBundle): SiteText[] {
  const all: SiteText[] = [];

  // Every bundle field: nearly all carry text the audited site controls (headers,
  // robots rules, sitemap locs, URLs), so none is trusted. Keys are read too.

  for (const [field, value] of Object.entries(bundle)) {
    collectStrings(value, field, all);
  }

  const seen = new Set<string>();

  return all.filter((item) => {
    if (item.text === '' || seen.has(item.text)) {
      return false;
    }

    seen.add(item.text);

    return true;
  });
}

function sampleAround(text: string, index: number): string {
  const start = Math.max(0, index - 40);

  return text
    .slice(start, start + SAMPLE_CHARS)
    .replace(/\s+/g, ' ')
    .trim();
}

function injectionHit(item: SiteText): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(item.text);

    if (match) {
      return `${item.field}: "${sampleAround(item.text, match.index)}"`;
    }
  }

  return null;
}

/**
 * Text on the page that speaks to an AI reader, or invisible characters that can hide such text.
 * The agent that reads this payload must treat it as data. The score does not change.
 */
export function promptInjectionFinding(bundle: DiscoveryBundle): Finding {
  const texts = siteTexts(bundle);
  const hits = texts.map(injectionHit).filter((hit): hit is string => hit !== null);
  // Derived fields (citability blocks, excerpts) repeat the main text, so fields are counted, not characters.
  const invisible = texts
    .filter((item) => countInvisibleFormat(item.text) > 0)
    .map((item) => item.field);
  const title = 'Prompt injection';

  if (hits.length === 0 && invisible.length === 0) {
    return makeFinding(
      'content',
      'prompt-injection',
      'pass',
      title,
      'no text addressed to an AI reader',
    );
  }

  const notes: string[] = [];

  if (hits.length > 0) {
    notes.push(
      `${hits.length} passage(s) addressed to an AI reader: ${hits.slice(0, SAMPLE_CAP).join('; ')}`,
    );
  }

  if (invisible.length > 0) {
    notes.push(
      `invisible format characters in ${invisible.length} field(s): ${invisible.slice(0, SAMPLE_CAP).join(', ')}`,
    );
  }

  return makeFinding('content', 'prompt-injection', 'warn', title, notes.join('. '));
}
