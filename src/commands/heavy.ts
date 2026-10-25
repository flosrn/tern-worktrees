import { parseArgs } from 'node:util';
import { CliOutput } from '../cli-output.ts';
import { worktreeRoot } from '../environment.ts';
import { acquireHeavySlot, heavyStatus } from '../heavy.ts';
import type { HeavyStatus } from '../heavy.ts';
import { CANCEL_EXIT_CODES, CANCEL_SIGNALS, CliError, runInherited } from '../proc.ts';
import { ensureServices } from '../services.ts';
import { loadWorktreeConfig } from '../worktree-config.ts';

/** Reports host slots, or runs a command in a host-wide heavy slot with the worktree environment. */
export const run = async (args: string[]): Promise<HeavyStatus | CliOutput> => {
  const separator = args.indexOf('--');
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: separator === -1 ? args : args.slice(0, separator),
    options: { repo: { type: 'string' }, status: { default: false, type: 'boolean' } },
  });
  const { status } = values;
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const invalidCommand = command.length === 0;
  if (positionals.length !== 0 || status !== invalidCommand) {
    throw new CliError('bad_args', 'heavy needs --status or [--repo <dir>] -- <command> [args...]');
  }
  const root = await worktreeRoot(values.repo ?? process.cwd());
  const config = loadWorktreeConfig(root);
  if (status) {
    return heavyStatus(config.heavy);
  }
  const cancellation = new AbortController();
  let cancellationCode = CANCEL_EXIT_CODES.SIGINT;
  let forward: ((signal: NodeJS.Signals) => void) | undefined;
  let release: (() => void) | undefined;
  const listeners = CANCEL_SIGNALS.map(signal => {
    const listener = (): void => {
      cancellationCode = CANCEL_EXIT_CODES[signal];
      cancellation.abort(signal);
      forward?.(signal);
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  const cleanup = (): void => {
    release?.();
  };
  process.once('exit', cleanup);
  try {
    await ensureServices(root, config, cancellation.signal);
    release = await acquireHeavySlot(command, { ...config.heavy, signal: cancellation.signal });
    const exitCode = await runInherited(command, {
      cwd: process.cwd(),
      env: config.env,
      onSignal: forwardToChild => {
        forward = forwardToChild;
      },
      signal: cancellation.signal,
    });
    return new CliOutput(cancellation.signal.reason === 'SIGHUP' ? CANCEL_EXIT_CODES.SIGHUP : exitCode);
  } catch (error) {
    if (cancellation.signal.aborted) {
      return new CliOutput(cancellationCode);
    }
    throw error;
  } finally {
    release?.();
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
    process.removeListener('exit', cleanup);
  }
};
