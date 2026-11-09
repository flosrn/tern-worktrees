import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { isFinishPullRequest } from './finish-proof.ts';
import type { RawFinishPullRequest } from './finish-proof.ts';
import type { FinishCandidate, FinishCauseCode, FinishKept, FinishState } from './finish-types.ts';
import type { ProcessIdentity } from './clean-processes.ts';
import { isJsonObject, isString } from './json.ts';
import { pluginData } from './paths.ts';
import { CliError } from './proc.ts';

interface FinishPathIdentity {
  dev: number;
  ino: number;
}
type FinishPathIdentities = Record<string, FinishPathIdentity>;

export interface StoredFinish extends FinishState {
  version: 2;
  owned: string[];
  excluded: string[];
  caller: { pid: number | null; identity: ProcessIdentity | null; block: number | null; session: string | null };
  identities: FinishPathIdentities;
  inFlight: string | null;
  notified: boolean;
}

interface FinishNotices {
  pending: string[];
  completed: string[];
}
interface FinishAcknowledgement {
  id: string;
  acknowledged: boolean;
}

interface RawFinishKept {
  path?: unknown;
  code?: unknown;
  detail?: unknown;
}
interface RawFinishCandidate extends RawFinishKept {
  branch?: unknown;
  head?: unknown;
  pr?: RawFinishPullRequest;
}
interface RawProcessIdentity {
  pid?: unknown;
  parent?: unknown;
  group?: unknown;
  start?: unknown;
  cwd?: unknown;
  command?: unknown;
}
interface RawFinishCaller {
  pid?: unknown;
  identity?: RawProcessIdentity | null;
  block?: unknown;
  session?: unknown;
}
interface RawFinishRemoved {
  path?: unknown;
  branchDeleted?: unknown;
  closedBlocks?: unknown;
}
interface RawFinishPathIdentity {
  dev?: unknown;
  ino?: unknown;
}
type RawFinishPathIdentities = Record<string, RawFinishPathIdentity>;
interface RawStoredFinish {
  version?: unknown;
  id?: unknown;
  repo?: unknown;
  current?: unknown;
  status?: unknown;
  ready?: unknown;
  notified?: unknown;
  candidates?: RawFinishCandidate[];
  selected?: string[];
  owned?: string[];
  excluded?: string[];
  caller?: RawFinishCaller;
  keep?: RawFinishKept[];
  errors?: RawFinishKept[];
  warnings?: string[];
  removed?: RawFinishRemoved[];
  identities?: RawFinishPathIdentities;
  inFlight?: unknown;
}
interface ValidFinishTargets extends RawStoredFinish {
  candidates: FinishCandidate[];
  selected: string[];
  owned: string[];
  excluded: string[];
}
interface ValidFinishMetadata extends RawStoredFinish {
  repo: string;
}

const validId = /^[a-f\d]{48}$/u;
const states = { armed: true, completed: true, declined: true, planned: true, running: true };
const causeCodes = {
  active_process: false,
  bad_args: true,
  busy_tabs: true,
  caller_waiting: false,
  config_invalid: true,
  dirty_worktree: true,
  docker_missing: true,
  gh_failed: true,
  git_failed: true,
  inspection_failed: true,
  interrupted: false,
  not_a_repo: true,
  not_cloned: true,
  not_managed: true,
  not_merged: false,
  omp_failed: true,
  path_conflict: true,
  path_identity_changed: false,
  registration_changed: false,
  retained: false,
  service_failed: true,
  setup_failed: true,
  teardown_failed: true,
  tern_failed: true,
  worker_start_failed: true,
  worktree_config_invalid: true,
  worktree_exists_elsewhere: true,
} satisfies Record<FinishCauseCode, boolean>;

const isCauseCode = (value: unknown): value is FinishCauseCode => isString(value) && Object.hasOwn(causeCodes, value);

const privatelyOwned = (stat: Stats): boolean => {
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    return false;
  }
  return stat.mode % 0o100 === 0;
};

const privateDirectory = (dir: string): void => {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privatelyOwned(stat)) {
    throw new CliError('bad_args', 'Finish storage must be a private directory owned by the current user');
  }
};

