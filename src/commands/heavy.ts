import { parseArgs } from 'node:util';
import { CliOutput } from '../cli-output.ts';
import { worktreeRoot } from '../environment.ts';
import { acquireHeavySlot, heavyStatus } from '../heavy.ts';
import type { HeavyStatus } from '../heavy.ts';
import { CliError, runInherited } from '../proc.ts';
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
  let cancellationCode = 130;
  let release: (() => void) | undefined;
  const cancel = (signal: 'SIGINT' | 'SIGTERM'): void => {
    cancellation.abort(signal);
  };
  const onInterrupt = (): void => {
    cancel('SIGINT');
  };
  const onTerminate = (): void => {
    cancellationCode = 143;
    cancel('SIGTERM');
  };
  const cleanup = (): void => {
    release?.();
  };
  process.once('exit', cleanup);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    await ensureServices(root, config);
    release = await acquireHeavySlot(command, { ...config.heavy, signal: cancellation.signal });
    const exitCode = await runInherited(command, { cwd: process.cwd(), env: config.env, signal: cancellation.signal });
    return new CliOutput(exitCode);
  } catch (error) {
    if (cancellation.signal.aborted) {
      return new CliOutput(cancellationCode);
    }
    throw error;
  } finally {
    release?.();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('exit', cleanup);
  }
};
