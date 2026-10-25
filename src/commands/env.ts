import { parseArgs } from 'node:util';
import { CliOutput } from '../cli-output.ts';
import { shellQuote, worktreeRoot } from '../environment.ts';
import { CliError } from '../proc.ts';
import { loadWorktreeConfig } from '../worktree-config.ts';

/** Prints a worktree's environment as JSON or POSIX shell exports. */
export const run = async (args: string[]): Promise<object> => {
  const { positionals, values } = parseArgs({ allowPositionals: true, args, options: { shell: { type: 'boolean' } } });
  if (positionals.length !== 1) {
    throw new CliError('bad_args', 'env requires one worktree path');
  }
  const root = await worktreeRoot(positionals[0]);
  const { env } = loadWorktreeConfig(root);
  if (values.shell === true) {
    const output = Object.entries(env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
      .join('');
    return new CliOutput(0, output);
  }
  return { env };
};
