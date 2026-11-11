import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { directoryArgs } from '../directory-args.ts';
import { callerSession, requestEnter, takeEnterRequest } from '../enter.ts';
import { currentBranch, requireCheckoutAt } from '../git.ts';
import type { Checkout } from '../git.ts';
import { findOmp } from '../omp.ts';
import { envVar } from '../paths.ts';
import { CliError } from '../proc.ts';
import { focus, openWorktreeTab, split } from '../tern.ts';
import type { WorktreeTab } from '../tern.ts';

/** The env vars that select the omp profile and config directories. The forked session gets the values of the caller, as a `/fork` placement does. */
const OMP_ENV = ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR'] as const;

/** The output of `enter <worktree>`: the worktree, its main checkout, and the omp session that moves into it at the end of its turn. */
export interface EnterRequestResult {
  path: string;
  repo: string;
  session: string;
}

/** The output of `enter --session <id> --fork <session file>`: the worktree, its main checkout, the tab that shows it, and `agent`, the block of the forked omp session. */
export interface EnterForkResult {
  agent: number;
  path: string;
  repo: string;
  tab: WorktreeTab;
}

/** The checkout at `dir` and its real path. Throws `bad_args` when `dir` is not the top folder of a linked worktree. */
const linkedWorktree = async (dir: string): Promise<Checkout & { dir: string }> => {
  const checkout = await requireCheckoutAt(dir);
  if (checkout.role !== 'linked') {
    throw new CliError('bad_args', `${dir} is not the top folder of a linked worktree`);
  }
  return { ...checkout, dir: realpathSync(dir) };
};

/** Forks the session file `file` into a block adjacent to the tab of the worktree that the omp session `session` requested. */
const fork = async (session: string, file: string | undefined): Promise<EnterForkResult> => {
  const requested = takeEnterRequest(session);
  if (requested === null) {
    throw new CliError('bad_args', `omp session ${session} has no worktree to enter`);
  }
  const { dir, main } = await linkedWorktree(requested);
  const sessionFile = path.resolve(file ?? '');
  if (file === undefined || file === '' || statSync(sessionFile, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new CliError('bad_args', `${file ?? ''} is not a session file`);
  }
  const omp = findOmp();
  if (omp === null) {
    throw new CliError('omp_failed', 'omp is not on PATH');
  }
  const tab = await openWorktreeTab(main, dir, (await currentBranch(dir)) ?? path.basename(dir));
  const env = OMP_ENV.flatMap(name => {
    const value = envVar(name);
    return value === undefined ? [] : [`${name}=${value}`];
  });
  const prompt = `This session is a fork of the session that ran in ${main}. That session moved the work into the worktree ${dir} and ended. Continue the task here: run commands and edit files in this worktree, not in the main checkout.`;
  const agent = await split(tab.block, dir, ['env', ...env, omp, '--fork', sessionFile, '--', prompt]);
  await focus(agent);
  return { agent, path: dir, repo: main, tab };
};

/**
 * `enter <worktree>`: records the linked worktree that the calling omp session moves into at the end of its turn. The bundled omp extension then runs
 * `enter --session <id> --fork <session file>`, which forks the session into a block adjacent to the tab of the worktree. It opens that tab when no block shows the worktree.
 */
export const run = async (args: string[]): Promise<EnterRequestResult | EnterForkResult> => {
  const { positionals, values } = directoryArgs({ allowPositionals: true, args, options: { fork: { type: 'string' }, session: { type: 'string' } } });
  if (values.session !== undefined && positionals.length === 0) {
    return await fork(values.session, values.fork);
  }
  if (positionals.length !== 1 || values.session !== undefined || values.fork !== undefined) {
    throw new CliError('bad_args', 'enter requires one worktree path');
  }
  const session = callerSession();
  const { dir, main } = await linkedWorktree(positionals[0]);
  requestEnter(session, dir);
  return { path: dir, repo: main, session };
};
