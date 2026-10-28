import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CleanProcess, ResourceContext, ResourcePlan } from './clean-resources.ts';
import { envVar, isUnder } from './paths.ts';
import { run } from './proc.ts';
import type { RunResult } from './proc.ts';

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

interface DarwinProcessRow {
  pid: number;
  parent: number;
  group: number;
  start: string;
  command: string;
}

const darwinProcessRows = (stdout: string, uid: number): DarwinProcessRow[] =>
  stdout
    .trim()
    .split('\n')
    .map(line => {
      const fields = line.trim().split(/\s+/u);
      return {
        command: fields.slice(9).join(' '),
        group: Number(fields[2]),
        parent: Number(fields[1]),
        pid: Number(fields[0]),
        start: fields.slice(4, 9).join(' '),
        uid: Number(fields[3]),
      };
    })
    .filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && row.uid === uid && !/^(?:\S*[/])?(?:ps|lsof)\s/u.test(row.command));

const lsofPath = (value: string): string =>
  value.replaceAll(/(?:\\x[\da-f]{2})+|\\[\\bfnrt]/gu, token => {
    if (token.startsWith('\\x')) {
      return Buffer.from(token.replaceAll('\\x', ''), 'hex').toString('utf-8');
    }
    switch (token.slice(1)) {
      case 'b': {
        return '\b';
      }
      case 'f': {
        return '\f';
      }
      case 'n': {
        return '\n';
      }
      case 'r': {
        return '\r';
      }
      case 't': {
        return '\t';
      }
      default: {
        return '\\';
      }
    }
  });

const darwinCwds = (stdout: string): Map<number, string> => {
  const cwds = new Map<number, string>();
  let pid = 0;
  let descriptor = '';
  for (const raw of stdout.split('\0')) {
    const field = raw.replace(/^\n/u, '');
    if (field.startsWith('p')) {
      pid = Number(field.slice(1));
      descriptor = '';
    } else if (field.startsWith('f')) {
      descriptor = field.slice(1);
    } else if (field.startsWith('n') && descriptor === 'cwd' && Number.isSafeInteger(pid) && pid > 0) {
      cwds.set(pid, lsofPath(field.slice(1)));
    }
  }
  return cwds;
};

const inspectDarwinRow = (row: DarwinProcessRow, cwds: Map<number, string>, sampledAt: number): ProcessInspection => {
  const cwd = cwds.get(row.pid);
  const knownCwd = cwd !== undefined && path.isAbsolute(cwd) && !cwd.endsWith(' (deleted)') ? cwd : undefined;
  // Darwin ps exposes start time only to the second. A process born in the
  // sampling second could be replaced by an indistinguishable PID, so keep it.
  const startTime = Date.parse(`${row.start} GMT`);
  const validAncestry = Number.isSafeInteger(row.parent) && row.parent >= 0 && Number.isSafeInteger(row.group) && row.group > 0;
  const stableStart = Number.isFinite(startTime) && startTime < Math.floor(sampledAt / 1000) * 1000;
  if (knownCwd === undefined || !row.command || !validAncestry || !stableStart) {
    return { identity: null, incomplete: { cwd: knownCwd } };
  }
  return { identity: { command: row.command, cwd: knownCwd, group: row.group, parent: row.parent, pid: row.pid, start: row.start } };
};

// BSD ps exits 1 without output after the targeted process exits.
const darwinProcessMissing = (pid: number | undefined, result: RunResult): boolean => {
  const validStatus = result.status === 0 || result.status === 1;
  return pid !== undefined && result.stdout.trim() === '' && result.stderr.trim() === '' && validStatus;
};

const darwinInspection = async (pid?: number): Promise<{ entries: InspectedProcessRow[]; unavailable?: string }> => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return { entries: [], unavailable: 'Cannot identify the current user; worktree process ownership cannot be proven.' };
  }
  const sampledAt = Date.now();
  const selector = pid === undefined ? ['-U', String(uid)] : ['-p', String(pid)];
  const lsof = ['lsof', '-nP', '-a', '-u', String(uid), '-d', 'cwd', '-F0pfn'];
  if (pid !== undefined) {
    lsof.push('-p', String(pid));
  }
  const [processes, directories] = await Promise.all([
    run(['ps', '-ww', '-x', ...selector, '-o', 'pid=,ppid=,pgid=,uid=,lstart=,args='], { env: { LC_ALL: 'C', TZ: 'UTC' } }),
    run(lsof),
  ]);
  if (darwinProcessMissing(pid, processes)) {
    return { entries: [] };
  }
  if (directories.status !== 0 || directories.stderr.trim()) {
    const diagnostic = directories.stderr.trim();
    const detail = diagnostic ? `: ${diagnostic}` : '';
    return {
      entries: [],
      unavailable: `Cannot inspect process cwd with lsof (exit ${directories.status})${detail}; worktree process ownership cannot be proven.`,
    };
  }
  if (processes.status !== 0) {
    return { entries: [], unavailable: 'Cannot inspect processes; worktree process ownership cannot be proven.' };
  }
  const rows = darwinProcessRows(processes.stdout, uid);
  if (pid !== undefined && !rows.some(row => row.pid === pid)) {
    return { entries: [], unavailable: `Cannot prove owned process identity for PID ${pid}.` };
  }
  const cwds = darwinCwds(directories.stdout);
  return { entries: rows.map(row => ({ command: row.command, inspection: inspectDarwinRow(row, cwds, sampledAt), pid: row.pid })) };
};

/** Re-reads a process identity before signalling it. Rejects uncertain macOS inspection rather than reporting a false exit. */
export const identityOf = async (pid: number): Promise<ProcessIdentity | null> => {
  if (process.platform === 'darwin' && envVar('TERN_WT_PROC_ROOT') === undefined) {
    const { entries, unavailable } = await darwinInspection(pid);
    if (unavailable !== undefined) {
      throw new Error(unavailable);
    }
    const entry = entries.find(candidate => candidate.pid === pid);
    if (entry === undefined) {
      return null;
    }
    if (entry.inspection.identity === null) {
      throw new Error(`Process inspection incomplete: ${pid} (${entry.command}); process preserved.`);
    }
    return entry.inspection.identity;
  }
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
  if (process.platform === 'darwin' && envVar('TERN_WT_PROC_ROOT') === undefined) {
    const { entries, unavailable: reason } = await darwinInspection();
    if (reason !== undefined) {
      return unavailable(reason);
    }
    reportIncompleteProcesses(entries, ctx, plan);
    return entries.flatMap(entry => (entry.inspection.identity === null ? [] : [entry.inspection.identity]));
  }
  if (process.platform !== 'linux' && envVar('TERN_WT_PROC_ROOT') === undefined) {
    return unavailable('Process inspection unavailable: Linux /proc or macOS lsof required; worktree process ownership cannot be proven.');
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
