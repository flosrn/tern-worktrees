import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cleanLinks, cleanReachability } from '../clean-linked.ts';
import type { CleanPlan, PlanContext, PlannedHeads, RemovalDetail } from '../clean-plan.ts';
import { inspectCleanItems } from '../clean-pool.ts';
import { guardCleanRecovery, recoverCleanTarget } from '../clean-recovery.ts';
import { applyResources, planResources } from '../clean-resources.ts';
import type { CleanProcess, ResourcePlan } from '../clean-resources.ts';
import { fetchOrigin, gitMust, gitRun, isAncestor, requireRepoRoot, worktrees } from '../git.ts';
import type { Worktree } from '../git.ts';
import { defaultBranch, readOrigin } from '../github.ts';
import { isUnder } from '../paths.ts';
import { CliError } from '../proc.ts';
import { guardBusyTabs, isCleanMerged } from '../teardown.ts';
import { blocksUnder, close, ls } from '../tern.ts';
import type { PlacedBlock, TernListing } from '../tern.ts';
import { guardWorkToLose } from '../work-to-lose.ts';

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

const inspectBranch = async (ctx: PlanContext, branch: string): Promise<string | null> => {
  try {
    if (branch === ctx.result.default) {
      return 'default branch';
    }
    if (ctx.links.branches.has(branch) || (await isCleanMerged(ctx.result.repo, branch, ctx.result.default, ctx.proven.has(branch), ctx.defaultTree))) {
      return null;
    }
    return 'not merged';
  } catch (error) {
    return `branch inspection failed: ${error instanceof Error ? error.message : String(error)}`;
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
  if (await busyBlocks(blocksUnder(ctx.listing, entry.path))) {
    return 'busy or protected process';
  }
  return entry.branch === null ? null : (ctx.branchReasons.get(entry.branch) ?? null);
};

/** Closed associations can authorize changes. Ignored hard-to-rebuild files stay protected. */
const inspectWork = async (dir: string, repo: string, linked: boolean): Promise<boolean> => {
  try {
    await guardWorkToLose(dir, { removing: repo }, repo);
    return false;
  } catch (error) {
    const dirty = error instanceof CliError && error.code === 'dirty_worktree';
    if (linked && dirty && Array.isArray(error.extra.hardToRebuild) && error.extra.hardToRebuild.length === 0) {
      return true;
    }
    throw error;
  }
};

const inspectWorktree = async (ctx: PlanContext, entry: Worktree): Promise<{ reason: string | null; dirty: boolean }> => {
  try {
    const retained = await retainedWorktreeReason(ctx, entry);
    if (retained !== null) {
      return { dirty: false, reason: retained };
    }
    const linked = ctx.links.worktrees.has(entry.path);
    if (entry.branch === null && !linked && !(await isAncestor(ctx.result.repo, entry.head, `origin/${ctx.result.default}`))) {
      return { dirty: false, reason: 'detached HEAD is not reachable from origin/default' };
    }
    return { dirty: await inspectWork(entry.path, ctx.result.repo, linked), reason: null };
  } catch (error) {
    const files = error instanceof CliError && error.code === 'dirty_worktree' ? error.extra.files : null;
    const names = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
    const details = names.length > 0 ? `: ${names.join(', ')}` : '';
    return { dirty: false, reason: `worktree inspection failed: ${error instanceof Error ? error.message : String(error)}${details}` };
  }
};

// Reuse the original resource sample when newly protected worktrees shrink candidates.
const selectResources = async (ctx: PlanContext): Promise<ResourcePlan> => {
  const { result } = ctx;
  const previous = ctx.resources;
  const selected = await planResources(
    { prunableWorktrees: ctx.prunableWorktrees, removeWorktrees: result.remove.worktrees, repo: result.repo, worktrees: ctx.paths },
    ctx.resources,
  );
  ctx.resources = selected;
  const rejected = result.remove.worktrees.filter(dir => selected.protectedWorktrees.includes(dir));
  if (rejected.length === 0) {
    return selected;
  }
  for (const dir of rejected) {
    result.keep.push({
      id: dir,
      kind: 'worktree',
      reason:
        selected.keep.find(item => item.kind === 'worktree' && item.id === dir)?.reason ??
        (previous.protectedWorktrees.includes(dir) ? 'active or protected process' : 'busy or protected process'),
    });
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
      const reason = ctx.links.branches.get(branch);
      const head = ctx.heads.branches.get(branch);
      if (reason !== undefined || ctx.local.has(String(head))) {
        ctx.details.push({ id: branch, kind: 'branch', reason: reason ?? 'integrated branch with local-only commits', recovery: true });
      }
    }
  }
};

