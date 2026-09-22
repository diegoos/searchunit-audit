import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { VERSION } from '../src/lib/help.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

describe('npm package contract', () => {
  test('bin points at the Node bundle', () => {
    expect(pkg.bin).toEqual({ searchunit: 'dist/cli.js' });
  });
  test('files ships dist only', () => {
    expect(pkg.files).toEqual(['dist']);
  });
  test('scoped package publishes public for Node 20+', () => {
    expect('private' in pkg).toBe(false);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.engines).toEqual({ node: '>=20' });
  });
  test('--version matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
  test('node dist/cli.js --version prints the package version', () => {
    if (!existsSync(cli)) {
      const build = spawnSync('bun', ['run', 'build'], { encoding: 'utf8', cwd: root });

      expect(build.status).toBe(0);
    }

    const result = spawnSync('node', [cli, '--version'], { encoding: 'utf8', cwd: root });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
