import { lstat, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import timers from 'node:timers/promises';
import { identityOf, processSnapshot, protectWorktree } from './clean-processes.ts';
import type { ProcessIdentity } from './clean-processes.ts';
import { isUnder } from './paths.ts';
import { run } from './proc.ts';
import { isBusyProcess } from './teardown.ts';
import { ls, processOf } from './tern.ts';
import type { TernProcessSnapshot } from './tern.ts';

/** A repository process whose identity is examined again before each signal. */
export interface CleanProcess {
  pid: number;
  cwd: string;
  command: string;
}

/** The repository and the worktrees selected by the Git plan. */
export interface ResourceContext {
  repo: string;
  worktrees: string[];
  removeWorktrees: string[];
  prunableWorktrees?: string[];
}

interface KeepResource {
  kind: string;
  id: string;
  reason: string;
}

/** Resources selected for removal and the ownership evidence kept by planning. */
export interface ResourcePlan {
  processes: CleanProcess[];
  containers: string[];
  paths: string[];
  keep: KeepResource[];
  warnings: string[];
  protectedWorktrees: string[];
}

interface ContainerInfo {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> | null };
  Mounts: { Source: string }[];
}

interface ResourceSample {
  entries: ProcessIdentity[];
  containers: ContainerInfo[];
  keep: KeepResource[];
  warnings: string[];
  protectedWorktrees: string[];
  sessions: { block: { cwd: string | null; id: number }; snapshot: TernProcessSnapshot }[] | null;
}

const resourceSamples = new WeakMap<ResourcePlan, ResourceSample>();
const processIdentities = new WeakMap<CleanProcess, ProcessIdentity>();
const containerIdentities = new Map<string, string>();
const pathIdentities = new Map<string, { dev: number; ino: number }>();
const underAny = (cwd: string, roots: string[]): boolean => roots.some(root => isUnder(cwd, root));
const protectedCommand = /(?:^|[\s/])(?:tern(?:-daemon)?|tern-wt\.service|dockerd?|rootlesskit|slirp4netns|containerd(?:-shim[^\s/]*)?|sshd|systemd)(?:\s|$)/u;
const ompCommand = /(?:^|[\s/])omp(?:\s|$)|[/]omp[/].*(?:cli|main)[.](?:js|ts)/u;

const descendants = (seeds: Set<number>, entries: ProcessIdentity[]): void => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!seeds.has(entry.pid) && seeds.has(entry.parent)) {
        seeds.add(entry.pid);
        changed = true;
      }
    }
  }
};

const inspectContainers = async (ids?: string[]): Promise<ContainerInfo[]> => {
  let selected = ids;
  if (selected === undefined) {
    const listing = await run(['docker', 'ps', '-aq', '--no-trunc']);
    if (listing.status !== 0) {
      return [];
    }
    selected = listing.stdout.trim().split(/\s+/u).filter(Boolean);
  }
  if (selected.length === 0) {
    return [];
  }
  const result = await run(['docker', 'inspect', ...selected]);
  if (result.status !== 0) {
    return [];
  }
  try {
    // SAFETY: `docker inspect` returns the container schema and consumers examine its fields.
    return JSON.parse(result.stdout) as ContainerInfo[];
  } catch {
    return [];
  }
};