/** Resolves only plan IDs in private plugin storage. */
export const finishDirectory = (id?: string): string => {
  if (id !== undefined && !validId.test(id)) {
    throw new CliError('bad_args', 'Invalid finish plan id');
  }
  const base = path.join(pluginData(), 'finish');
  privateDirectory(base);
  if (id === undefined) {
    return realpathSync(base);
  }
  const dir = path.join(realpathSync(base), id);
  if (existsSync(dir)) {
    privateDirectory(dir);
  }
  return dir;
};

const isKept = (value: RawFinishKept): value is FinishKept => {
  if (!isJsonObject(value) || !isString(value.path) || !path.isAbsolute(value.path)) {
    return false;
  }
  if (!Object.keys(value).every(key => key === 'path' || key === 'code' || key === 'detail')) {
    return false;
  }
  if (!isCauseCode(value.code)) {
    return false;
  }
  return value.detail === undefined || (causeCodes[value.code] && isString(value.detail));
};

const isCandidate = (value: RawFinishCandidate): value is FinishCandidate => {
  if (!isJsonObject(value) || !isString(value.path) || !path.isAbsolute(value.path)) {
    return false;
  }
  if (!isString(value.branch) || value.branch === '' || !isString(value.head)) {
    return false;
  }
  if (!/^[a-f\d]{40,64}$/u.test(value.head) || value.pr === undefined || !isFinishPullRequest(value.pr)) {
    return false;
  }
  return value.pr.headRefOid === value.head;
};

