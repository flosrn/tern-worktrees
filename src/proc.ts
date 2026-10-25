import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { TernProcess } from './tern.ts';

/** The error codes the CLI reports in its error envelope. */
export type ErrorCode =
  | 'bad_args'
  | 'config_invalid'
  | 'worktree_config_invalid'
  | 'service_failed'
  | 'docker_missing'
  | 'setup_failed'
  | 'not_a_repo'
  | 'not_cloned'
  | 'not_managed'
  | 'path_conflict'
  | 'worktree_exists_elsewhere'
  | 'dirty_worktree'
  | 'busy_tabs'
  | 'git_failed'
  | 'gh_failed'
  | 'omp_failed'
  | 'tern_failed';

/** A busy block and its placement, reported by the removal guard. */
export interface BusyBlock {
  block: number;
  tab: number;
  session: number;
  process: TernProcess;
}

/** The added fields of the error envelope, for example the conflicting path or the changed files. */
export type ErrorExtra = Record<string, string | number | string[] | BusyBlock[]>;

/** A failure that the CLI reports with a code, a message and added fields. */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly extra: ErrorExtra;

  constructor(code: ErrorCode, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.extra = extra;
  }
}

/** The exit status and output of a completed process. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Where a process runs and the env vars it gets on top of `process.env`. */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Runs `argv`, waits for it to exit, and returns its output.
 * A command that fails to start gives status 127 with the spawn error in `stderr`. A command that a signal stops gives status 1.
 */
export const run = async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
  const [command, ...args] = argv;
  const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  try {
    await once(child, 'close');
  } catch (error) {
    return { status: 127, stderr: String(error), stdout: '' };
  }
  return { status: child.exitCode ?? 1, stderr: Buffer.concat(stderr).toString(), stdout: Buffer.concat(stdout).toString() };
};

/** Runs `argv` and returns its `stdout`, or throws a `CliError` with `code` when it exits with a status other than 0. */
export const must = async (argv: string[], code: ErrorCode, opts: RunOptions = {}): Promise<string> => {
  const result = await run(argv, opts);
  if (result.status !== 0) {
    throw new CliError(code, result.stderr.trim() || `${argv[0]} exited ${result.status}`);
  }
  return result.stdout;
};

/** The signals that cancel a heavy command, in the order of their exit codes. */
export const CANCEL_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
/** A signal that cancels a heavy command. */
export type CancelSignal = (typeof CANCEL_SIGNALS)[number];
/** The shell exit code of a process that a cancel signal stopped: 128 plus the signal number. */
export const CANCEL_EXIT_CODES: Readonly<Record<CancelSignal, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const isCancelSignal = (signal: NodeJS.Signals | null): signal is CancelSignal => signal === 'SIGHUP' || signal === 'SIGINT' || signal === 'SIGTERM';

/** The signal an aborted run forwards: SIGINT or SIGHUP when the abort names it, else SIGTERM. */
const abortSignalOf = (signal: AbortSignal | undefined): CancelSignal => {
  const reason: unknown = signal?.reason;
  if (reason === 'SIGINT') {
    return 'SIGINT';
  }
  if (reason === 'SIGHUP') {
    return 'SIGHUP';
  }
  return 'SIGTERM';
};

/** Runs a command with the caller's terminal and forwards cancellation to the child. */
export const runInherited = async (
  argv: string[],
  opts: RunOptions & { onSignal?: (forward: (signal: NodeJS.Signals) => void) => void; signal?: AbortSignal } = {},
): Promise<number> => {
  if (opts.signal?.aborted === true) {
    return CANCEL_EXIT_CODES[abortSignalOf(opts.signal)];
  }
  const [command, ...args] = argv;
  const child = spawn(command, args, { cwd: opts.cwd, detached: true, env: { ...process.env, ...opts.env }, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group can finish between cancellation and delivery of the signal.
    }
  };
  const onAbort = (): void => {
    forward(abortSignalOf(opts.signal));
  };
  opts.signal?.addEventListener('abort', onAbort);
  opts.onSignal?.(forward);
  try {
    await once(child, 'close');
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    return 127;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return isCancelSignal(child.signalCode) ? CANCEL_EXIT_CODES[child.signalCode] : 1;
};
