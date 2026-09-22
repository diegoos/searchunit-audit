import * as cheerio from 'cheerio';
import { getRulesForType, schemaTypeName } from '../../tools/schema/schemaRules.ts';
import type { ParsedSchemaBlock } from '../../tools/schema/parseSchema.ts';

interface StructuredDataBlock {
  type: string | null;
  name: string | null;
  hasRequiredProps: boolean;
  sameAs: string[];
}

export interface StructuredDataSummary {
  jsonld_blocks: number;
  parse_errors: number;
  types: string[];
  blocks: StructuredDataBlock[];
  hasGraph: boolean;
  missingTypeCount: number;
}

export interface MarkupFormats {
  has_microdata: boolean;
  microdata_item_count: number;
  has_rdfa: boolean;
  rdfa_property_count: number;
  jsonld_only: boolean;
  jsonld_blocks_missing_type: number;
}

function typeNames(type: unknown): string[] {
  if (typeof type === 'string') {
    return [type];
  }

  if (Array.isArray(type)) {
    return type.filter((t): t is string => typeof t === 'string');
  }

  return [];
}

function hasProp(obj: Record<string, unknown>, key: string): boolean {
  const val = obj[key];

  if (val === undefined || val === null || val === '') {
    return false;
  }

  if (Array.isArray(val)) {
    return val.length > 0;
  }

  return true;
}

/** Recursively collects `sameAs` URLs from a JSON-LD node tree. */

function collectSameAs(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectSameAs(item, acc);
    }

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  const obj = node as Record<string, unknown>;
  const sameAs = obj.sameAs;

  if (typeof sameAs === 'string') {
    acc.add(sameAs);
  } else if (Array.isArray(sameAs)) {
    for (const u of sameAs) {
      if (typeof u === 'string') {
        acc.add(u);
      }
    }
  }

  for (const val of Object.values(obj)) {
    collectSameAs(val, acc);
  }
}

/** Validates required props for recognized schema.org types (Organization, Article, etc). */

function validateRequiredProps(type: string | null, obj: Record<string, unknown>): boolean {
  if (!type) {
    return false;
  }

  const rules = getRulesForType(schemaTypeName(type));

  if (!rules) {
    return true;
  }

  return rules.required.every((prop) => hasProp(obj, prop));
}

/** Collects `@type` on this node and `@graph` items only (not nested properties). */

function collectSchemaTypes(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectSchemaTypes(item, acc);
    }

    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  const obj = node as Record<string, unknown>;

  for (const name of typeNames(obj['@type'])) {
    acc.add(schemaTypeName(name));
  }

  if (Array.isArray(obj['@graph'])) {
    collectSchemaTypes(obj['@graph'], acc);
  }
}

function nodeLooksLikeGraph(node: unknown): boolean {
  if (!node || typeof node !== 'object') {
    return false;
  }

  const obj = node as Record<string, unknown>;

  return Boolean(obj['@graph'] || obj['@id']);
}

function nodeHasSpeakableType(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(nodeHasSpeakableType);
  }

  if (!node || typeof node !== 'object') {
    return false;
  }

  const obj = node as Record<string, unknown>;

  if (typeNames(obj['@type']).some((name) => isSpeakableType(schemaTypeName(name)))) {
    return true;
  }

  return Object.entries(obj).some(([key, val]) => {
    if (key === '@type' || key === '@context') {
      return false;
    }

    return nodeHasSpeakableType(val);
  });
}

/** Builds a structured data summary from expanded schema-check nodes. */
export function extractStructuredData(
  schemaBlocks: readonly ParsedSchemaBlock[],
  scriptCount: number,
): StructuredDataSummary {
  const types = new Set<string>();
  const blocks: StructuredDataBlock[] = [];
  let parseErrors = 0;
  let missingTypeCount = 0;
  let hasGraph = false;

  for (const block of schemaBlocks) {
    if (block.parseError) {
      parseErrors++;
      continue;
    }

    if (nodeLooksLikeGraph(block.json)) {
      hasGraph = true;
    }

    collectSchemaTypes(block.json, types);

    if (block.types.length === 0) {
      missingTypeCount++;
      continue;
    }

    const obj =
      block.json && typeof block.json === 'object' ? (block.json as Record<string, unknown>) : {};
    const sameAs = new Set<string>();

    collectSameAs(obj, sameAs);

    for (const type of block.types) {
      blocks.push({
        type,
        name: typeof obj.name === 'string' ? obj.name.trim() : null,
        hasRequiredProps: validateRequiredProps(type, obj),
        sameAs: [...sameAs],
      });
    }
  }

  return {
    jsonld_blocks: scriptCount,
    parse_errors: parseErrors,
    types: [...types].toSorted(),
    blocks,
    hasGraph,
    missingTypeCount,
  };
}

