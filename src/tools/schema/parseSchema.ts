import * as cheerio from 'cheerio';
import { schemaTypeName } from './schemaRules';

export interface ParsedSchemaBlock {
  index: number;
  raw: string;
  json: unknown;
  parseError?: string;
  types: string[];
}

/** Recursively collects @type values from a JSON-LD object or @graph array. */

function extractTypes(json: unknown): string[] {
  if (!json || typeof json !== 'object') {
    return [];
  }

  const obj = json as Record<string, unknown>;

  if (Array.isArray(obj['@graph'])) {
    return (obj['@graph'] as unknown[]).flatMap((item) => extractTypes(item));
  }

  const type = obj['@type'];

  if (Array.isArray(type)) {
    return type.filter((t): t is string => typeof t === 'string').map((t) => schemaTypeName(t));
  }

  if (typeof type === 'string') {
    return [schemaTypeName(type)];
  }

  return [];
}

/** Expands @graph / top-level arrays into inspectable JSON-LD nodes. */

function expandNodes(json: unknown, context?: unknown): unknown[] {
  if (Array.isArray(json)) {
    return json.flatMap((node) => expandNodes(node, context));
  }

  if (!json || typeof json !== 'object') {
    return [json];
  }

  const obj = json as Record<string, unknown>;
  const ctx = obj['@context'] ?? context;

  if (Array.isArray(obj['@graph'])) {
    return obj['@graph'].flatMap((node) => expandNodes(node, ctx));
  }

  if (ctx !== undefined && obj['@context'] === undefined) {
    return [{ ...obj, '@context': ctx }];
  }

  return [obj];
}

/** Parses JSON-LD text, including CMS wrappers (`<!-- … -->`, CDATA). */
function parseJsonLdText(raw: string): unknown {
  let text = raw.trim();

  if (text.startsWith('<!--') && text.endsWith('-->')) {
    text = text.slice(4, -3).trim();
  }

  if (text.startsWith('<![CDATA[') && text.endsWith(']]>')) {
    text = text.slice(9, -3).trim();
  }

  return JSON.parse(text);
}

/** One JSON.parse per ld+json script (undefined json is a parse failure). */
export function parseJsonLdScripts(
  $: cheerio.CheerioAPI,
): { raw: string; json: unknown | undefined }[] {
  const scripts: { raw: string; json: unknown | undefined }[] = [];

  $('script[type*="ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();

    if (!raw) {
      scripts.push({ raw, json: undefined });

      return;
    }

    try {
      scripts.push({ raw, json: parseJsonLdText(raw) });
    } catch {
      scripts.push({ raw, json: undefined });
    }
  });

  return scripts;
}

/** Builds schema blocks from already-parsed ld+json scripts. */
export function parseSchemaFromScripts(
  scripts: readonly { raw: string; json: unknown | undefined }[],
): ParsedSchemaBlock[] {
  const blocks: ParsedSchemaBlock[] = [];
  let index = 0;

  for (const script of scripts) {
    if (script.json === undefined) {
      blocks.push({
        index,
        raw: script.raw,
        json: null,
        parseError: 'invalid JSON',
        types: [],
      });
      index++;
      continue;
    }

    try {
      for (const node of expandNodes(script.json)) {
        blocks.push({ index, raw: script.raw, json: node, types: extractTypes(node) });
        index++;
      }
    } catch (err) {
      blocks.push({
        index,
        raw: script.raw,
        json: null,
        parseError: err instanceof SyntaxError ? err.message : 'invalid JSON',
        types: [],
      });
      index++;
    }
  }

  return blocks;
}

function parseSchemaFromDom($: cheerio.CheerioAPI): ParsedSchemaBlock[] {
  return parseSchemaFromScripts(parseJsonLdScripts($));
}

/** Extracts and parses JSON-LD blocks from HTML script tags. */
export function parseSchema(html: string): ParsedSchemaBlock[] {
  return parseSchemaFromDom(cheerio.load(html));
}
