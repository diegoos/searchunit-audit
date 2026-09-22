import type { Check, CheckStatus } from '../types';
import { scoreToCheckStatus, statusWeightedScore } from '../types';
import type { ParsedSchemaBlock } from './parseSchema';
import { getRulesForType, isKnownType } from './schemaRules';

interface SchemaBlockResult {
  index: number;
  types: string[];
  checks: Check[];
  score: number;
  status: CheckStatus;
  raw: string;
  parseError?: string;
}

export interface SchemaAnalysis {
  score: number;
  overallStatus: CheckStatus;
  blocks: SchemaBlockResult[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:Z+.-]+)?$/;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Returns true for parseable absolute URL strings in schema property values. */

function isAbsoluteUrl(val: unknown): boolean {
  return typeof val === 'string' && URL.canParse(val);
}

function contextHasSchemaOrg(context: unknown): boolean {
  if (typeof context === 'string') {
    return context.includes('schema.org');
  }

  if (Array.isArray(context)) {
    return context.some((item) => contextHasSchemaOrg(item));
  }

  if (context && typeof context === 'object') {
    return Object.values(context).some((item) => contextHasSchemaOrg(item));
  }

  return false;
}

function contextCheckDetail(context: unknown, hasContext: boolean): string {
  if (!hasContext) {
    return 'missing or not schema.org';
  }

  if (typeof context === 'string') {
    return context;
  }

  return 'schema.org';
}

/** Reads a top-level property from a JSON-LD node object. */

function deepGet(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }

  return (obj as Record<string, unknown>)[key];
}

/** True when a schema property value counts as present (non-empty string or other value). */
function schemaPropPresent(val: unknown): boolean {
  if (val === undefined || val === null) {
    return false;
  }

  if (typeof val === 'string') {
    return val.trim().length > 0;
  }

  return true;
}

// JSON-LD often wraps several entities in `@graph`; required/recommended props

// live on those nodes, not on the top-level object. Resolve the inspectable

// nodes so prop checks target the right entity.

function getNodes(obj: Record<string, unknown>): Record<string, unknown>[] {
  const graph = obj['@graph'];

  if (Array.isArray(graph)) {
    return graph.filter(
      (n): n is Record<string, unknown> => !!n && typeof n === 'object' && !Array.isArray(n),
    );
  }

  return [obj];
}

/** Returns true when a node declares the given schema.org @type. */

function nodeHasType(node: Record<string, unknown>, type: string): boolean {
  const t = node['@type'];

  if (Array.isArray(t)) {
    return t.includes(type);
  }

  return t === type;
}

const ARTICLE_TYPES = new Set([
  'Article',
  'BlogPosting',
  'NewsArticle',
  'TechArticle',
  'ScholarlyArticle',
  'ReportageNewsArticle',
]);

const URL_FIELDS = ['url', 'logo', 'image', 'sameAs'];

function jsonParseError(block: ParsedSchemaBlock): string | undefined {
  if (block.parseError) {
    return block.parseError;
  }

  if (!block.json || typeof block.json !== 'object' || Array.isArray(block.json)) {
    return 'JSON-LD node is not an object';
  }

  return undefined;
}

function failedParse(block: ParsedSchemaBlock, parseError: string): SchemaBlockResult {
  return {
    index: block.index,
    types: [],
    checks: [{ id: 'valid_json', label: 'valid_json', status: 'fail', detail: parseError }],
    score: 0,
    status: 'fail',
    raw: block.raw,
    parseError,
  };
}

function typeCheck(types: string[]): Check {
  const hasKnownType = types.some((type) => isKnownType(type));
  let detail = `${types.join(', ')} — type not in supported list; property checks skipped`;
  let status: CheckStatus = 'warn';

  if (types.length === 0) {
    detail = 'missing';
    status = 'fail';
  } else if (hasKnownType) {
    detail = types.join(', ');
    status = 'pass';
  }

  return { id: 'type', label: 'type', status, detail, value: types.join(', ') };
}

function propertyChecks(node: Record<string, unknown>, mainType: string | undefined): Check[] {
  if (!mainType) {
    return [];
  }

  const rules = getRulesForType(mainType);

  if (!rules) {
    return [];
  }

  const missingRequired = rules.required.filter((prop) => !schemaPropPresent(deepGet(node, prop)));
  const missingRecommended = rules.recommended.filter(
    (prop) => !schemaPropPresent(deepGet(node, prop)),
  );

  return [
    {
      id: 'required_props',
      label: 'required_props',
      status: missingRequired.length === 0 ? 'pass' : 'fail',
      detail: missingRequired.length === 0 ? 'all present' : missingRequired.join(', '),
    },
    {
      id: 'recommended_props',
      label: 'recommended_props',
      status: missingRecommended.length === 0 ? 'pass' : 'warn',
      detail: missingRecommended.length === 0 ? 'all present' : missingRecommended.join(', '),
    },
  ];
}

