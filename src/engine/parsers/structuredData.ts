import * as cheerio from 'cheerio';
import {
  getRulesForType,
  schemaTypeName,
  type SchemaRuleSet,
} from '../../tools/schema/schemaRules.ts';
import type { ParsedSchemaBlock } from '../../tools/schema/parseSchema.ts';

interface StructuredDataBlock {
  type: string | null;
  name: string | null;
  hasRequiredProps: boolean;
  missingProps: string[];
  /** Recommended schema.org props the block lacks. Does not affect `hasRequiredProps`. */
  recommendedMissing: string[];
  sameAs: string[];
  id: string | null;
  headline: string | null;
  price: string | null;
  availability: string | null;
  referencedIds: string[];
}

export interface FaqPair {
  question: string;
  answer: string;
}

export interface StructuredDataSummary {
  jsonld_blocks: number;
  parse_errors: number;
  types: string[];
  blocks: StructuredDataBlock[];
  hasGraph: boolean;
  missingTypeCount: number;
  faqPairs: FaqPair[];
}

export interface MarkupFormats {
  has_microdata: boolean;
  microdata_item_count: number;
  microdata_types: string[];
  has_rdfa: boolean;
  rdfa_property_count: number;
  rdfa_types: string[];
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

/** Required property names missing on both the typed node and the script root. */

function missingRuleProps(
  type: string,
  source: Record<string, unknown>,
  root: Record<string, unknown>,
  select: (rules: SchemaRuleSet) => string[],
): string[] {
  const rules = getRulesForType(schemaTypeName(type));

  if (!rules) {
    return [];
  }

  return select(rules).filter((prop) => !hasProp(source, prop) && !hasProp(root, prop));
}

function missingRequiredProps(
  type: string | null,
  source: Record<string, unknown>,
  root: Record<string, unknown>,
): string[] {
  if (!type) {
    return ['@type'];
  }

  return missingRuleProps(type, source, root, (rules) => rules.required);
}

function missingRecommendedProps(
  type: string,
  source: Record<string, unknown>,
  root: Record<string, unknown>,
): string[] {
  return missingRuleProps(type, source, root, (rules) => rules.recommended);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function decimalString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  return null;
}

function typeIncludes(node: Record<string, unknown>, type: string): boolean {
  const expected = schemaTypeName(type);

  return typeNames(node['@type']).some((name) => schemaTypeName(name) === expected);
}

function nodeForBlockType(root: Record<string, unknown>, type: string): Record<string, unknown> {
  if (typeIncludes(root, type)) {
    return root;
  }

  const graph = root['@graph'];

  if (!Array.isArray(graph)) {
    return root;
  }

  for (const item of graph) {
    const record = asRecord(item);

    if (record && typeIncludes(record, type)) {
      return record;
    }
  }

  return root;
}

function firstOffer(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);

      if (record) {
        return record;
      }
    }

    return null;
  }

  return asRecord(value);
}

function offerField(node: Record<string, unknown>, key: 'price' | 'availability'): string | null {
  const direct = decimalString(node[key]);

  if (direct !== null) {
    return direct;
  }

  const offer = firstOffer(node.offers);

  if (!offer) {
    return null;
  }

  return decimalString(offer[key]);
}

function collectReferencedIds(node: Record<string, unknown>): string[] {
  const ids: string[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }

      return;
    }

    const record = asRecord(value);

    if (!record) {
      return;
    }

    for (const [key, child] of Object.entries(record)) {
      if (key === '@id' && typeof child === 'string') {
        ids.push(child);
      }

      walk(child);
    }
  };
  for (const [key, child] of Object.entries(node)) {
    if (key === '@id') {
      continue;
    }

    walk(child);
  }

  return ids;
}

function schemaBlockFacts(
  node: Record<string, unknown>,
): Pick<StructuredDataBlock, 'id' | 'headline' | 'price' | 'availability' | 'referencedIds'> {
  return {
    id: stringOrNull(node['@id']),
    headline: stringOrNull(node.headline),
    price: offerField(node, 'price'),
    availability: offerField(node, 'availability'),
    referencedIds: collectReferencedIds(node),
  };
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
      const source = nodeForBlockType(asRecord(block.json) ?? obj, type);
      const missingProps = missingRequiredProps(type, source, obj);

      blocks.push({
        type,
        name: typeof obj.name === 'string' ? obj.name.trim() : null,
        hasRequiredProps: missingProps.length === 0,
        missingProps,
        recommendedMissing: missingRecommendedProps(type, source, obj),
        sameAs: [...sameAs],
        ...schemaBlockFacts(source),
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
    faqPairs: faqPairsFrom(schemaBlocks.map((block) => block.json)),
  };
}

const FAQ_PAIR_CAP = 12;

function faqPairsFrom(nodes: unknown[]): FaqPair[] {
  const pairs: FaqPair[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (pairs.length >= FAQ_PAIR_CAP || node === null || node === undefined || seen.has(node)) {
      return;
    }

    if (typeof node === 'object') {
      seen.add(node);
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }

      return;
    }

    const record = asRecord(node);

    if (!record) {
      return;
    }

    const question = stringOrNull(record.name)?.trim();
    const accepted = Array.isArray(record.acceptedAnswer)
      ? asRecord(record.acceptedAnswer[0])
      : asRecord(record.acceptedAnswer);
    const answer = accepted ? stringOrNull(accepted.text)?.trim() : null;
    const isQuestion = typeNames(record['@type']).some(
      (name) => schemaTypeName(name).toLowerCase() === 'question',
    );

    if (isQuestion && question && answer) {
      pairs.push({ question, answer: answer.slice(0, 500) });
    }

    visit(record.mainEntity);
    visit(record['@graph']);
  };
  visit(nodes);

  return pairs;
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
    microdata_types: microdataTypes($),
    has_rdfa,
    rdfa_property_count,
    rdfa_types: rdfaTypes($),
    jsonld_only: structured.jsonld_blocks > 0 && !has_microdata && !has_rdfa,
    jsonld_blocks_missing_type: structured.missingTypeCount,
  };
}

const MARKUP_TYPE_CAP = 20;

function pushMarkupType(types: string[], raw: string): void {
  for (const part of raw.split(/\s+/)) {
    const name = schemaTypeName(part);

    if (!name || types.includes(name) || types.length >= MARKUP_TYPE_CAP) {
      continue;
    }

    types.push(name);
  }
}

function microdataTypes($: cheerio.CheerioAPI): string[] {
  const types: string[] = [];

  $('[itemtype]').each((_, el) => {
    const itemtype = $(el).attr('itemtype')?.trim();

    if (itemtype && isSchemaOrgUri(itemtype)) {
      pushMarkupType(types, itemtype);
    }
  });

  return types;
}

function rdfaTypes($: cheerio.CheerioAPI): string[] {
  const types: string[] = [];
  const vocabScope = hasSchemaOrgVocabScope($);

  $('[typeof]').each((_, el) => {
    const value = $(el).attr('typeof')?.trim();

    if (!value || NON_SCHEMA_META_PROPERTY_PREFIX.test(value)) {
      return;
    }

    if (isSchemaOrgUri(value) || vocabScope) {
      pushMarkupType(types, value);
    }
  });

  return types;
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
