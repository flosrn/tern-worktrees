import { identityOf, processSnapshot } from './clean-processes.ts';
import type { ProcessIdentity } from './clean-processes.ts';
import type { ResourcePlan } from './clean-resources.ts';
import { isJsonObject, isString } from './json.ts';
import { isUnder } from './paths.ts';
import { CliError } from './proc.ts';
import { isBusyProcess } from './teardown.ts';
import { blocksUnder, ls, processOf } from './tern.ts';
import type { PlacedBlock } from './tern.ts';
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
  if (!isJsonObject(tab) || !Number.isSafeInteger(tab.id) || !isString(tab.name)) {
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
const checkedBlocks = async (target: string): Promise<PlacedBlock[]> => {
  const listing = await ls();
  if (!isJsonObject(listing) || !Array.isArray(listing.sessions) || !listing.sessions.every(validSession)) {
    throw new CliError('tern_failed', 'Cannot inspect Tern sessions: invalid listing');
  }
  return blocksUnder(listing, target);
};

const inspectBlocks = async (state: StoredFinish, target: string, prospective: boolean, blocks: PlacedBlock[], idle: Set<number>): Promise<boolean> => {
  const samples = await Promise.all(blocks.map(async entry => ({ ...entry, snapshot: await processOf(entry.block.id) })));
  for (const { block, snapshot } of samples) {
    if (prospective && target === state.current && block.id === state.caller.block && state.caller.identity?.pid === snapshot.foreground?.pid) {
      if (snapshot.child !== null && !isBusyProcess({ ...snapshot, foreground: snapshot.child })) {
        idle.add(snapshot.child.pid);
      }
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

/** Reads process resources without sending a signal. */
export const finishActivity = async (state: StoredFinish, target: string, prospective: boolean): Promise<FinishActivity> => {
  const blocks = await checkedBlocks(target);
  const idle = new Set<number>();
  const busy = await inspectBlocks(state, target, prospective, blocks, idle);
  if (busy) {
    return { blocks, code: 'active_process', reason: null };
  }
  const resources: ResourcePlan = { containers: [], keep: [], paths: [], processes: [], protectedWorktrees: [], warnings: [] };
  const processes = await processSnapshot({ removeWorktrees: [target], repo: state.repo, worktrees: [target] }, resources);
  state.warnings.push(...resources.warnings.filter(warning => !state.warnings.includes(warning)));
  if (resources.protectedWorktrees.includes(target)) {
    return { blocks, code: 'inspection_failed', reason: resources.warnings.join(' ') };
  }
  const active = processes.find(entry => {
    if (!isUnder(entry.cwd, target) || entry.pid === process.pid || idle.has(entry.pid)) {
      return false;
    }
    return !(prospective && target === state.current && state.caller.identity !== null && sameFinishProcess(entry, state.caller.identity));
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
