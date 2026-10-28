import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyResources, planResources } from '../clean-resources.ts';
import type { CleanProcess, ResourcePlan } from '../clean-resources.ts';
import { fetchOrigin, gitMust, gitRun, isAncestor, requireRepoRoot, worktrees } from '../git.ts';
import type { Worktree } from '../git.ts';
import { defaultBranch, listPullRequests, readOrigin } from '../github.ts';
import { isUnder } from '../paths.ts';
import { CliError } from '../proc.ts';
import { guardBusyTabs, isCleanMerged } from '../teardown.ts';
import { blocksUnder, close, ls } from '../tern.ts';
import type { PlacedBlock, TernListing } from '../tern.ts';
import { guardWorkToLose } from '../work-to-lose.ts';

interface Kept {
  kind: string;
  id: string;
  reason: string;
}

interface CleanPlan {
  repo: string;
  default: string;
  remove: { worktrees: string[]; branches: string[]; processes: CleanProcess[]; containers: string[]; paths: string[] };
  keep: Kept[];
  warnings: string[];
  applied?: true;
}

interface PlannedHeads {
  branches: Map<string, string>;
  worktrees: Map<string, string>;
}

interface PlanContext {
  result: CleanPlan;
  heads: PlannedHeads;
  listing: TernListing | null;
  entries: Worktree[];
  paths: string[];
  prunableWorktrees: string[];
  resources: ResourcePlan;
  cwd: string;
  safeBranches: Set<string>;
  branchReasons: Map<string, string>;
  mergedBranches: Set<string>;
  mergedHeads: string[];
  defaultTree: string | null;
}

const busyBlocks = async (blocks: PlacedBlock[]): Promise<boolean> => {
  try {
    await guardBusyTabs(blocks);
    return false;
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'busy_tabs') {
      throw error;
    }
    return true;
  }
};

const branchReason = async (ctx: PlanContext, branch: string): Promise<string | null> => {
  const { result } = ctx;
  if (branch === result.default) {
    return 'default branch';
  }
  if (await isCleanMerged(result.repo, branch, result.default, ctx.mergedHeads, ctx.defaultTree)) {
    ctx.mergedBranches.add(branch);
    return null;
  }
  return 'not merged';
};

