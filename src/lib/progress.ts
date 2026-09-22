import ora from 'ora';
import type { CliFlags } from './args.ts';

/** True when stdout is a machine format (no spinner, no TTY table). */
export function isMachineOutput(flags: Pick<CliFlags, 'outFormat'> & { agent?: boolean }): boolean {
  return flags.agent === true || flags.outFormat !== 'table';
}

export interface Progress {
  start: (text: string) => void;
  setText: (text: string) => void;
  stop: () => void;
}

/**
 * Ora spinner on stderr. Silent when `--silent` or machine output so pipes stay clean.
 */
export function createProgress(opts: { silent: boolean; machine: boolean }): Progress {
  const spinner = ora({
    isSilent: opts.silent || opts.machine,
    spinner: 'dots',
    stream: process.stderr,
  });

  return {
    start(text) {
      spinner.start(text);
    },
    setText(text) {
      spinner.text = text;
    },
    stop() {
      if (spinner.isSpinning) {
        spinner.stop();
      }
    },
  };
}

/**
 * Runs async work with a stderr spinner, then always clears it (errors stay on printError).
 */
export async function withProgress<T>(
  flags: CliFlags,
  text: string,
  work: (setText: (message: string) => void) => Promise<T>,
): Promise<T> {
  const progress = createProgress({ silent: flags.silent, machine: isMachineOutput(flags) });

  progress.start(text);

  try {
    return await work((message) => progress.setText(message));
  } finally {
    progress.stop();
  }
}
