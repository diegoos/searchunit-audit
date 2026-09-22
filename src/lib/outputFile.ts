import { chmodSync, closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileOutputFormat, type CliFlags } from './args.ts';

/** Writes `body` to `path` (mode 0600). Does not follow a symlink at the final path. */
export function writeOutputFile(opts: { path: string; body: string }): string {
  const path = resolve(opts.path);

  mkdirSync(dirname(path), { recursive: true });
  const body = opts.body.endsWith('\n') ? opts.body : `${opts.body}\n`;
  // fs open flags are a bitmask.
  // eslint-disable-next-line no-bitwise -- Node fs.OpenMode
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);

  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }

  chmodSync(path, 0o600);

  return path;
}

/**
 * Writes `-o` / `--output` when set. `.json` is pretty-printed; `.md` is the
 * caller-supplied body. Announces the path on stderr unless `--silent`.
 */
export function persistFileOutput(opts: {
  flags: Pick<CliFlags, 'outputPath' | 'silent'>;
  json: unknown;
  markdown: string;
}): void {
  if (!opts.flags.outputPath) {
    return;
  }

  const format = fileOutputFormat(opts.flags.outputPath);
  const body = format === 'json' ? `${JSON.stringify(opts.json, null, 2)}\n` : opts.markdown;
  const path = writeOutputFile({ path: opts.flags.outputPath, body });

  if (!opts.flags.silent) {
    console.error(`Wrote ${path}`);
  }
}