const isIdentity = (value: RawProcessIdentity): value is ProcessIdentity => {
  if (!isJsonObject(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    return false;
  }
  if (!Number.isSafeInteger(value.parent) || !Number.isSafeInteger(value.group)) {
    return false;
  }
  if (!isString(value.start) || value.start === '' || !isString(value.cwd)) {
    return false;
  }
  return path.isAbsolute(value.cwd) && isString(value.command);
};

const validTargets = (state: RawStoredFinish): state is ValidFinishTargets => {
  if (!Array.isArray(state.candidates) || !state.candidates.every(isCandidate)) {
    return false;
  }
  if (!Array.isArray(state.selected) || !state.selected.every(isString)) {
    return false;
  }
  if (!Array.isArray(state.owned) || !state.owned.every(isString)) {
    return false;
  }
  if (!Array.isArray(state.excluded) || !state.excluded.every(isString)) {
    return false;
  }
  const { candidates, excluded, selected } = state;
  return (
    selected.every(target => candidates.some(candidate => candidate.path === target)) &&
    new Set(selected).size === selected.length &&
    !candidates.some(candidate => excluded.includes(candidate.path))
  );
};

const validCaller = (caller: RawFinishCaller): boolean => {
  if (!isJsonObject(caller)) {
    return false;
  }
  if (caller.pid !== null && (!Number.isSafeInteger(caller.pid) || Number(caller.pid) <= 0)) {
    return false;
  }
  if (caller.identity === undefined || (caller.identity !== null && !isIdentity(caller.identity))) {
    return false;
  }
  if (caller.identity !== null && caller.identity.pid !== caller.pid) {
    return false;
  }
  if (caller.block !== null && (!Number.isSafeInteger(caller.block) || Number(caller.block) <= 0)) {
    return false;
  }
  return caller.session === null || isString(caller.session);
};

const validRemoved = (value: RawFinishRemoved, selected: string[]): boolean => {
  if (!isJsonObject(value) || !isString(value.path) || !selected.includes(value.path)) {
    return false;
  }
  if (value.branchDeleted !== true && value.branchDeleted !== false) {
    return false;
  }
  return Array.isArray(value.closedBlocks) && value.closedBlocks.every(Number.isSafeInteger);
};

const validResults = (state: RawStoredFinish): boolean => {
  if (!Array.isArray(state.keep) || !state.keep.every(isKept)) {
    return false;
  }
  if (!Array.isArray(state.errors) || !state.errors.every(isKept)) {
    return false;
  }
  if (!Array.isArray(state.warnings) || !state.warnings.every(isString) || !Array.isArray(state.removed)) {
    return false;
  }
  const { selected } = state;
  return selected !== undefined && state.removed.every(item => validRemoved(item, selected));
};

const validPathIdentities = (state: ValidFinishTargets & ValidFinishMetadata): boolean => {
  const { candidates, identities } = state;
  if (!isJsonObject(identities)) {
    return false;
  }
  return [state.repo, ...candidates.map(candidate => candidate.path)].every(target => {
    const identity = identities[target];
    if (!isJsonObject(identity)) {
      return false;
    }
    return Number.isFinite(identity.dev) && Number.isFinite(identity.ino);
  });
};

const validStateMetadata = (state: RawStoredFinish, id: string): state is ValidFinishMetadata => {
  if (state.version !== 2 || state.id !== id || !isString(state.repo) || !path.isAbsolute(state.repo)) {
    return false;
  }
  if (!(state.current === null || isString(state.current)) || !isString(state.status) || !Object.hasOwn(states, state.status)) {
    return false;
  }
  if (state.ready !== true && state.ready !== false) {
    return false;
  }
  if (state.notified !== true && state.notified !== false) {
    return false;
  }
  return true;
};

const validState = (state: RawStoredFinish, id: string): boolean => {
  if (!validStateMetadata(state, id)) {
    return false;
  }
  if (!validTargets(state) || state.caller === undefined || !validCaller(state.caller)) {
    return false;
  }
  if (!validResults(state) || !validPathIdentities(state)) {
    return false;
  }
  return state.inFlight === null || (isString(state.inFlight) && state.selected !== undefined && state.selected.includes(state.inFlight));
};

/** Validates saved JSON before a plan file can authorize paths. */
export const readFinish = (id: string): StoredFinish => {
  const file = path.join(finishDirectory(id), 'state.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !privatelyOwned(stat)) {
    throw new CliError('bad_args', 'Finish state must be a private regular file');
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf-8'));
  if (!isJsonObject(value)) {
    throw new CliError('bad_args', 'Invalid finish state');
  }
  // SAFETY: JSON objects expose optional raw fields. Validation below covers all fields that can authorize teardown.
  const raw = value as RawStoredFinish;
  if (!validState(raw, id)) {
    throw new CliError('bad_args', 'Invalid finish state');
  }
  // SAFETY: validation covers all stored fields and each path that can authorize teardown.
  return raw as StoredFinish;
};

/** Atomically checkpoints the result before the next external effect. */
export const writeFinish = (state: StoredFinish): void => {
  const dir = finishDirectory(state.id);
  privateDirectory(dir);
  const pending = path.join(dir, `state-${process.pid}.tmp`);
  writeFileSync(pending, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(pending, path.join(dir, 'state.json'));
};

/** Serializes approval and execution. A crashed executor keeps its lock for explicit inspection. */
export const lockFinish = (id: string): (() => void) | null => {
  const lock = path.join(finishDirectory(id), 'executor.lock');
  try {
    const fd = openSync(lock, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return () => {
      unlinkSync(lock);
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return null;
    }
    throw error;
  }
};

/** Lists only durable results that the Tern notification action has not shown. */
export const finishNoticeIds = (): FinishNotices => {
  const result: FinishNotices = { completed: [], pending: [] };
  for (const id of readdirSync(finishDirectory()).filter(name => validId.test(name))) {
    try {
      const state = readFinish(id);
      if (state.status === 'armed' || state.status === 'running') {
        result.pending.push(id);
      } else if (state.status === 'completed' && !state.notified) {
        result.completed.push(id);
      }
    } catch {
      // An invalid plan cannot become a notification or an execution target.
    }
  }
  return result;
};

/** Acknowledges a result shown to the user. Does not retry teardown. */
export const acknowledgeFinish = (id: string): FinishAcknowledgement => {
  const release = lockFinish(id);
  if (release === null) {
    return { acknowledged: false, id };
  }
  try {
    const state = readFinish(id);
    if (state.status !== 'completed') {
      return { acknowledged: false, id };
    }
    state.notified = true;
    writeFinish(state);
    return { acknowledged: true, id };
  } finally {
    release();
  }
};