function authorIsObject(author: unknown): boolean {
  if (isSchemaObject(author)) {
    return true;
  }

  return Array.isArray(author) && author.length > 0 && author.every(isSchemaObject);
}

function authorCheck(node: Record<string, unknown>): Check {
  const author = deepGet(node, 'author');
  let status: CheckStatus = 'warn';
  let detail = 'missing';

  if (typeof author === 'undefined') {
    status = 'fail';
  } else if (typeof author === 'string') {
    detail = 'author is a plain string — use a Person/Organization object';
  } else if (authorIsObject(author)) {
    status = 'pass';
    detail = 'ok';
  }

  return { id: 'author_object', label: 'author_object', status, detail };
}

function datesCheck(node: Record<string, unknown>): Check {
  const dateModified = deepGet(node, 'dateModified');
  const dateModifiedOk = typeof dateModified === 'string' && ISO_DATE_RE.test(dateModified);
  let status: CheckStatus = 'warn';
  let detail = `unexpected format: ${dateModified}`;

  if (dateModified === undefined) {
    detail = 'dateModified missing';
  } else if (dateModifiedOk) {
    status = 'pass';
    detail = 'ISO 8601 format';
  }

  return { id: 'dates', label: 'dates', status, detail };
}

function articleChecks(node: Record<string, unknown>, types: string[]): Check[] {
  if (!types.some((type) => ARTICLE_TYPES.has(type))) {
    return [];
  }

  return [authorCheck(node), datesCheck(node)];
}

function absoluteUrlCheck(node: Record<string, unknown>): Check {
  const relativeUrls = URL_FIELDS.filter((field) => {
    const value = deepGet(node, field);
    const values = Array.isArray(value) ? value : [value];

    return values.some((item) => typeof item === 'string' && item && !isAbsoluteUrl(item));
  });
  if (relativeUrls.length > 0) {
    return {
      id: 'absolute_urls',
      label: 'absolute_urls',
      status: 'warn',
      detail: `relative URLs in: ${relativeUrls.join(', ')}`,
    };
  }

  return { id: 'absolute_urls', label: 'absolute_urls', status: 'pass', detail: 'ok' };
}

function inspectNode(obj: Record<string, unknown>, types: string[]): Record<string, unknown> {
  const nodes = getNodes(obj);
  const mainType = types.find((type) => isKnownType(type));

  return (mainType ? nodes.find((node) => nodeHasType(node, mainType)) : undefined) ?? obj;
}

/** Runs validation checks for a single parsed JSON-LD block. */
function analyzeBlock(block: ParsedSchemaBlock): SchemaBlockResult {
  const parseError = jsonParseError(block);

  if (parseError) {
    return failedParse(block, parseError);
  }

  const obj = block.json as Record<string, unknown>;
  const node = inspectNode(obj, block.types);
  const mainType = block.types.find((type) => isKnownType(type));
  const context = obj['@context'];
  const hasContext = contextHasSchemaOrg(context);
  const checks: Check[] = [
    { id: 'valid_json', label: 'valid_json', status: 'pass', detail: 'valid' },
    {
      id: 'context',
      label: 'context',
      status: hasContext ? 'pass' : 'fail',
      detail: contextCheckDetail(context, hasContext),
    },
    typeCheck(block.types),
    ...propertyChecks(node, mainType),
    ...articleChecks(node, block.types),
    absoluteUrlCheck(node),
  ];
  const score = statusWeightedScore(checks);

  return {
    index: block.index,
    types: block.types,
    checks,
    score,
    status: scoreToCheckStatus(score),
    raw: block.raw,
  };
}

/** Validates all JSON-LD blocks and returns per-block checks plus overall score. */
export function analyzeSchema(blocks: ParsedSchemaBlock[]): SchemaAnalysis {
  if (blocks.length === 0) {
    return { score: 0, overallStatus: 'fail', blocks: [] };
  }

  const results = blocks.map(analyzeBlock);
  const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const overallStatus = scoreToCheckStatus(avgScore);

  return { score: avgScore, overallStatus, blocks: results };
}
