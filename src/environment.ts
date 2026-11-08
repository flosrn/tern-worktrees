import { currentBranch, gitRun, requireCheckoutAt, worktreePort } from './git.ts';
import { loadWorktreeConfig } from './worktree-config.ts';
import type { WorktreeConfig } from './worktree-config.ts';
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

/** Loads repository preparation settings with the base port of a linked branch worktree. */
export const worktreeEnvironment = async (root: string): Promise<WorktreeConfig> => {
  const config = loadWorktreeConfig(root);
  const checkout = await requireCheckoutAt(root);
  const branch = await currentBranch(root);
  if (checkout.role === 'linked' && branch !== null) {
    config.env.TERN_WT_PORT = String(await worktreePort(checkout.main, branch));
  }
  return config;
};
