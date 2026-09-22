import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistFileOutput, writeOutputFile } from '../src/lib/outputFile.ts';

describe('writeOutputFile', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('writes the body and creates the parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'searchunit-out-'));

    dirs.push(dir);
    const path = writeOutputFile({
      path: join(dir, 'reports', 'schema.json'),
      body: '{"ok":true}',
    });
    expect(path).toBe(join(dir, 'reports', 'schema.json'));
    expect(readFileSync(path, 'utf8')).toBe('{"ok":true}\n');
    expect(statSync(path).mode.toString(8).slice(-3)).toBe('600');
  });
  test('does not follow a symlink at the output path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'searchunit-out-'));
    const outside = mkdtempSync(join(tmpdir(), 'searchunit-out-target-'));

    dirs.push(dir, outside);
    const target = join(outside, 'secret.txt');
    const linked = join(dir, 'report.json');

    writeFileSync(target, 'keep\n');
    symlinkSync(target, linked);
    expect(() => writeOutputFile({ path: linked, body: 'overwrite' })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  });
});

describe('persistFileOutput', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('does nothing when -o is omitted', () => {
    persistFileOutput({
      flags: { outputPath: undefined, silent: true },
      json: { ok: true },
      markdown: '# x\n',
    });
  });
  test('writes pretty JSON when the path ends in .json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'searchunit-persist-'));

    dirs.push(dir);
    const path = join(dir, 'latest.json');

    persistFileOutput({
      flags: { outputPath: path, silent: true },
      json: { ok: true },
      markdown: '# unused\n',
    });
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
  });
  test('writes the supplied markdown body when the path ends in .md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'searchunit-persist-md-'));

    dirs.push(dir);
    const path = join(dir, 'report.md');

    persistFileOutput({
      flags: { outputPath: path, silent: true },
      json: { ok: true },
      markdown: '# Report\n',
    });
    expect(readFileSync(path, 'utf8')).toBe('# Report\n');
  });
});
