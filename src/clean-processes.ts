import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CleanProcess, ResourceContext, ResourcePlan } from './clean-resources.ts';
import { envVar, isUnder } from './paths.ts';
import { run } from './proc.ts';

const procRoot = (): string => envVar('TERN_WT_PROC_ROOT') ?? '/proc';

export interface ProcessIdentity extends CleanProcess {
  parent: number;
  group: number;
  start: string;
}
interface ProcessInspection {
  identity: ProcessIdentity | null;
  incomplete?: { cwd?: string };
}

const processDirectoryMissing = async (dir: string): Promise<boolean> => {
  try {
    await stat(dir);
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
  return false;
};

const inspectOwner = async (dir: string): Promise<ProcessInspection | null> => {
  try {
    const owner = await stat(dir);
    if (process.getuid === undefined) {
      return { identity: null, incomplete: {} };
    }
    if (owner.uid !== process.getuid()) {
      return { identity: null };
    }
  } catch {
    if (await processDirectoryMissing(dir)) {
      return { identity: null };
    }
    return { identity: null, incomplete: {} };
  }
  return null;
};

const inspectedCwd = (cwd: PromiseSettledResult<string>): string | undefined => {
  if (cwd.status !== 'fulfilled' || !path.isAbsolute(cwd.value) || cwd.value.endsWith(' (deleted)')) {
    return undefined;
  }
  return cwd.value;
};

const inspectProcess = async (pid: number): Promise<ProcessInspection> => {
  const dir = path.join(procRoot(), String(pid));
  const ownership = await inspectOwner(dir);
  if (ownership !== null) {
    return ownership;
  }
  const [raw, cwd, cmdline] = await Promise.allSettled([readFile(path.join(dir, 'stat'), 'utf-8'), readlink(path.join(dir, 'cwd')), readFile(path.join(dir, 'cmdline'), 'utf-8')]);
  const knownCwd = inspectedCwd(cwd);
  if (raw.status === 'fulfilled' && cmdline.status === 'fulfilled' && knownCwd !== undefined) {
    const fields = raw.value
      .slice(raw.value.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    const { 19: start } = fields;
    if (start) {
      return { identity: { command: cmdline.value.replaceAll('\0', ' ').trim(), cwd: knownCwd, group: Number(fields[2]), parent: Number(fields[1]), pid, start } };
    }
  }
  if (await processDirectoryMissing(dir)) {
    return { identity: null };
  }
  return { identity: null, incomplete: { cwd: knownCwd } };
};

/** Re-reads a process identity before signalling it. */
export const identityOf = async (pid: number): Promise<ProcessIdentity | null> => {
  const inspection = await inspectProcess(pid);
  return inspection.identity;
};

/** Records the concrete evidence preventing a worktree removal. */
export const protectWorktree = (plan: ResourcePlan, worktree: string, reason: string): void => {
  if (!plan.protectedWorktrees.includes(worktree)) {
    plan.protectedWorktrees.push(worktree);
  }
  plan.keep.push({ id: worktree, kind: 'worktree', reason });
};

interface InspectedProcessRow {
  pid: number;
  command: string;
  inspection: ProcessInspection;
}

const inspectProcessRows = async (stdout: string): Promise<InspectedProcessRow[]> => {
  const rows = stdout
    .split('\n')
    .filter(line => !/\s(?:\S*[/])?ps\s+-u\s/u.test(line))
    .map(line => {
      const fields = line.trim().split(/\s+/u);
      return { command: fields.slice(3).join(' '), pid: Number(fields[0]) };
    })
    .filter(row => Number.isSafeInteger(row.pid) && row.pid > 0);
  return await Promise.all(rows.map(async row => ({ ...row, inspection: await inspectProcess(row.pid) })));
};

const reportIncompleteProcesses = (entries: InspectedProcessRow[], ctx: ResourceContext, plan: ResourcePlan): void => {
  const incomplete = entries.filter(entry => entry.inspection.incomplete !== undefined);
  if (incomplete.length === 0) {
    return;
  }
  const descriptions = incomplete.map(entry => `${entry.pid} (${entry.command})`).join(', ');
  plan.warnings.push(`Process inspection incomplete: ${descriptions}.`);
  for (const entry of incomplete) {
    const reason = `Process inspection incomplete: ${entry.pid} (${entry.command}); process preserved.`;
    plan.keep.push({ id: String(entry.pid), kind: 'process', reason });
    const cwd = entry.inspection.incomplete?.cwd;
    if (cwd === undefined) {
      continue;
    }
    for (const worktree of ctx.worktrees) {
      if (isUnder(cwd, worktree)) {
        protectWorktree(plan, worktree, reason);
      }
    }
  }
};

/** Samples owned processes and records narrowly scoped inspection uncertainty. */
export const processSnapshot = async (ctx: ResourceContext, plan: ResourcePlan): Promise<ProcessIdentity[]> => {
  const unavailable = (reason: string): ProcessIdentity[] => {
    plan.warnings.push(reason);
    for (const worktree of ctx.worktrees) {
      protectWorktree(plan, worktree, reason);
    }
    return [];
  };
  if (process.platform !== 'linux' && envVar('TERN_WT_PROC_ROOT') === undefined) {
    return unavailable('Process inspection unavailable: Linux /proc only; worktree process ownership cannot be proven.');
  }
  try {
    const names = await readdir(procRoot());
    if (!names.some(name => /^\d+$/u.test(name))) {
      return [];
    }
  } catch {
    return unavailable('Cannot read process directory; worktree process ownership cannot be proven.');
  }
  const result = await run(['ps', '-u', String(process.getuid?.() ?? ''), '-o', 'pid=,ppid=,pgid=,args=']);
  if (result.status !== 0) {
    return unavailable('Cannot inspect processes; worktree process ownership cannot be proven.');
  }
  const entries = await inspectProcessRows(result.stdout);
  reportIncompleteProcesses(entries, ctx, plan);
  return entries.flatMap(entry => (entry.inspection.identity === null ? [] : [entry.inspection.identity]));
};