const inspectPlan = async (ctx: PlanContext): Promise<void> => {
  const names = [...ctx.heads.branches.keys()];
  const branchDecisions = await inspectCleanItems(names, async branch => await inspectBranch(ctx, branch));
  for (const [index, branch] of names.entries()) {
    const reason = branchDecisions[index];
    if (reason === null) {
      ctx.safeBranches.add(branch);
    } else {
      ctx.result.keep.push({ id: branch, kind: 'branch', reason });
      ctx.branchReasons.set(branch, reason);
    }
  }
  const decisions = await inspectCleanItems(ctx.entries, async entry => await inspectWorktree(ctx, entry));
  for (const [index, entry] of ctx.entries.entries()) {
    const { reason, dirty } = decisions[index];
    if (reason !== null) {
      ctx.result.keep.push({ id: entry.path, kind: 'worktree', reason });
      continue;
    }
    ctx.result.remove.worktrees.push(entry.path);
    const linked = ctx.links.worktrees.get(entry.path);
    if (linked !== undefined || dirty || ctx.local.has(entry.head)) {
      ctx.details.push({ id: entry.path, kind: 'worktree', reason: linked ?? 'integrated worktree with local-only commits', recovery: true });
    }
  }
};

const finishPlan = (ctx: PlanContext, selected: ResourcePlan): void => {
  const { result } = ctx;
  selectBranches(ctx);
  result.remove.processes = selected.processes;
  result.remove.containers = selected.containers;
  result.remove.paths = selected.paths;
  for (const kept of selected.keep) {
    if (kept.kind !== 'worktree' || !result.keep.some(existing => existing.kind === 'worktree' && existing.id === kept.id)) {
      result.keep.push(kept);
    }
  }
  result.warnings.push(...selected.warnings);
  const details = ctx.details.filter(item => (item.kind === 'branch' ? result.remove.branches.includes(item.id) : result.remove.worktrees.includes(item.id)));
  if (details.length > 0) {
    result.removalDetails = details;
  }
};

