import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { identityOf } from './clean-processes.ts';
import { requireCheckoutAt, requireRepoRoot, worktrees } from './git.ts';
import type { Worktree } from './git.ts';
import { readOrigin } from './github.ts';
import { nameWithOwner } from './repo-ref.ts';
import { worktreeOwner, worktreeRoot } from './paths.ts';
import type { WorktreeRoot } from './paths.ts';
import { CliError } from './proc.ts';
import type { FinishKept, FinishPlan, FinishPullRequest } from './finish-types.ts';
import { guardWorkToLose } from './work-to-lose.ts';
import { mergedProof } from './finish-proof.ts';
import { finishActivity, sampleActivity } from './finish-processes.ts';
import type { FinishActivity, FinishSample } from './finish-processes.ts';
import { writeFinish } from './finish-store.ts';
import type { StoredFinish } from './finish-store.ts';
import { postMergeReady } from './finish-workflows.ts';
import { inspectItems } from './inspection-pool.ts';

interface PlanOptions {
  repo: string;
  current?: string;
  owned: string[];
  excluded?: string[];
  pid?: number;
  block?: number;
  session?: string;
}

const activityCause = (target: string, activity: FinishActivity): FinishKept | null => {
  if (activity.code === null) {
    return null;
  }
  const cause: FinishKept = { code: activity.code, path: target };
  if (activity.code === 'inspection_failed') {
    cause.detail = activity.reason;
  }
  return cause;
};

const inspectionFailure = (target: string, error: Error | string): FinishKept => ({
  code: error instanceof CliError ? error.code : 'inspection_failed',
  detail: error instanceof Error ? error.message : error,
  path: target,
});

/** A merged worktree without work to lose. Only its activity check stays before it becomes a candidate. */
interface MergedWorktree {
  branch: string;
  head: string;
  path: string;
  pr: FinishPullRequest;
  stat: { dev: number; ino: number };
}

const mergedWorktree = async (state: StoredFinish, entry: Worktree, root: WorktreeRoot, github: string | null): Promise<MergedWorktree | null> => {
  try {
    if (entry.main || entry.locked !== null || entry.prunable || entry.branch === null) {
      state.keep.push({ code: 'not_managed', path: entry.path });
      return null;
    }
    if (worktreeOwner(root, state.repo, entry.path) !== 'tern') {
      state.keep.push({ code: 'not_managed', path: entry.path });
      return null;
    }
    if (state.excluded.includes(entry.path)) {
      state.keep.push({ code: 'retained', path: entry.path });
      return null;
    }
    const stat = lstatSync(entry.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(entry.path) !== entry.path) {
      state.keep.push({ code: 'path_identity_changed', path: entry.path });
      return null;
    }
    const proof = github === null ? null : await mergedProof(github, entry.branch, entry.head);
    if (proof === null) {
      state.keep.push({ code: 'not_merged', path: entry.path });
      return null;
    }
    await guardWorkToLose(entry.path, { removing: state.repo }, state.repo);
    return { branch: entry.branch, head: entry.head, path: entry.path, pr: proof, stat: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    state.keep.push(inspectionFailure(entry.path, error instanceof Error ? error : String(error)));
    return null;
  }
};

const planCandidate = async (state: StoredFinish, merged: MergedWorktree, sample: FinishSample): Promise<void> => {
  try {
    const cause = activityCause(merged.path, await finishActivity(state, merged.path, true, sample));
    if (cause !== null) {
      state.keep.push(cause);
      return;
    }
    state.candidates.push({ branch: merged.branch, head: merged.head, path: merged.path, pr: merged.pr });
    state.identities[merged.path] = merged.stat;
  } catch (error) {
    // SAFETY: `finishActivity` throws only a CliError or an Error of a failed process call.
    state.keep.push(inspectionFailure(merged.path, error as Error));
  }
};

/**
 * Checks the activity of each merged worktree. One Tern listing and one process snapshot serve them all. The plan reads them after its
 * git and GitHub calls stop, so its own short-lived children cannot make a process inspection fail.
 */
const planCandidates = async (state: StoredFinish, merged: MergedWorktree[]): Promise<void> => {
  if (merged.length === 0) {
    return;
  }
  let sample: FinishSample;
  try {
    sample = await sampleActivity(
      state,
      merged.map(entry => entry.path),
    );
  } catch (error) {
    // SAFETY: `sampleActivity` throws only a CliError or an Error of a failed process call.
    state.keep.push(...merged.map(entry => inspectionFailure(entry.path, error as Error)));
    return;
  }
  await inspectItems(merged, async entry => {
    await planCandidate(state, entry, sample);
  });
};

const finishReadiness = async (state: StoredFinish, github: string | null): Promise<void> => {
  const own = state.candidates.filter(candidate => candidate.path === state.current || state.owned.includes(candidate.path));
  if (own.length === 0 || github === null) {
    return;
  }
  const workflows = await Promise.all(own.map(async candidate => await postMergeReady(github, candidate.pr)));
  state.ready = workflows.every(Boolean);
  if (!state.ready) {
    state.warnings.push('Post-merge workflows are pending, failed, or their success cannot be proven.');
  }
};

const currentCheckout = async (repo: string, requested?: string): Promise<string | null> => {
  if (requested === undefined) {
    return null;
  }
  const current = realpathSync(requested);
  const checkout = await requireCheckoutAt(current);
  if (checkout.main !== repo || checkout.role === 'inside') {
    throw new CliError('bad_args', 'finish current must be a checkout of the selected repository');
  }
  return current === repo ? null : current;
};

/** Creates a read-only plan for the current repository. */
export const planFinish = async (options: PlanOptions): Promise<FinishPlan> => {
  const repo = realpathSync(await requireRepoRoot(options.repo));
  const root = await worktreeRoot();
  const entries = await worktrees(repo);
  const current = await currentCheckout(repo, options.current);
  const owned = [...new Set(options.owned.map(target => realpathSync(target)))];
  const excluded = [...new Set((options.excluded ?? []).map(target => realpathSync(target)))];
  const identity = options.pid === undefined ? null : await identityOf(options.pid);
  const mainStat = lstatSync(repo);
  const state: StoredFinish = {
    caller: { block: options.block ?? null, identity, pid: options.pid ?? null, session: options.session ?? null },
    candidates: [],
    current,
    errors: [],
    excluded,
    id: randomBytes(24).toString('hex'),
    identities: { [repo]: { dev: mainStat.dev, ino: mainStat.ino } },
    inFlight: null,
    keep: [],
    notified: false,
    owned,
    ready: false,
    removed: [],
    repo,
    selected: [],
    status: 'planned',
    version: 2,
    warnings: [],
  };
  for (const target of owned) {
    if (!entries.some(entry => !entry.main && entry.path === target && worktreeOwner(root, repo, target) === 'tern')) {
      state.keep.push({ code: 'not_managed', path: target });
    }
  }
  const origin = await readOrigin(repo);
  const github = origin.github === null ? null : nameWithOwner(origin.github);
  const merged = await inspectItems(entries, async entry => await mergedWorktree(state, entry, root, github));
  await planCandidates(
    state,
    merged.filter(entry => entry !== null),
  );
  await finishReadiness(state, github);
  writeFinish(state);
  const { id, ready, candidates, keep, warnings } = state;
  return { candidates, current, id, keep, ready, repo, warnings };
};
