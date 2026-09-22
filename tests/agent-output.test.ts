import { describe, expect, test } from 'bun:test';
import { parseCli } from '../src/lib/args.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import { emitCheckOutput, renderAgentMarkdown } from '../src/lib/output.ts';
import { isMachineOutput } from '../src/lib/progress.ts';

function flags(over: Partial<CliFlags> = {}): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    silent: true,
    global: false,
    unset: false,
    agent: true,
    outFormat: 'table',
    outputPath: undefined,
    failOn: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    rest: [],
    ...over,
  };
}

describe('renderAgentMarkdown', () => {
  test('keeps nested fields, nulls, and the full detail', () => {
    const detail = `${'a'.repeat(200)}\nsecond line`;
    const text = renderAgentMarkdown({
      command: 'schema-check',
      url: 'https://example.com/',
      score: 80,
      missing: null,
      tags: ['Article'],
      blocks: [],
      checks: [{ id: 'title', status: 'fail', detail }],
    });
    expect(text.startsWith('# schema-check\n')).toBe(true);
    expect(text).toContain('url: https://example.com/');
    expect(text).toContain('score: 80');
    expect(text).toContain('missing: null');
    expect(text).toContain('## tags');
    expect(text).toContain('- Article');
    expect(text).toContain('## blocks');
    expect(text).toContain('(empty)');
    expect(text).toContain('detail: |');
    expect(text).toContain(detail.split('\n')[0]);
    expect(text).toContain('  second line');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('--agent', () => {
  test('parseCli sets the flag on every command token', () => {
    const parsed = parseCli(['config', '--agent']);

    expect(parsed.flags.agent).toBe(true);
    expect(parsed.flags.outFormat).toBe('table');
    expect(parseCli(['audit', 'https://example.com']).flags.agent).toBe(false);
  });
  test('stdout is the payload markdown and skips the table', () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));

      return true;
    }) as typeof process.stdout.write;

    const previous = process.env.CRUX_API_KEY;

    delete process.env.CRUX_API_KEY;

    try {
      emitCheckOutput(flags(), {
        command: 'meta-check',
        url: 'https://example.com/',
        json: { ok: true, command: 'meta-check', url: 'https://example.com/', score: 10 },
        report: { title: 'Meta Tags Test', url: 'https://example.com/', score: 10 },
      });
    } finally {
      process.stdout.write = original;

      if (previous === undefined) {
        delete process.env.CRUX_API_KEY;
      } else {
        process.env.CRUX_API_KEY = previous;
      }
    }

    const text = chunks.join('');

    expect(text.startsWith('# meta-check\n')).toBe(true);
    expect(text).toContain('cruxApiKeyAvailable: false');
    expect(text).not.toContain('Meta Tags Test');
  });
  test('counts as machine output so the spinner stays off', () => {
    expect(isMachineOutput({ outFormat: 'table', agent: true })).toBe(true);
    expect(isMachineOutput({ outFormat: 'table' })).toBe(false);
  });
});