const plan = async (repo: string): Promise<PlanContext> => {
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
  const branchOutput = await gitMust(repo, 'for-each-ref', '--format=%(refname:strip=2)%00%(objectname)', 'refs/heads');
  const branches = branchOutput
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\0'));
  const heads: PlannedHeads = { branches: new Map(branches.map(([branch, head]) => [branch, head])), worktrees: new Map(entries.map(entry => [entry.path, entry.head])) };
  const links = await cleanLinks(repo, origin.github, [...heads.branches.keys()], entries, result.warnings);
  const [{ proven, local }, defaultTree] = await Promise.all([
    cleanReachability(repo, base, heads.branches, links.mergedHeads, entries),
    gitRun(repo, 'rev-parse', `origin/${base}^{tree}`),
  ]);
  let listing: TernListing | null = null;
  try {
    listing = await ls();
  } catch (error) {
    result.warnings.push(`Tern inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ctx: PlanContext = {
    branchReasons: new Map(),
    cwd: realpathSync(process.cwd()),
    defaultTree: defaultTree.status === 0 ? defaultTree.stdout.trim() : null,
    details: [],
    entries,
    heads,
    links,
    listing,
    local,
    paths,
    proven,
    prunableWorktrees,
    resources,
    result,
    safeBranches: new Set(),
  };
  await inspectPlan(ctx);
  const selected = await selectResources(ctx);
  finishPlan(ctx, selected);
  return ctx;
};

const planWithoutLocks = async (repo: string): Promise<PlanContext> => {
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

const guardLiveWorktree = async (ctx: PlanContext, dir: string): Promise<TernListing> => {
  const listing = await ls();
  const entries = await worktrees(ctx.result.repo);
  const entry = entries.find(candidate => candidate.path === dir);
  if (entry === undefined || entry.locked !== null || isUnder(realpathSync(process.cwd()), dir)) {
    throw new CliError('git_failed', 'worktree became locked, active or unavailable after planning');
  }
  await guardBusyTabs(blocksUnder(listing, dir));
  await guardPlannedWorktree(ctx.heads, dir);
  return listing;
};

const retainRecoveryFailure = (ctx: PlanContext, detail: RemovalDetail, message: string): void => {
  const { result } = ctx;
  result.keep.push({ id: detail.id, kind: detail.kind, reason: message });
  result.warnings.push(`${detail.kind} ${detail.id} not removed: ${message}`);
  if (detail.kind === 'worktree') {
    result.remove.worktrees = result.remove.worktrees.filter(dir => dir !== detail.id);
    const branch = ctx.entries.find(entry => entry.path === detail.id)?.branch;
    if (branch !== null && branch !== undefined && result.remove.branches.includes(branch)) {
      result.keep.push({ id: branch, kind: 'branch', reason: 'worktree recovery failed' });
    }
    result.remove.branches = result.remove.branches.filter(name => name !== branch);
    return;
  }
  result.remove.branches = result.remove.branches.filter(branch => branch !== detail.id);
  const associated = ctx.entries.filter(entry => entry.branch === detail.id && result.remove.worktrees.includes(entry.path));
  for (const entry of associated) {
    result.keep.push({ id: entry.path, kind: 'worktree', reason: 'branch recovery failed' });
  }
  result.remove.worktrees = result.remove.worktrees.filter(dir => !associated.some(entry => entry.path === dir));
};

const recoverDetail = async (ctx: PlanContext, detail: RemovalDetail): Promise<void> => {
  let branch = detail.id;
  let head = '';
  let worktree: string | null = null;
  if (detail.kind === 'worktree') {
    await guardLiveWorktree(ctx, detail.id);
    await inspectWork(detail.id, ctx.result.repo, ctx.links.worktrees.has(detail.id));
    branch = ctx.entries.find(entry => entry.path === detail.id)?.branch ?? '';
    head = String(ctx.heads.worktrees.get(detail.id));
    worktree = detail.id;
  } else {
    head = String(ctx.heads.branches.get(detail.id));
  }
  detail.recoveryPath = await recoverCleanTarget({ branch: branch === '' ? null : branch, head, repo: ctx.result.repo, worktree });
};

/** Completes all recovery copies before removing resources, worktrees or branches. */
const prepareRecovery = async (ctx: PlanContext): Promise<void> => {
  for (const detail of ctx.result.removalDetails ?? []) {
    const selected = detail.kind === 'branch' ? ctx.result.remove.branches : ctx.result.remove.worktrees;
    if (!selected.includes(detail.id)) {
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await recoverDetail(ctx, detail);
    } catch (error) {
      retainRecoveryFailure(ctx, detail, `recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

const removeGitWorktree = async (ctx: PlanContext, dir: string, dirty: boolean, detail: RemovalDetail | undefined): Promise<void> => {
  const removal = await gitRun(ctx.result.repo, '-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', ...(dirty ? ['--force'] : []), dir);
  if (removal.status === 0) {
    return;
  }
  if (!removal.stderr.includes('working trees containing submodules cannot be moved or removed')) {
    throw new CliError('git_failed', removal.stderr.trim());
  }
  await guardLiveWorktree(ctx, dir);
  await inspectWork(dir, ctx.result.repo, ctx.links.worktrees.has(dir));
  if (detail?.recoveryPath !== undefined) {
    await guardCleanRecovery(dir, detail.recoveryPath);
  }
  await gitMust(ctx.result.repo, 'worktree', 'remove', '--force', dir);
};

const removeWorktree = async (ctx: PlanContext, failed: CleanProcess[], dir: string): Promise<boolean> => {
  const { result } = ctx;
  if (failed.some(candidate => isUnder(candidate.cwd, dir))) {
    result.keep.push({ id: dir, kind: 'worktree', reason: 'process could not be safely stopped' });
    return false;
  }
  try {
    const listing = await guardLiveWorktree(ctx, dir);
    const dirty = await inspectWork(dir, result.repo, ctx.links.worktrees.has(dir));
    const detail = result.removalDetails?.find(item => item.kind === 'worktree' && item.id === dir);
    if (detail?.recoveryPath !== undefined) {
      await guardCleanRecovery(dir, detail.recoveryPath);
    }
    await removeGitWorktree(ctx, dir, dirty, detail);
    for (const entry of blocksUnder(listing, dir)) {
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
  const entries = await worktrees(result.repo);
  if (entries.some(entry => entry.branch === branch)) {
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

const removePlannedWorktrees = async (ctx: PlanContext, failed: CleanProcess[]): Promise<string[]> => {
  const removed: string[] = [];
  if (ctx.listing === null) {
    return removed;
  }
  for (const dir of ctx.result.remove.worktrees) {
    // eslint-disable-next-line no-await-in-loop
    if (await removeWorktree(ctx, failed, dir)) {
      removed.push(dir);
    }
  }
  return removed;
};

const applyPlan = async (ctx: PlanContext): Promise<void> => {
  const { result, heads } = ctx;
  ctx.resources = await planResources({ prunableWorktrees: ctx.prunableWorktrees, removeWorktrees: result.remove.worktrees, repo: result.repo, worktrees: ctx.paths });
  const live = await selectResources(ctx);
  result.remove.processes = live.processes;
  result.remove.containers = live.containers;
  result.remove.paths = live.paths;
  const planned = [...result.remove.worktrees];
  await prepareRecovery(ctx);
  if (planned.some(dir => !result.remove.worktrees.includes(dir))) {
    const selected = await selectResources(ctx);
    result.remove.processes = selected.processes;
    result.remove.containers = selected.containers;
    result.remove.paths = selected.paths;
  }
  const retained = ctx.entries.filter(entry => !result.remove.worktrees.includes(entry.path) && !entry.main).map(entry => entry.path);
  result.remove.processes = result.remove.processes.filter(candidate => !retained.some(dir => isUnder(candidate.cwd, dir)));
  const { failedProcesses } = await applyResources(result.remove, result.warnings);
  const failed = result.remove.processes.filter(candidate => failedProcesses.includes(candidate.pid));
  result.remove.processes = result.remove.processes.filter(candidate => !failedProcesses.includes(candidate.pid));
  const removed = await removePlannedWorktrees(ctx, failed);
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
  if (result.removalDetails !== undefined) {
    result.removalDetails = result.removalDetails.filter(
      item => item.recoveryPath !== undefined || (item.kind === 'branch' ? deleted.includes(item.id) : removed.includes(item.id)),
    );
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
  const ctx = await planWithoutLocks(repo);
  if (warning !== null) {
    ctx.result.warnings.unshift(warning);
  }
  if (parsed.values.apply) {
    await applyPlan(ctx);
  }
  return ctx.result;
};
