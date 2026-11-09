import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import timers from 'node:timers/promises';
import { run as remove } from './commands/remove.ts';
import { finishActivity, callerStillRunning } from './finish-processes.ts';
import { mergedProof } from './finish-proof.ts';
import { finishDirectory, lockFinish, readFinish, writeFinish } from './finish-store.ts';
import type { StoredFinish } from './finish-store.ts';
import type { FinishArmed, FinishCandidate, FinishChoice, FinishKept, FinishState } from './finish-types.ts';
import { requireCheckoutAt, worktrees } from './git.ts';
import { readOrigin } from './github.ts';
import { worktreeOwner, worktreeRoot } from './paths.ts';
import { CliError } from './proc.ts';
import { nameWithOwner } from './repo-ref.ts';
import { guardWorkToLose } from './work-to-lose.ts';

const WAIT_FOR_CALLER_MS = 30_000;
const WAIT_FOR_START_MS = 5000;
const STARTED_FILE = 'worker.started';

/** Returns durable state without exposing storage-only identity fields. */
export const finishStatus = (id: string): FinishState => {
  const { repo, current, ready, candidates, keep, warnings, status, selected, removed, errors } = readFinish(id);
  return { candidates, current, errors, id, keep, ready, removed, repo, selected, status, warnings };
};

const armedResult = (state: StoredFinish): FinishArmed => {
  if (state.status !== 'declined' && !existsSync(path.join(finishDirectory(state.id), STARTED_FILE))) {
    throw new CliError('bad_args', 'Finish worker startup has not been acknowledged; the caller must stay open');
  }
  return { id: state.id, selected: state.selected, status: state.status === 'declined' ? 'declined' : 'armed' };
};

const startWorker = async (id: string): Promise<void> => {
  const directory = finishDirectory(id);
  let log: number | undefined;
  let detail: string | undefined;
  try {
    log = openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    const launcher = path.resolve(import.meta.dirname, '..', 'bin', 'tern-wt');
    const child = spawn(launcher, ['finish', 'execute', id], { cwd: directory, detached: true, stdio: ['ignore', log, log] });
    let startupError: Error | null = null;
    child.once('error', error => {
      startupError = error;
    });
    child.unref();
    const deadline = Date.now() + WAIT_FOR_START_MS;
    const waitUntilStarted = async (): Promise<boolean> => {
      if (existsSync(path.join(directory, STARTED_FILE))) {
        return true;
      }
      if (startupError !== null) {
        throw startupError;
      }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        return false;
      }
      await timers.setTimeout(20);
      return await waitUntilStarted();
    };
    if (await waitUntilStarted()) {
      return;
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    if (log !== undefined) {
      closeSync(log);
    }
  }
  const failed = readFinish(id);
  const cause: FinishKept = { code: 'worker_start_failed', path: failed.repo };
  if (detail !== undefined) {
    cause.detail = detail;
  }
  failed.errors.push(cause);
  failed.status = 'completed';
  writeFinish(failed);
  throw new CliError('git_failed', 'Cannot start finish worker; the worktree and caller must stay open');
};

const checkedSelection = (state: StoredFinish, choice: FinishChoice, approved: string[]): string[] => {
  const selected =
    choice === 'none'
      ? []
      : state.candidates.filter(candidate => choice === 'merged' || candidate.path === state.current || state.owned.includes(candidate.path)).map(candidate => candidate.path);
  if (approved.length !== selected.length || new Set(approved).size !== approved.length || !selected.every(target => approved.includes(target))) {
    throw new CliError('bad_args', 'Finish selection does not match the approved worktree paths');
  }
  return selected;
};

/** Records the immutable target list before launching an independent worker. */
export const armFinish = async (id: string, choice: FinishChoice, approved: string[]): Promise<FinishArmed> => {
  const state = readFinish(id);
  checkedSelection(state, choice, approved);
  const release = lockFinish(id);
  if (release === null) {
    if (state.status === 'planned') {
      throw new CliError('bad_args', 'Finish plan is locked');
    }
    return armedResult(state);
  }
  let locked = true;
  try {
    const current = readFinish(id);
    const selected = checkedSelection(current, choice, approved);
    if (current.status !== 'planned') {
      return armedResult(current);
    }
    if (choice === 'none') {
      current.status = 'declined';
      writeFinish(current);
      return { id, selected: [], status: 'declined' };
    }
    if (!current.ready) {
      throw new CliError('bad_args', 'Finish plan is not ready');
    }
    current.selected = selected;
    current.status = 'armed';
    writeFinish(current);
    await startWorker(id);
    release();
    locked = false;
    return { id, selected: current.selected, status: 'armed' };
  } finally {
    if (locked) {
      release();
    }
  }
};

const validatePath = (state: StoredFinish, directory: string): FinishKept['code'] | null => {
  const stat = lstatSync(directory);
  const saved = state.identities[directory];
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
    return 'path_identity_changed';
  }
  if (stat.dev !== saved.dev || stat.ino !== saved.ino) {
    return 'path_identity_changed';
  }
  return null;
};

const validateRegistration = async (state: StoredFinish, candidate: FinishCandidate): Promise<FinishKept['code'] | null> => {
  const target = candidate.path;
  const checkout = await requireCheckoutAt(target);
  const root = await worktreeRoot();
  const entries = await worktrees(state.repo);
  const entry = entries.find(item => item.path === target);
  if (checkout.role !== 'linked' || checkout.main !== state.repo || worktreeOwner(root, state.repo, target) !== 'tern') {
    return 'registration_changed';
  }
  if (entry === undefined || entry.main || entry.locked !== null || entry.prunable) {
    return 'registration_changed';
  }
  if (entry.head !== candidate.head || entry.branch !== candidate.branch) {
    return 'registration_changed';
  }
  return null;
};

