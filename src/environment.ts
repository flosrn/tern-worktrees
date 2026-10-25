import { gitRun } from './git.ts';
import { CliError } from './proc.ts';

/** The root of the worktree that contains `dir`, rather than its main checkout. */
export const worktreeRoot = async (dir: string): Promise<string> => {
  const result = await gitRun(dir, 'rev-parse', '--show-toplevel');
  if (result.status !== 0) {
    throw new CliError('not_a_repo', `${dir} is not in a git repository`);
  }
  return result.stdout.trim();
};

/** Quotes a literal value for a POSIX shell. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
