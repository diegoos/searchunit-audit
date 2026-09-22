import { describe, expect, test } from 'bun:test';
import { analyzeSchema } from '../src/tools/schema/analyzeSchema.ts';
import { parseSchema } from '../src/tools/schema/parseSchema.ts';
import { getRulesForType, isKnownType } from '../src/tools/schema/schemaRules.ts';

const ORG_HTML = `

<html>

  <script type="application/ld+json">

  {

    "@context": "https://schema.org",

    "@type": "Organization",

    "name": "Example Org",

    "url": "https://example.com",

    "logo": "https://example.com/logo.svg",

    "sameAs": ["https://twitter.com/example"]
  }

  </script>
</html>
`;

describe('parseSchema', () => {
  test('extracts JSON-LD blocks with types and no parse error', () => {
    const blocks = parseSchema(ORG_HTML);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.index).toBe(0);
    expect(blocks[0]?.types).toContain('Organization');
    expect(blocks[0]?.parseError).toBeUndefined();
    expect(blocks[0]?.json).toMatchObject({ name: 'Example Org' });
    expect(blocks[0]?.raw).toContain('Organization');
  });
  test('reports parse error for invalid JSON', () => {
    const html = `<html><script type="application/ld+json">{invalid}</script></html>`;
    const blocks = parseSchema(html);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.parseError).toBeDefined();
    expect(blocks[0]?.json).toBeNull();
    expect(blocks[0]?.types).toEqual([]);
  });
  test('returns empty array when no JSON-LD is present', () => {
    expect(parseSchema('<html></html>')).toEqual([]);
  });
  test('splits @graph into one block per entity', () => {
    const html = `<html><script type="application/ld+json">{
      "@context":"https://schema.org",
      "@graph":[
        {"@type":"NewsArticle","headline":"News","author":{"@type":"Person","name":"Desk"},"datePublished":"2026-09-10"},
        {"@type":"Organization","name":"G1","url":"https://g1.globo.com"}
      ]
    }</script></html>`;

    const blocks = parseSchema(html);

    expect(blocks.map((block) => block.types[0])).toEqual(['NewsArticle', 'Organization']);
  });
});

describe('schemaRules', () => {
  test('getRulesForType returns required and recommended props', () => {
    expect(getRulesForType('Organization')).toEqual({
      required: ['name', 'url'],
      recommended: ['logo', 'sameAs', 'contactPoint', 'description'],
    });
    expect(getRulesForType('NewsArticle')?.required).toEqual([
      'headline',
      'datePublished',
      'author',
    ]);
    expect(getRulesForType('ReportageNewsArticle')).toEqual(getRulesForType('NewsArticle'));
    expect(getRulesForType('UnknownType')).toBeNull();
  });
  test('isKnownType is true for aliases and false for unknown types', () => {
    expect(isKnownType('Organization')).toBe(true);
    expect(isKnownType('ReportageNewsArticle')).toBe(true);
    expect(isKnownType('NotAType')).toBe(false);
  });
});

describe('analyzeSchema', () => {
  test('returns score overallStatus and block checks for valid Organization', () => {
    const analysis = analyzeSchema(parseSchema(ORG_HTML));

    expect(analysis.score).toBeGreaterThanOrEqual(70);
    expect(['pass', 'warn', 'fail']).toContain(analysis.overallStatus);
    expect(analysis.blocks).toHaveLength(1);
    const block = analysis.blocks[0]!;

    expect(block.types).toContain('Organization');
    expect(block.score).toBeGreaterThanOrEqual(0);
    expect(['pass', 'warn']).toContain(block.status);
    expect(block.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(['valid_json', 'required_props']),
    );
    expect(block.checks.find((check) => check.id === 'valid_json')?.status).toBe('pass');
    expect(block.checks.find((check) => check.id === 'required_props')?.status).toBe('pass');
  });
  test('scores a JSON null literal as a failed block without throwing', () => {
    const html = `<html><script type="application/ld+json">null</script></html>`;
    const analysis = analyzeSchema(parseSchema(html));

    expect(analysis.blocks[0]?.score).toBe(0);
    expect(analysis.blocks[0]?.status).toBe('fail');
    expect(analysis.blocks[0]?.parseError).toBe('JSON-LD node is not an object');
    expect(analysis.blocks[0]?.checks[0]?.id).toBe('valid_json');
    expect(analysis.blocks[0]?.checks[0]?.status).toBe('fail');
  });
  test('scores invalid JSON as a failed block with score 0', () => {
    const html = `<html><script type="application/ld+json">{invalid}</script></html>`;
    const analysis = analyzeSchema(parseSchema(html));

    expect(analysis.blocks[0]?.score).toBe(0);
    expect(analysis.blocks[0]?.status).toBe('fail');
    expect(analysis.blocks[0]?.checks[0]?.id).toBe('valid_json');
    expect(analysis.blocks[0]?.checks[0]?.status).toBe('fail');
  });
  test('fails required props for an Article missing author and date', () => {
    const html = `<html><script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Article","headline":"My Article"
    }</script></html>`;

    const analysis = analyzeSchema(parseSchema(html));

    expect(analysis.blocks[0]?.checks.find((check) => check.id === 'required_props')?.status).toBe(
      'fail',
    );
  });
  test('fails required props when author is an empty string', () => {
    const html = `<html><script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Article","headline":"My Article","author":""
    }</script></html>`;
    const analysis = analyzeSchema(parseSchema(html));

    expect(analysis.blocks[0]?.checks.find((check) => check.id === 'required_props')?.status).toBe(
      'fail',
    );
  });
  test('accepts array and object @context with schema.org', () => {
    const html = `<html><script type="application/ld+json">{
      "@context": ["https://schema.org", {"@language":"en"}],
      "@type":"Organization","name":"Example Org","url":"https://example.com"
    }</script></html>`;
    const analysis = analyzeSchema(parseSchema(html));

    expect(analysis.blocks[0]?.checks.find((check) => check.id === 'context')?.status).toBe('pass');
  });
  test('returns fail when no blocks are found', () => {
    const analysis = analyzeSchema([]);

    expect(analysis).toEqual({ score: 0, overallStatus: 'fail', blocks: [] });
  });
  test('treats schema.org IRI @type as a known type', () => {
    expect(isKnownType('https://schema.org/Article')).toBe(true);
    expect(getRulesForType('https://schema.org/Article')?.required).toContain('headline');

    const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"https://schema.org/Article","headline":"T","datePublished":"2026-01-01","author":"Ada"}</script></html>`;
    const blocks = parseSchema(html);

    expect(blocks[0]?.types).toContain('Article');
    expect(analyzeSchema(blocks).blocks[0]?.checks.find((c) => c.id === 'type')?.status).toBe(
      'pass',
    );
  });
});