const sharedContainer = (container: ContainerInfo): boolean =>
  container.Name?.replace(/^\//u, '').startsWith('tern-wt-') ||
  Object.entries(container.Config?.Labels ?? {}).some(([key, value]) => /tern-wt(?:[.-]|$)/u.test(key) || /(?:^|\/)tern-wt(?:[.-]|$)/u.test(value));

const sessionEnded = (container: ContainerInfo, containers: ContainerInfo[], sources: string[], liveCwds: string[], session: string | undefined): boolean =>
  session !== undefined &&
  !containers.some(other => other.Id !== container.Id && other.Config?.Labels?.['org.testcontainers.sessionId'] === session) &&
  !sources.some(source => liveCwds.some(cwd => isUnder(cwd, source)));

const exclusivelyRemoved = (sources: string[], ctx: ResourceContext, plan: ResourcePlan): boolean =>
  sources.some(source => underAny(source, ctx.removeWorktrees)) &&
  sources.every(source => !underAny(source, plan.protectedWorktrees) && (!underAny(source, [ctx.repo, ...ctx.worktrees]) || underAny(source, ctx.removeWorktrees)));

const selectContainer = (container: ContainerInfo, containers: ContainerInfo[], ctx: ResourceContext, plan: ResourcePlan, liveCwds: string[]): void => {
  const sources = [...(container.Mounts ?? []).map(mount => mount.Source), ...Object.values(container.Config?.Labels ?? {})].filter(source => path.isAbsolute(source));
  if (!container.Id || sharedContainer(container) || !sources.some(source => underAny(source, [ctx.repo, ...ctx.worktrees]))) {
    return;
  }
  if (
    container.Config?.Labels?.['org.testcontainers'] === 'true' &&
    !sessionEnded(container, containers, sources, liveCwds, container.Config.Labels['org.testcontainers.sessionId'])
  ) {
    plan.keep.push({ id: container.Id, kind: 'container', reason: 'Testcontainers session termination cannot be proven.' });
  } else if (exclusivelyRemoved(sources, ctx, plan)) {
    plan.containers.push(container.Id);
    containerIdentities.set(container.Id, JSON.stringify(container));
  } else {
    plan.keep.push({ id: container.Id, kind: 'container', reason: 'Container is not exclusively tied to a removed worktree.' });
  }
};

const planContainers = (ctx: ResourceContext, plan: ResourcePlan, liveCwds: string[], containers: ContainerInfo[]): void => {
  for (const container of containers) {
    selectContainer(container, containers, ctx, plan, liveCwds);
  }
};

interface ProcessProtection {
  activeCwds: string[];
  activeProcesses: CleanProcess[];
  liveCwds: string[];
  protectedIds: Set<number>;
  sessionIds: Set<number>;
}

const callerProtection = (entries: ProcessIdentity[], byPid: Map<number, ProcessIdentity>): ProcessProtection => {
  const protection: ProcessProtection = {
    activeCwds: [process.cwd()],
    activeProcesses: [],
    liveCwds: entries.map(entry => entry.cwd),
    protectedIds: new Set([process.ppid]),
    sessionIds: new Set([process.pid]),
  };
  let ancestor = byPid.get(process.pid);
  const visited = new Set<number>();
  while (ancestor !== undefined && !visited.has(ancestor.pid)) {
    visited.add(ancestor.pid);
    protection.protectedIds.add(ancestor.pid);
    protection.activeCwds.push(ancestor.cwd);
    ancestor = byPid.get(ancestor.parent);
  }
  return protection;
};

const protectInfrastructure = (entries: ProcessIdentity[], protection: ProcessProtection): void => {
  const liveOmp = new Set<number>();
  for (const entry of entries) {
    if (ompCommand.test(entry.command)) {
      liveOmp.add(entry.pid);
      protection.activeCwds.push(entry.cwd);
    }
    if (protectedCommand.test(entry.command)) {
      protection.protectedIds.add(entry.pid);
    }
  }
  descendants(liveOmp, entries);
  for (const pid of liveOmp) {
    protection.protectedIds.add(pid);
  }
};

const protectSnapshot = (snapshot: TernProcessSnapshot, entries: ProcessIdentity[], protection: ProcessProtection): void => {
  for (const member of [snapshot.child, snapshot.foreground]) {
    if (member !== null) {
      protection.sessionIds.add(member.pid);
    }
  }
  for (const entry of entries) {
    if (entry.group === snapshot.group) {
      protection.sessionIds.add(entry.pid);
    }
  }
};

const protectBusyBlock = (cwd: string | null, snapshot: TernProcessSnapshot, protection: ProcessProtection): void => {
  for (const member of [snapshot.child, snapshot.foreground]) {
    if (member !== null && member.cwd !== null) {
      protection.activeProcesses.push({ command: member.argv.length > 0 ? member.argv.join(' ') : member.name, cwd: member.cwd, pid: member.pid });
    }
  }
  for (const activeCwd of [cwd, snapshot.child?.cwd, snapshot.foreground?.cwd]) {
    if (activeCwd !== null && activeCwd !== undefined) {
      protection.activeCwds.push(activeCwd);
    }
  }
};

const protectBlock = (
  block: { cwd: string | null; id: number },
  snapshot: TernProcessSnapshot,
  ctx: ResourceContext,
  entries: ProcessIdentity[],
  protection: ProcessProtection,
): void => {
  if (block.cwd !== null) {
    protection.liveCwds.push(block.cwd);
  }
  const busy = isBusyProcess(snapshot);
  if (busy) {
    protectBusyBlock(block.cwd, snapshot, protection);
  }
  if (!busy && block.cwd !== null && underAny(block.cwd, ctx.removeWorktrees)) {
    return;
  }
  protectSnapshot(snapshot, entries, protection);
};

const protectSessions = async (
  ctx: ResourceContext,
  entries: ProcessIdentity[],
  protection: ProcessProtection,
  warnings: string[],
  sessions: ResourceSample['sessions'],
): Promise<boolean> => {
  if (sessions === null) {
    warnings.push('Cannot prove live Tern session ownership; processes are preserved.');
    return false;
  }
  for (const { block, snapshot } of sessions) {
    protectBlock(block, snapshot, ctx, entries, protection);
  }
  await Promise.resolve();
  return true;
};

const processKeepReason = (entry: ProcessIdentity, parent: ProcessIdentity | undefined, ctx: ResourceContext, protection: ProcessProtection, sessionsKnown: boolean): string => {
  const orphan = entry.parent === 1 || (parent !== undefined && /(?:^|\/)systemd\s+--user(?:\s|$)/u.test(parent.command));
  if (protection.protectedIds.has(entry.pid)) {
    return 'Caller, live session, or shared infrastructure process.';
  }
  if (!sessionsKnown) {
    return 'Live session ownership is uncertain.';
  }
  if (/chrome_crashpad_handler/u.test(entry.command)) {
    return 'Browser ownership cannot be proven from process ancestry.';
  }
  return !underAny(entry.cwd, ctx.removeWorktrees) && !orphan ? 'Process is neither in a removed worktree nor a proven orphan.' : '';
};

const selectProcess = (entry: ProcessIdentity, reason: string, ctx: ResourceContext, plan: ResourcePlan): void => {
  if (reason) {
    const detailedReason = `Process ${entry.pid} (${entry.command}): ${reason}`;
    plan.keep.push({ id: String(entry.pid), kind: 'process', reason: detailedReason });
    for (const worktree of ctx.worktrees) {
      if (isUnder(entry.cwd, worktree)) {
        protectWorktree(plan, worktree, detailedReason);
      }
    }
  } else {
    const selected: CleanProcess = { command: entry.command, cwd: entry.cwd, pid: entry.pid };
    processIdentities.set(selected, entry);
    plan.processes.push(selected);
  }
};

const planPath = async (target: string, ctx: ResourceContext, plan: ResourcePlan): Promise<void> => {
  if (underAny(target, plan.protectedWorktrees) || target === ctx.repo) {
    return;
  }
  try {
    const info = await lstat(target);
    if (!info.isDirectory()) {
      return;
    }
    const files = await readdir(target);
    if (files.length === 0) {
      plan.paths.push(target);
      pathIdentities.set(target, { dev: info.dev, ino: info.ino });
    }
  } catch {
    // Missing worktrees have no remaining directory to remove.
  }
};

const worktreeProtectionReason = (worktree: string, entries: ProcessIdentity[], protection: ProcessProtection, sessionsKnown: boolean): string => {
  if (!sessionsKnown) {
    return 'Live Tern session ownership cannot be proven.';
  }
  const active = [...entries.filter(entry => protection.protectedIds.has(entry.pid)), ...protection.activeProcesses].filter(entry => isUnder(entry.cwd, worktree));
  if (active.length === 0) {
    return 'Caller cwd or busy Tern block uses this worktree.';
  }
  return active.map(entry => `Process ${entry.pid} (${entry.command}) is active or protected.`).join(' ');
};

const sampleResources = async (ctx: ResourceContext, plan: ResourcePlan): Promise<ResourceSample> => {
  const entries = await processSnapshot(ctx, plan);
  let sessions: ResourceSample['sessions'] = null;
  try {
    const listing = await ls();
    sessions = await Promise.all(listing.sessions.flatMap(session => session.tabs.flatMap(tab => tab.blocks)).map(async block => ({ block, snapshot: await processOf(block.id) })));
  } catch {
    // An unavailable sample protects all worktrees in each subsequent selection.
  }
  return { containers: await inspectContainers(), entries, keep: [...plan.keep], protectedWorktrees: [...plan.protectedWorktrees], sessions, warnings: [...plan.warnings] };
};

/** Samples resources once. A previous plan lets selection reuse the same read-only evidence. */
export const planResources = async (ctx: ResourceContext, previous?: ResourcePlan): Promise<ResourcePlan> => {
  const plan: ResourcePlan = { containers: [], keep: [], paths: [], processes: [], protectedWorktrees: [], warnings: [] };
  let sample = previous === undefined ? undefined : resourceSamples.get(previous);
  if (sample === undefined) {
    sample = await sampleResources(ctx, plan);
  } else {
    plan.keep.push(...sample.keep);
    plan.protectedWorktrees.push(...sample.protectedWorktrees);
    plan.warnings.push(...sample.warnings);
  }
  resourceSamples.set(plan, sample);
  const { entries } = sample;
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  const protection = callerProtection(entries, byPid);
  protectInfrastructure(entries, protection);
  const sessionsKnown = await protectSessions(ctx, entries, protection, plan.warnings, sample.sessions);
  descendants(protection.sessionIds, entries);
  for (const pid of protection.sessionIds) {
    protection.protectedIds.add(pid);
  }
  for (const worktree of ctx.worktrees) {
    if (!sessionsKnown || protection.activeCwds.some(cwd => isUnder(cwd, worktree))) {
      protectWorktree(plan, worktree, worktreeProtectionReason(worktree, entries, protection, sessionsKnown));
    }
  }
  for (const entry of entries) {
    if (underAny(entry.cwd, [ctx.repo, ...ctx.worktrees])) {
      selectProcess(entry, processKeepReason(entry, byPid.get(entry.parent), ctx, protection, sessionsKnown), ctx, plan);
    }
  }
  planContainers(ctx, plan, protection.liveCwds, sample.containers);
  await Promise.all(
    (ctx.prunableWorktrees ?? []).map(async target => {
      await planPath(target, ctx, plan);
    }),
  );
  return plan;
};

const sameProcess = (current: ProcessIdentity | null, expected: ProcessIdentity): boolean =>
  current !== null && current.start === expected.start && current.cwd === expected.cwd && current.command === expected.command;

const waitForExit = async (expected: ProcessIdentity, attempts: number): Promise<void> => {
  if (attempts === 0) {
    return;
  }
  await timers.setTimeout(100);
  if (sameProcess(await identityOf(expected.pid), expected)) {
    await waitForExit(expected, attempts - 1);
  }
};

const stopProcess = async (selected: CleanProcess, warnings: string[]): Promise<number[]> => {
  try {
    const expected = processIdentities.get(selected);
    if (expected === undefined || !sameProcess(await identityOf(selected.pid), expected)) {
      warnings.push(`Preserved process ${selected.pid}: identity or cwd changed.`);
      return (await identityOf(selected.pid)) === null ? [] : [selected.pid];
    }
    try {
      process.kill(selected.pid, 'SIGTERM');
      await waitForExit(expected, 10);
      if (sameProcess(await identityOf(selected.pid), expected)) {
        process.kill(selected.pid, 'SIGKILL');
        await timers.setTimeout(100);
      }
    } catch (error) {
      warnings.push(`Cannot stop process ${selected.pid}: ${String(error)}`);
    }
    if ((await identityOf(selected.pid)) !== null) {
      warnings.push(`Preserved process ${selected.pid}: process remains alive after signalling.`);
      return [selected.pid];
    }
    return [];
  } catch (error) {
    warnings.push(`Preserved process ${selected.pid}: inspection unavailable: ${String(error)}`);
    return [selected.pid];
  }
};

const removeContainer = async (id: string, warnings: string[]): Promise<void> => {
  const [current] = await inspectContainers([id]);
  if (current === undefined || sharedContainer(current) || containerIdentities.get(id) !== JSON.stringify(current)) {
    warnings.push(`Preserved container ${id}: identity or ownership changed.`);
    return;
  }
  const result = await run(['docker', 'rm', '-f', id]);
  if (result.status !== 0) {
    warnings.push(`Cannot remove container ${id}: ${result.stderr.trim()}`);
  }
};

const removePath = async (target: string, warnings: string[]): Promise<void> => {
  try {
    const expected = pathIdentities.get(target);
    const current = await lstat(target);
    if (expected === undefined || current.dev !== expected.dev || current.ino !== expected.ino) {
      warnings.push(`Preserved path ${target}: directory identity changed.`);
      return;
    }
    await rmdir(target);
  } catch (error) {
    // Git can remove the empty directory first.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      warnings.push(`Preserved path ${target}: ${String(error)}`);
    }
  }
};

/** Applies sampled identities, examining them again before TERM, KILL, Docker removal and `rmdir`. */
export const applyResources = async (plan: { processes: CleanProcess[]; containers: string[]; paths: string[] }, warnings: string[]): Promise<{ failedProcesses: number[] }> => {
  const failedProcesses: number[] = [];
  for (const selected of plan.processes) {
    // Signals must finish before the next identity is examined and killed.
    // oxlint-disable-next-line no-await-in-loop
    failedProcesses.push(...(await stopProcess(selected, warnings)));
  }
  for (const id of plan.containers) {
    // Container removals start only after all signal phases complete.
    // oxlint-disable-next-line no-await-in-loop
    await removeContainer(id, warnings);
  }
  for (const target of plan.paths) {
    // Path removal starts only after all container removals complete.
    // oxlint-disable-next-line no-await-in-loop
    await removePath(target, warnings);
  }
  return { failedProcesses };
};
