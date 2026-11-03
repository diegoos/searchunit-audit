import { spawn, type ChildProcess } from 'node:child_process';

export interface ProcessOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  timedOut?: boolean;
  overflow?: boolean;
}

export interface ProcessHandle {
  done: Promise<ProcessOutcome>;
  kill: () => void;
}

export type ProcessSpawn = (command: string, args: readonly string[]) => ProcessHandle;

export interface ProcessLimits {
  timeoutMs: number;
  /** Characters kept per stream. Past this the child is killed and `overflow` is set. */
  outputCap: number;
}

export function appendCapped(
  current: string,
  chunk: string,
  cap: number,
): { text: string; overflow: boolean } {
  if (current.length >= cap) {
    return { text: current, overflow: true };
  }

  const next = current + chunk;

  if (next.length <= cap) {
    return { text: next, overflow: false };
  }

  return { text: next.slice(0, cap), overflow: true };
}

/** Pid to signal. Negative on POSIX so the Chrome child dies with its parent. */
function killPid(childPid: number): number {
  return process.platform === 'win32' ? childPid : -childPid;
}

function safeKill(child: ChildProcess): void {
  const pid = child.pid;

  if (pid === undefined) {
    return;
  }

  try {
    process.kill(killPid(pid), 'SIGKILL');
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
  }
}

function collectChild(
  child: ChildProcess,
  limits: ProcessLimits,
  resolve: (outcome: ProcessOutcome) => void,
): void {
  let stdout = '';
  let stderr = '';
  let errorCode: string | undefined;
  let settled = false;

  const finish = (outcome: ProcessOutcome): void => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);
    resolve(outcome);
  };
  const take = (current: string, chunk: string): string => {
    const next = appendCapped(current, chunk, limits.outputCap);

    if (next.overflow) {
      safeKill(child);
      finish({
        stdout,
        stderr,
        code: null,
        signal: 'SIGKILL',
        errorCode,
        timedOut: false,
        overflow: true,
      });
    }

    return next.text;
  };
  const timer = setTimeout(() => {
    safeKill(child);
    finish({
      stdout,
      stderr,
      code: null,
      signal: 'SIGKILL',
      errorCode,
      timedOut: true,
    });
  }, limits.timeoutMs);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout = take(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr = take(stderr, chunk);
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    errorCode = err.code;

    if (err.code === 'ENOENT') {
      finish({ stdout, stderr, code: null, signal: null, errorCode, timedOut: false });
    }
  });
  child.on('close', (code, signal) => {
    finish({ stdout, stderr, code, signal, errorCode, timedOut: false });
  });
}

/** Runs a child in its own process group, with a timeout and a per-stream output cap. */
export function spawnCapped(
  command: string,
  args: readonly string[],
  limits: ProcessLimits,
): ProcessHandle {
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  return {
    done: new Promise((resolve) => {
      collectChild(child, limits, resolve);
    }),
    kill() {
      safeKill(child);
    },
  };
}