const NON_SCHEMA_META_PROPERTY_PREFIX = /^(og|fb|twitter):/i;

/** Returns true when a value references schema.org. */

function isSchemaOrgUri(value: string): boolean {
  return value.trim().toLowerCase().includes('schema.org');
}

/** Detects a schema.org vocabulary scope declared on html/head/body via `vocab` or `prefix`. */

function hasSchemaOrgVocabScope($: cheerio.CheerioAPI): boolean {
  for (const selector of ['html', 'head', 'body']) {
    const el = $(selector).first();

    if (!el.length) {
      continue;
    }

    const vocab = el.attr('vocab')?.trim();

    if (vocab && isSchemaOrgUri(vocab)) {
      return true;
    }

    const prefix = el.attr('prefix')?.trim();

    if (prefix && isSchemaOrgUri(prefix)) {
      return true;
    }
  }

  return false;
}

/** Counts schema.org microdata itemscopes (itemtype referencing schema.org). */

function countSchemaOrgMicrodata($: cheerio.CheerioAPI): number {
  let count = 0;

  $('[itemscope]').each((_, el) => {
    const itemtype = $(el).attr('itemtype')?.trim();

    if (itemtype && isSchemaOrgUri(itemtype)) {
      count++;
    }
  });

  return count;
}

/** Counts schema.org RDFa `typeof`/`property` occurrences, honoring a vocab scope. */

function countSchemaOrgRdfa($: cheerio.CheerioAPI): number {
  const vocabScope = hasSchemaOrgVocabScope($);
  let count = 0;

  $('[typeof]').each((_, el) => {
    const typeofAttr = $(el).attr('typeof')?.trim();

    if (!typeofAttr || NON_SCHEMA_META_PROPERTY_PREFIX.test(typeofAttr)) {
      return;
    }

    if (isSchemaOrgUri(typeofAttr) || vocabScope) {
      count++;
    }
  });
  $('[property]').each((_, el) => {
    const prop = $(el).attr('property')?.trim();

    if (!prop || NON_SCHEMA_META_PROPERTY_PREFIX.test(prop)) {
      return;
    }

    const tag = (el as { tagName?: string }).tagName?.toLowerCase();

    if (tag === 'meta' && !vocabScope) {
      if (isSchemaOrgUri(prop)) {
        count++;
      }

      return;
    }

    if (vocabScope || isSchemaOrgUri(prop)) {
      count++;
    }
  });

  return count;
}

/** Summarizes which markup formats (microdata, RDFa, JSON-LD-only) are present. */
export function extractMarkupFormats(
  $: cheerio.CheerioAPI,
  structured: StructuredDataSummary,
): MarkupFormats {
  const microdata_item_count = countSchemaOrgMicrodata($);
  const rdfa_property_count = countSchemaOrgRdfa($);
  const has_microdata = microdata_item_count > 0;
  const has_rdfa = rdfa_property_count > 0;

  return {
    has_microdata,
    microdata_item_count,
    has_rdfa,
    rdfa_property_count,
    jsonld_only: structured.jsonld_blocks > 0 && !has_microdata && !has_rdfa,
    jsonld_blocks_missing_type: structured.missingTypeCount,
  };
}

function isSpeakableType(type: string | null | undefined): boolean {
  return (type ?? '').toLowerCase().includes('speakable');
}

/** Speakable on the page node, `@graph`, or a nested block (SpeakableSpecification). */
export function detectSpeakable(
  structured: StructuredDataSummary,
  schemaBlocks: readonly ParsedSchemaBlock[] = [],
): boolean {
  return (
    structured.types.some((t) => isSpeakableType(t)) ||
    structured.blocks.some((b) => isSpeakableType(b.type)) ||
    schemaBlocks.some((block) => nodeHasSpeakableType(block.json))
  );
}