const inspectBranch = async (ctx: PlanContext, branch: string): Promise<void> => {
  let reason: string | null;
  try {
    const head = await gitMust(ctx.result.repo, 'rev-parse', `refs/heads/${branch}`);
    ctx.heads.branches.set(branch, head.trim());
    reason = await branchReason(ctx, branch);
  } catch (error) {
    reason = `branch inspection failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (reason === null) {
    ctx.safeBranches.add(branch);
  } else {
    ctx.result.keep.push({ id: branch, kind: 'branch', reason });
    ctx.branchReasons.set(branch, reason);
  }
};

const retainedWorktreeReason = async (ctx: PlanContext, entry: Worktree): Promise<string | null> => {
  if (entry.main) {
    return 'main checkout';
  }
  if (isUnder(ctx.cwd, entry.path)) {
    return 'caller active worktree';
  }
  if (entry.locked !== null) {
    return 'locked worktree';
  }
  if (ctx.listing === null) {
    return 'Tern inspection unavailable';
  }
  const busy = await busyBlocks(blocksUnder(ctx.listing, entry.path));
  if (busy) {
    return 'busy or protected process';
  }
  if (ctx.resources.protectedWorktrees.includes(entry.path)) {
    return ctx.resources.keep.find(item => item.kind === 'worktree' && item.id === entry.path)?.reason ?? 'active or protected process';
  }
  if (entry.branch === null) {
    return null;
  }
  const reason = ctx.branchReasons.get(entry.branch);
  if (reason !== undefined) {
    return reason;
  }
  return ctx.mergedBranches.has(entry.branch) ? null : 'not merged';
};

const worktreeReason = async (ctx: PlanContext, entry: Worktree): Promise<string | null> => {
  const retained = await retainedWorktreeReason(ctx, entry);
  if (retained !== null) {
    return retained;
  }
  const { result } = ctx;
  if (entry.branch === null && !(await isAncestor(result.repo, entry.head, `origin/${result.default}`))) {
    return 'detached HEAD is not reachable from origin/default';
  }
  await guardWorkToLose(entry.path, { removing: result.repo }, result.repo);
  return null;
};

const inspectWorktree = async (ctx: PlanContext, entry: Worktree): Promise<void> => {
  let reason: string | null;
  try {
    reason = await worktreeReason(ctx, entry);
  } catch (error) {
    const files = error instanceof CliError && error.code === 'dirty_worktree' ? error.extra.files : null;
    const names = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
    const details = names.length > 0 ? `: ${names.join(', ')}` : '';
    reason = `worktree inspection failed: ${error instanceof Error ? error.message : String(error)}${details}`;
  }
  if (reason === null) {
    ctx.result.remove.worktrees.push(entry.path);
  } else {
    ctx.result.keep.push({ id: entry.path, kind: 'worktree', reason });
  }
};

// Recompute resources when newly protected worktrees shrink the removal candidates.
const selectResources = async (ctx: PlanContext): Promise<ResourcePlan> => {
  const { result } = ctx;
  const selected = await planResources({ prunableWorktrees: ctx.prunableWorktrees, removeWorktrees: result.remove.worktrees, repo: result.repo, worktrees: ctx.paths });
  const rejected = result.remove.worktrees.filter(dir => selected.protectedWorktrees.includes(dir));
  if (rejected.length === 0) {
    return selected;
  }
  for (const dir of rejected) {
    result.keep.push({ id: dir, kind: 'worktree', reason: selected.keep.find(item => item.kind === 'worktree' && item.id === dir)?.reason ?? 'busy or protected process' });
  }
  result.remove.worktrees = result.remove.worktrees.filter(dir => !rejected.includes(dir));
  return await selectResources(ctx);
};

const selectBranches = (ctx: PlanContext): void => {
  const { result } = ctx;
  for (const branch of ctx.safeBranches) {
    if (ctx.entries.some(entry => entry.branch === branch && !result.remove.worktrees.includes(entry.path))) {
      result.keep.push({ id: branch, kind: 'branch', reason: 'checked out in a retained worktree' });
    } else {
      result.remove.branches.push(branch);
    }
  }
};

const plan = async (repo: string): Promise<{ result: CleanPlan; listing: TernListing | null; heads: PlannedHeads }> => {
  const origin = await readOrigin(repo);
  const base = await defaultBranch(repo, origin.github);
  const entries = await worktrees(repo);
  const paths = entries.map(entry => entry.path);
  const prunableWorktrees = entries.filter(entry => entry.prunable).map(entry => entry.path);
  const resources = await planResources({ prunableWorktrees, removeWorktrees: [], repo, worktrees: paths });
  const result: CleanPlan = {
    default: base,
    keep: [],
    remove: { branches: [], containers: resources.containers, paths: resources.paths, processes: resources.processes, worktrees: [] },
    repo,
    warnings: [],
  };
  const heads: PlannedHeads = { branches: new Map(), worktrees: new Map(entries.map(entry => [entry.path, entry.head])) };
  let mergedHeads: string[] = [];
  if (origin.github !== null) {
    try {
      const { error, prs } = await listPullRequests(origin.github, ['--state', 'merged', '--limit', '10000'], ['headRefName', 'headRefOid', 'number']);
      if (error === null) {
        mergedHeads = [...new Set(prs.map(pr => pr.headRefOid))];
      } else {
        result.warnings.push(`merged PR check failed: ${error}`);
      }
    } catch (error) {
      result.warnings.push(`merged PR check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const defaultTree = await gitRun(repo, 'rev-parse', `origin/${base}^{tree}`);
  let listing: TernListing | null = null;
  try {
    listing = await ls();
  } catch (error) {
    result.warnings.push(`Tern inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ctx: PlanContext = {
    branchReasons: new Map(),
    cwd: realpathSync(process.cwd()),
    entries,
    heads,
    listing,
    mergedBranches: new Set(),
    mergedHeads,
    defaultTree: defaultTree.status === 0 ? defaultTree.stdout.trim() : null,
    paths,
    prunableWorktrees,
    resources,
    result,
    safeBranches: new Set(),
  };
  const branchOutput = await gitMust(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
  const branches = branchOutput.split('\n').filter(Boolean);
  for (const branch of branches) {
    // Branch inspection mutates the shared plan and must stay ordered.
    // eslint-disable-next-line no-await-in-loop
    await inspectBranch(ctx, branch);
  }
  for (const entry of entries) {
    // Worktree inspection depends on earlier branch decisions.
    // eslint-disable-next-line no-await-in-loop
    await inspectWorktree(ctx, entry);
  }
  const selected = await selectResources(ctx);
  selectBranches(ctx);
  result.remove.processes = selected.processes;
  result.remove.containers = selected.containers;
  result.remove.paths = selected.paths;
  result.keep.push(...selected.keep);
  result.warnings.push(...selected.warnings);
  return { heads, listing, result };
};

const planWithoutLocks = async (repo: string): Promise<{ result: CleanPlan; listing: TernListing | null; heads: PlannedHeads }> => {
  const optionalLocks = process.env.GIT_OPTIONAL_LOCKS;
  try {
    process.env.GIT_OPTIONAL_LOCKS = '0';
    return await plan(repo);
  } finally {
    if (optionalLocks === undefined) {
      delete process.env.GIT_OPTIONAL_LOCKS;
    } else {
      process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
    }
  }
};

const closeRemovedBlock = async (entry: PlacedBlock, warnings: string[]): Promise<void> => {
  try {
    await close(entry.block.id);
  } catch (error) {
    warnings.push(`block ${entry.block.id} not closed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const guardPlannedWorktree = async (heads: PlannedHeads, dir: string): Promise<void> => {
  const head = await gitMust(dir, 'rev-parse', 'HEAD');
  if (head.trim() !== heads.worktrees.get(dir)) {
    throw new CliError('git_failed', 'worktree HEAD changed after planning');
  }
};

const removeWorktree = async (result: CleanPlan, heads: PlannedHeads, listing: TernListing, failed: CleanProcess[], dir: string): Promise<boolean> => {
  if (failed.some(candidate => isUnder(candidate.cwd, dir))) {
    result.keep.push({ id: dir, kind: 'worktree', reason: 'process could not be safely stopped' });
    return false;
  }
  try {
    await guardWorkToLose(dir, { removing: result.repo }, result.repo);
    await guardPlannedWorktree(heads, dir);
    const removal = await gitRun(result.repo, '-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', dir);
    if (removal.status !== 0) {
      if (!removal.stderr.includes('working trees containing submodules cannot be moved or removed')) {
        throw new CliError('git_failed', removal.stderr.trim());
      }
      await gitMust(result.repo, 'worktree', 'remove', '--force', dir);
    }
    const blocks = blocksUnder(listing, dir);
    for (const entry of blocks) {
      // Close blocks in order.
      // eslint-disable-next-line no-await-in-loop
      await closeRemovedBlock(entry, result.warnings);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.keep.push({ id: dir, kind: 'worktree', reason: `removal failed: ${message}` });
    result.warnings.push(`worktree ${dir} not removed: ${message}`);
    return false;
  }
};

const deleteBranch = async (result: CleanPlan, heads: PlannedHeads, branch: string): Promise<boolean> => {
  const checkedOut = await worktrees(result.repo);
  if (checkedOut.some(entry => entry.branch === branch)) {
    result.keep.push({ id: branch, kind: 'branch', reason: 'checked out in a retained worktree' });
    return false;
  }
  const head = await gitRun(result.repo, 'rev-parse', `refs/heads/${branch}`);
  if (head.status !== 0 || head.stdout.trim() !== heads.branches.get(branch)) {
    result.keep.push({ id: branch, kind: 'branch', reason: 'branch changed after planning' });
    result.warnings.push(`branch ${branch} not deleted: branch changed after planning`);
    return false;
  }
  const deletion = await gitRun(result.repo, 'branch', '-D', '--', branch);
  if (deletion.status === 0) {
    return true;
  }
  result.warnings.push(`branch ${branch} not deleted: ${deletion.stderr.trim()}`);
  return false;
};

const applyPlan = async (result: CleanPlan, heads: PlannedHeads, listing: TernListing | null): Promise<void> => {
  const { failedProcesses } = await applyResources(result.remove, result.warnings);
  const failed = result.remove.processes.filter(candidate => failedProcesses.includes(candidate.pid));
  result.remove.processes = result.remove.processes.filter(candidate => !failedProcesses.includes(candidate.pid));
  const removed: string[] = [];
  if (listing !== null) {
    for (const dir of result.remove.worktrees) {
      // Worktree removal is destructive and must stay sequential.
      // eslint-disable-next-line no-await-in-loop
      if (await removeWorktree(result, heads, listing, failed, dir)) {
        removed.push(dir);
      }
    }
  }
  result.remove.worktrees = removed;
  const deleted: string[] = [];
  for (const branch of result.remove.branches) {
    // Branch deletion follows worktree removal and must stay sequential.
    // eslint-disable-next-line no-await-in-loop
    if (await deleteBranch(result, heads, branch)) {
      deleted.push(branch);
    }
  }
  result.remove.branches = deleted;
  const prune = await gitRun(result.repo, 'worktree', 'prune');
  if (prune.status !== 0) {
    result.warnings.push(`worktree prune failed: ${prune.stderr.trim()}`);
  }
  result.applied = true;
};

/** Plans repository-wide teardown without writes. Apply fetches and constructs a new plan. */
export const run = async (args: string[]): Promise<CleanPlan> => {
  const parsed = parseArgs({ args, options: { apply: { default: false, type: 'boolean' }, repo: { type: 'string' } } });
  if (parsed.values.repo === undefined) {
    throw new CliError('bad_args', 'clean needs --repo <dir>');
  }
  const target = path.resolve(parsed.values.repo);
  const repo = await requireRepoRoot(existsSync(target) ? realpathSync(target) : target);
  const warning = parsed.values.apply ? await fetchOrigin(repo, true) : null;
  const { result, listing, heads } = await planWithoutLocks(repo);
  if (warning !== null) {
    result.warnings.unshift(warning);
  }
  if (parsed.values.apply) {
    await applyPlan(result, heads, listing);
  }
  return result;
};
