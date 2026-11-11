import { identityOf, processSnapshot } from './clean-processes.ts';
import type { ProcessIdentity } from './clean-processes.ts';
import type { ResourcePlan } from './clean-resources.ts';
import { isJsonObject, isString } from './json.ts';
import { isUnder } from './paths.ts';
import { CliError } from './proc.ts';
import { isBusyProcess } from './teardown.ts';
import { blocksUnder, ls, placedBlocks, processOf } from './tern.ts';
import type { PlacedBlock, TernListing, TernProcessSnapshot } from './tern.ts';
import type { StoredFinish } from './finish-store.ts';

export type FinishActivity = { blocks: PlacedBlock[] } & ({ code: 'active_process' | null; reason: null } | { code: 'inspection_failed'; reason: string });

/** Includes birth identity, not just a reusable PID. */
export const sameFinishProcess = (left: ProcessIdentity, right: ProcessIdentity): boolean => {
  if (left.pid !== right.pid || left.start !== right.start) {
    return false;
  }
  return left.parent === right.parent && left.group === right.group && left.command === right.command;
};

const validBlock = (block: PlacedBlock['block']): boolean => {
  if (!isJsonObject(block) || !Number.isSafeInteger(block.id) || !isString(block.title)) {
    return false;
  }
  return block.cwd === null || isString(block.cwd);
};

const validTab = (tab: PlacedBlock['tab']): boolean => {
  if (!isJsonObject(tab) || !Number.isSafeInteger(tab.id) || !(tab.name === null || isString(tab.name))) {
    return false;
  }
  return Array.isArray(tab.blocks) && tab.blocks.every(validBlock);
};

const validSession = (session: PlacedBlock['session']): boolean => {
  if (!isJsonObject(session) || !Number.isSafeInteger(session.id) || !isString(session.name)) {
    return false;
  }
  return Array.isArray(session.tabs) && session.tabs.every(validTab);
};

/** A malformed Tern listing cannot prove that worktree tabs are not active. */
const checkedListing = async (): Promise<TernListing> => {
  const listing = await ls();
  if (!isJsonObject(listing) || !Array.isArray(listing.sessions) || !listing.sessions.every(validSession)) {
    throw new CliError('tern_failed', 'Cannot inspect Tern sessions: invalid listing');
  }
  return listing;
};

/** Exempts the caller terminal's idle shell and holds its busy command against the ancestry exemption. */
const sortCallerChild = (snapshot: TernProcessSnapshot, idle: Set<number>, held: Set<number>): void => {
  if (snapshot.child !== null) {
    (isBusyProcess({ ...snapshot, foreground: snapshot.child }) ? held : idle).add(snapshot.child.pid);
  }
};

/** Reports a busy worktree terminal. */
const inspectBlocks = async (state: StoredFinish, target: string, prospective: boolean, blocks: PlacedBlock[], idle: Set<number>, held: Set<number>): Promise<boolean> => {
  const samples = await Promise.all(blocks.map(async entry => ({ ...entry, snapshot: await processOf(entry.block.id) })));
  for (const { block, snapshot } of samples) {
    if (prospective && target === state.current && block.id === state.caller.block && state.caller.identity?.pid === snapshot.foreground?.pid) {
      sortCallerChild(snapshot, idle, held);
      continue;
    }
    if (isBusyProcess(snapshot)) {
      return true;
    }
    if (snapshot.child !== null && snapshot.foreground?.pid === snapshot.child.pid) {
      idle.add(snapshot.child.pid);
    }
  }
  return false;
};

/** Proves descent link by link in one snapshot. A missing link, a held link or a cycle stops the proof. */
const descendsFrom = (entry: ProcessIdentity, caller: ProcessIdentity, byPid: Map<number, ProcessIdentity>, held: Set<number>): boolean => {
  const seen = new Set<number>();
  let link: ProcessIdentity | undefined = entry;
  while (link !== undefined && !held.has(link.pid) && !seen.has(link.pid)) {
    seen.add(link.pid);
    link = byPid.get(link.parent);
    if (link !== undefined && sameFinishProcess(link, caller)) {
      return true;
    }
  }
  return false;
};

/** Reads process resources without sending a signal. */
export const finishActivity = async (state: StoredFinish, target: string, prospective: boolean): Promise<FinishActivity> => {
  const listing = await checkedListing();
  const blocks = blocksUnder(listing, target);
  const caller = prospective && target === state.current ? state.caller.identity : null;
  // Sample the caller's terminal wherever its block is. Then its busy command does not pass as a background descendant.
  const inspected = placedBlocks(listing).filter(({ block }) => blocks.some(entry => entry.block === block) || (caller !== null && block.id === state.caller.block));
  const idle = new Set<number>();
  const held = new Set<number>();
  const busy = await inspectBlocks(state, target, prospective, inspected, idle, held);
  if (busy) {
    return { blocks, code: 'active_process', reason: null };
  }
  const resources: ResourcePlan = { containers: [], keep: [], paths: [], processes: [], protectedWorktrees: [], warnings: [] };
  const processes = await processSnapshot({ removeWorktrees: [target], repo: state.repo, worktrees: [target] }, resources);
  state.warnings.push(...resources.warnings.filter(warning => !state.warnings.includes(warning)));
  if (resources.protectedWorktrees.includes(target)) {
    return { blocks, code: 'inspection_failed', reason: resources.warnings.join(' ') };
  }
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  const active = processes.find(entry => {
    if (!isUnder(entry.cwd, target) || entry.pid === process.pid || idle.has(entry.pid)) {
      return false;
    }
    return caller === null || !(sameFinishProcess(entry, caller) || descendsFrom(entry, caller, byPid, held));
  });
  return { blocks, code: active === undefined ? null : 'active_process', reason: null };
};

/** Waits for the registered caller when its directory is in a selected target. */
export const callerStillRunning = async (state: StoredFinish): Promise<'waiting' | 'unproven' | null> => {
  const pinned = state.caller.identity;
  if (state.caller.pid === null) {
    return state.current !== null && state.selected.includes(state.current) ? 'unproven' : null;
  }
  if (pinned !== null && !state.selected.some(target => isUnder(pinned.cwd, target))) {
    return null;
  }
  if (pinned === null) {
    return 'unproven';
  }
  const current = await identityOf(pinned.pid);
  if (current === null) {
    return null;
  }
  if (!sameFinishProcess(current, pinned)) {
    return 'unproven';
  }
  return 'waiting';
};
