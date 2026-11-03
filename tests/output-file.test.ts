import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payloadJson } from '../src/lib/invisibleText.ts';
import { persistFileOutput, writeOutputFile } from '../src/lib/outputFile.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'searchunit-out-'));

  dirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeOutputFile', () => {
  test('creates the parent directory and writes the body, mode 600', () => {
    const target = join(tempDir(), 'reports', 'schema.json');
    const path = writeOutputFile({ path: target, body: '{"ok":true}' });

    expect(path).toBe(target);
    expect(readFileSync(path, 'utf8')).toBe('{"ok":true}\n');
    expect(statSync(path).mode.toString(8).slice(-3)).toBe('600');
  });
  test('does not follow a symlink at the output path', () => {
    const dir = tempDir();
    const target = join(tempDir(), 'secret.txt');
    const linked = join(dir, 'report.json');

    writeFileSync(target, 'keep\n');
    symlinkSync(target, linked);
    expect(() => writeOutputFile({ path: linked, body: 'overwrite' })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  });
});

describe('persistFileOutput', () => {
  test.each([
    ['latest.json', `${JSON.stringify({ ok: true }, null, 2)}\n`],
    ['report.md', '# Report\n'],
  ])('writes %s by its extension', (name, expected) => {
    const path = join(tempDir(), name);

    persistFileOutput({
      flags: { outputPath: path, silent: true },
      json: { ok: true },
      markdown: '# Report\n',
    });
    expect(readFileSync(path, 'utf8')).toBe(expected);
  });
  test('a .json file drops invisible format characters and C1 controls from keys and values', () => {
    const path = join(tempDir(), 'latest.json');
    const tag = String.fromCodePoint(0xe0041);

    persistFileOutput({
      flags: { outputPath: path, silent: true },
      json: {
        ['bot\u200b']: `Ca\u200bfé ${tag}x\u202e\uFE0F\u{E0100}\u00AD\u009B`,
        line: 'a\nb',
      },
      markdown: '',
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ bot: 'Café x', line: 'a\nb' });
  });
});

describe('payloadJson', () => {
  test('drops line and paragraph separators, which some readers show as a new line', () => {
    const separators = String.fromCodePoint(0x2028, 0x2029);

    expect(JSON.parse(payloadJson({ alt: `a${separators}## forged` }))).toEqual({
      alt: 'a## forged',
    });
  });
});