const validateProof = async (repo: string, candidate: FinishCandidate): Promise<FinishKept['code'] | null> => {
  const origin = await readOrigin(repo);
  const proof = origin.github === null ? null : await mergedProof(nameWithOwner(origin.github), candidate.branch, candidate.head);
  if (proof === null || proof.number !== candidate.pr.number || proof.url !== candidate.pr.url) {
    return 'not_merged';
  }
  if (proof.mergeCommit !== candidate.pr.mergeCommit || proof.mergedAt !== candidate.pr.mergedAt) {
    return 'not_merged';
  }
  return null;
};

const validateTarget = async (state: StoredFinish, candidate: FinishCandidate): Promise<FinishKept | null> => {
  const target = candidate.path;
  try {
    for (const directory of [state.repo, target]) {
      const code = validatePath(state, directory);
      if (code !== null) {
        return { code, path: target };
      }
    }
    const registration = await validateRegistration(state, candidate);
    if (registration !== null) {
      return { code: registration, path: target };
    }
    await guardWorkToLose(target, { removing: state.repo }, state.repo);
    const proof = await validateProof(state.repo, candidate);
    if (proof !== null) {
      return { code: proof, path: target };
    }
    const activity = await finishActivity(state, target, false);
    if (activity.code === null) {
      return null;
    }
    const cause: FinishKept = { code: activity.code, path: target };
    if (activity.code === 'inspection_failed') {
      cause.detail = activity.reason;
    }
    return cause;
  } catch (error) {
    return { code: error instanceof CliError ? error.code : 'inspection_failed', detail: error instanceof Error ? error.message : String(error), path: target };
  }
};

const waitForCaller = async (state: StoredFinish, deadline = Date.now() + WAIT_FOR_CALLER_MS): Promise<FinishKept | null> => {
  let caller: 'waiting' | 'unproven' | null;
  try {
    caller = await callerStillRunning(state);
  } catch (error) {
    return { code: 'inspection_failed', detail: error instanceof Error ? error.message : String(error), path: state.repo };
  }
  if (caller !== 'waiting' || Date.now() >= deadline) {
    return caller === null ? null : { code: 'caller_waiting', path: state.repo };
  }
  await timers.setTimeout(100);
  return await waitForCaller(state, deadline);
};

const executeTarget = async (state: StoredFinish, candidate: FinishCandidate, waiting: FinishKept | null): Promise<void> => {
  const target = candidate.path;
  if (state.removed.some(item => item.path === target) || state.keep.some(item => item.path === target) || state.errors.some(item => item.path === target)) {
    return;
  }
  if (waiting !== null) {
    state.keep.push({ ...waiting, path: target });
    writeFinish(state);
    return;
  }
  if (state.inFlight === target) {
    state.keep.push({ code: 'interrupted', path: target });
    state.inFlight = null;
    writeFinish(state);
    return;
  }
  const cause = await validateTarget(state, candidate);
  if (cause !== null) {
    state.keep.push(cause);
    writeFinish(state);
    return;
  }
  state.inFlight = target;
  writeFinish(state);
  try {
    const result = await remove([target]);
    state.removed.push({ branchDeleted: result.branchDeleted, closedBlocks: result.closedBlocks, path: target });
    state.warnings.push(...result.warnings);
  } catch (error) {
    state.errors.push({ code: error instanceof CliError ? error.code : 'teardown_failed', detail: error instanceof Error ? error.message : String(error), path: target });
  }
  state.inFlight = null;
  writeFinish(state);
};

const acquireExecutor = async (id: string, deadline: number): Promise<(() => void) | null> => {
  const release = lockFinish(id);
  if (release !== null || readFinish(id).status !== 'armed' || Date.now() >= deadline) {
    return release;
  }
  await timers.setTimeout(20);
  return await acquireExecutor(id, deadline);
};

const executeSelected = async (state: StoredFinish, waiting: FinishKept | null, index = 0): Promise<void> => {
  const candidate = state.candidates[index];
  if (candidate === undefined) {
    return;
  }
  if (state.selected.includes(candidate.path)) {
    await executeTarget(state, candidate, waiting);
  }
  await executeSelected(state, waiting, index + 1);
};

/** Executes saved approval and keeps each uncertain or changed target. */
export const executeFinish = async (id: string): Promise<FinishState> => {
  const initial = readFinish(id);
  if (initial.status !== 'armed' && initial.status !== 'running') {
    return finishStatus(id);
  }
  writeFileSync(path.join(finishDirectory(id), STARTED_FILE), `${process.pid}\n`, { flag: 'w', mode: 0o600 });
  const release = await acquireExecutor(id, Date.now() + WAIT_FOR_START_MS);
  if (release === null) {
    return finishStatus(id);
  }
  try {
    const state = readFinish(id);
    if (state.status !== 'armed' && state.status !== 'running') {
      return finishStatus(id);
    }
    state.status = 'running';
    writeFinish(state);
    const waiting = await waitForCaller(state);
    await executeSelected(state, waiting);
    state.status = 'completed';
    writeFinish(state);
    return finishStatus(id);
  } finally {
    release();
  }
};
