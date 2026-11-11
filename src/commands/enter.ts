import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { directoryArgs } from '../directory-args.ts';
import { currentBranch, requireCheckoutAt } from '../git.ts';
import { findOmp } from '../omp.ts';
import { envVar } from '../paths.ts';
import { CliError } from '../proc.ts';
import { focus, openWorktreeTab, split } from '../tern.ts';
import type { WorktreeTab } from '../tern.ts';

/** The env vars that select the omp profile and config directories. The forked session gets the values of the caller, as a `/fork` placement does. */
const OMP_ENV = ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR'] as const;

/** The output of `enter`: the worktree, its main checkout, the tab that shows it, and `agent`, the block of the forked omp session. */
export interface EnterResult {
  agent: number;
  path: string;
  repo: string;
  tab: WorktreeTab;
}

/**
 * `enter <worktree> --fork <session file>`: forks the omp session in `<session file>` into a block adjacent to the tab of the linked worktree,
 * which runs in the worktree and continues the task. It opens the tab of the worktree when no block shows it.
 */
export const run = async (args: string[]): Promise<EnterResult> => {
  const { positionals, values } = directoryArgs({ allowPositionals: true, args, options: { fork: { type: 'string' } } });
  if (positionals.length !== 1 || values.fork === undefined) {
    throw new CliError('bad_args', 'enter requires one worktree path and --fork <session file>');
  }
  const checkout = await requireCheckoutAt(positionals[0]);
  if (checkout.role !== 'linked') {
    throw new CliError('bad_args', `${positionals[0]} is not the top folder of a linked worktree`);
  }
  const dir = realpathSync(positionals[0]);
  const session = path.resolve(values.fork);
  if (statSync(session, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new CliError('bad_args', `${session} is not a session file`);
  }
  const omp = findOmp();
  if (omp === null) {
    throw new CliError('omp_failed', 'omp is not on PATH');
  }
  const tab = await openWorktreeTab(checkout.main, dir, (await currentBranch(dir)) ?? path.basename(dir));
  const env = OMP_ENV.flatMap(name => {
    const value = envVar(name);
    return value === undefined ? [] : [`${name}=${value}`];
  });
  const prompt = `This session is a fork of the session that ran in ${checkout.main}. That session moved the work into the worktree ${dir} and ended. Continue the task here: run commands and edit files in this worktree, not in the main checkout.`;
  const agent = await split(tab.block, dir, ['env', ...env, omp, '--fork', session, '--', prompt]);
  await focus(agent);
  return { agent, path: dir, repo: checkout.main, tab };
};
