import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs, { existsSync, fstatSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { TimerOptions } from 'node:timers';
import timers from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { armFinish } from '../src/finish-execute.ts';
import { finishDirectory, lockFinish, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { git, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';

const planned = async () => {
  const repo = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(repo.dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  const mainStat = lstatSync(repo.dir);
  const targetStat = lstatSync(target);
  const state: StoredFinish = {
    caller: { block: null, identity: null, pid: null, session: null },
    candidates: [
      {
        branch: 'delivered',
        head,
        path: target,
        pr: { headRefOid: head, mergeCommit: head, mergedAt: '2026-11-01T10:00:00Z', number: 7, url: 'https://github.com/virtusize/aoyama/pull/7' },
      },
    ],
    current: null,
    errors: [],
    excluded: [],
    id: randomBytes(24).toString('hex'),
    identities: { [repo.dir]: { dev: mainStat.dev, ino: mainStat.ino }, [target]: { dev: targetStat.dev, ino: targetStat.ino } },
    inFlight: null,
    keep: [],
    notified: false,
    owned: [target],
    ready: true,
    removed: [],
    repo: repo.dir,
    selected: [],
    status: 'planned',
    version: 2,
    warnings: [],
  };
  writeFinish(state);
  return { repo, state, target };
};

const launcher = (script: string): void => {
  const bin = tempDir('finish-arm-launcher');
  writeFileSync(path.join(bin, 'bun'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
};

const expectNoTeardown = (target: string, log: string): void => {
  expect(existsSync(target)).toBeTruthy();
  expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
  expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
};

const childClosed = async (child: childProcess.ChildProcess): Promise<void> => {
  try {
    await once(child, 'close');
  } catch {
    // An OS spawn error also closes the child handle.
  }
};

const stopWorker = async (worker: childProcess.ChildProcess | undefined): Promise<void> => {
  if (worker === undefined || worker.exitCode !== null || worker.signalCode !== null) {
    return;
  }
  const closed = childClosed(worker);
  worker.kill('SIGKILL');
  await closed;
};

const descriptorClosed = (descriptor: number | undefined): boolean => {
  if (descriptor === undefined) {
    return false;
  }
  try {
    fstatSync(descriptor);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EBADF';
  }
};

const startupResult = async (id: string, target: string): Promise<{ acknowledged: boolean; code: unknown }> => {
  try {
    await armFinish(id, 'current', [target]);
    return { acknowledged: true, code: null };
  } catch (error) {
    return { acknowledged: false, code: error instanceof Error && 'code' in error ? error.code : error };
  }
};

const startupOutcomes = [
  {
    expected: { acknowledged: true, code: null, independentGroup: true, output: 'out\nerr\n' },
    outcome: 'acknowledged',
    script: 'printf "out\\n"; printf "err\\n" >&2; printf "%s\\n" "$$" > worker.started; exec sleep 60',
  },
  { expected: { acknowledged: false, code: 'git_failed', independentGroup: null, output: '' }, outcome: 'exit', script: 'exit 0' },
  { expected: { acknowledged: false, code: 'git_failed', independentGroup: null, output: '' }, outcome: 'signal', script: 'kill -TERM "$$"' },
];

describe('finish immutable approval', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test('does not arm a plan whose delivery is not ready', async () => {
    const { state, target } = await planned();
    state.ready = false;
    writeFinish(state);
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'current', [target])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
    expect(readFinish(state.id)).toStrictEqual(state);
    expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test.each(['missing', 'unexpected', 'duplicate'] as const)('does not persist approval for %s selected paths', async kind => {
    const { state, target } = await planned();
    const selections = { duplicate: [target, target], missing: [], unexpected: [target, state.repo] };
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'current', selections[kind])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
    expect(readFinish(state.id)).toStrictEqual(state);
    expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test('rejects duplicate approvals even when the saved candidates contain duplicate paths', async () => {
    const { state, target } = await planned();
    const [candidate] = state.candidates;
    if (candidate === undefined) {
      throw new Error('Fixture has no delivered candidate');
    }
    state.candidates.push({ ...candidate });
    writeFinish(state);
    expect(readFinish(state.id)).toStrictEqual(state);
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'current', [target, target])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
    expect(readFinish(state.id)).toStrictEqual(state);
    expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test('cannot record approval while a planned state is locked', async () => {
    const { state, target } = await planned();
    const release = lockFinish(state.id);
    if (release === null) {
      throw new Error('Fixture could not acquire executor lock');
    }
    const log = await logGitCalls();
    try {
      await expect(armFinish(state.id, 'current', [target])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
      expect(readFinish(state.id)).toStrictEqual(state);
      expectNoTeardown(target, log);
    } finally {
      release();
    }
  });

  test.each([false, true])('does not acknowledge repeated approval before worker startup: locked=%s', async locked => {
    const { state, target } = await planned();
    state.status = 'armed';
    state.selected = [target];
    writeFinish(state);
    const release = locked ? lockFinish(state.id) : null;
    const log = await logGitCalls();
    try {
      await expect(armFinish(state.id, 'current', [target])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
      expect(readFinish(state.id)).toStrictEqual(state);
      expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
      expectNoTeardown(target, log);
    } finally {
      release?.();
    }
  });

  test.each([false, true])('returns the saved acknowledgement without relaunching a worker: locked=%s', async locked => {
    const { state, target } = await planned();
    state.status = 'armed';
    state.selected = [target];
    writeFinish(state);
    writeFileSync(path.join(finishDirectory(state.id), 'worker.started'), '123\n', { mode: 0o600 });
    const release = locked ? lockFinish(state.id) : null;
    const log = await logGitCalls();
    try {
      await expect(armFinish(state.id, 'current', [target])).resolves.toStrictEqual({ id: state.id, selected: [target], status: 'armed' });
      expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
      expectNoTeardown(target, log);
    } finally {
      release?.();
    }
  });

  test.each(['missing', 'different'] as const)('rejects %s repeat approval while an acknowledged plan is locked', async kind => {
    const { state, target } = await planned();
    state.status = 'armed';
    state.selected = [target];
    writeFinish(state);
    writeFileSync(path.join(finishDirectory(state.id), 'worker.started'), '123\n', { mode: 0o600 });
    const release = lockFinish(state.id);
    if (release === null) {
      throw new Error('Fixture could not acquire executor lock');
    }
    const log = await logGitCalls();
    try {
      await expect(armFinish(state.id, 'current', kind === 'missing' ? [] : [state.repo])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
      expect(readFinish(state.id)).toStrictEqual(state);
      expect(existsSync(path.join(finishDirectory(state.id), 'executor.lock'))).toBeTruthy();
      expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
      expectNoTeardown(target, log);
    } finally {
      release();
    }
  });

  test.each(['current', 'merged'] as const)('rechecks %s approval against a plan changed while acquiring its lock', async choice => {
    const { state, target } = await planned();
    const other = managedPath('other-delivered');
    await git(state.repo, 'worktree', 'add', '-b', 'other-delivered', other);
    const stat = lstatSync(other);
    const output = await git(other, 'rev-parse', 'HEAD');
    const head = output.trim();
    launcher('printf "%s\\n" "$$" > worker.started');
    let injected = false;
    const originalOpen = fs.openSync;
    const lock = path.join(finishDirectory(state.id), 'executor.lock');
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = originalOpen(file, flags, mode);
      if (file === lock) {
        injected = true;
        if (choice === 'current') {
          state.owned = [];
        } else {
          state.candidates.push({
            branch: 'other-delivered',
            head,
            path: other,
            pr: { headRefOid: head, mergeCommit: head, mergedAt: '2026-11-01T10:00:00Z', number: 8, url: 'https://github.com/virtusize/aoyama/pull/8' },
          });
          state.identities[other] = { dev: stat.dev, ino: stat.ino };
        }
        writeFinish(state);
      }
      return fd;
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    await expect(armFinish(state.id, choice, [target])).rejects.toThrow('does not match');
    expect({
      injected,
      locked: existsSync(lock),
      otherExists: existsSync(other),
      state: readFinish(state.id),
      workerLogged: existsSync(path.join(finishDirectory(state.id), 'worker.log')),
      workerStarted: existsSync(path.join(finishDirectory(state.id), 'worker.started')),
    }).toStrictEqual({ injected: true, locked: false, otherExists: true, state, workerLogged: false, workerStarted: false });
    expectNoTeardown(target, log);
  });

  test('records a durable refusal without starting a worker', async () => {
    const { state, target } = await planned();
    const log = await logGitCalls();
    const declined = { id: state.id, selected: [], status: 'declined' };
    await expect(run(['arm', state.id, '--choice', 'none'])).resolves.toStrictEqual(declined);
    await expect(armFinish(state.id, 'none', [])).resolves.toStrictEqual(declined);
    expect(readFinish(state.id).status).toBe('declined');
    expect(existsSync(path.join(finishDirectory(state.id), 'worker.log'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test('rejects selected paths for a refusal before changing the plan', async () => {
    const { state, target } = await planned();
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'none', [target])).rejects.toThrow('does not match');
    expect(readFinish(state.id)).toStrictEqual(state);
    expectNoTeardown(target, log);
  });
});

describe('finish worker bootstrap', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test('acknowledges only after the detached launcher records startup', async () => {
    const { state, target } = await planned();
    launcher('printf "%s\\n" "$$" > worker.started');
    const log = await logGitCalls();
    await expect(run(['arm', state.id, '--choice', 'current', '--selected', target])).resolves.toStrictEqual({ id: state.id, selected: [target], status: 'armed' });
    expect(readFinish(state.id)).toMatchObject({ selected: [target], status: 'armed' });
    expect(existsSync(path.join(finishDirectory(state.id), 'worker.started'))).toBeTruthy();
    expect(existsSync(path.join(finishDirectory(state.id), 'executor.lock'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test.each(['current', 'merged'] as const)('arms exactly the %s preview when other merged candidates exist', async choice => {
    const { state, target } = await planned();
    const other = managedPath('other-delivered');
    await git(state.repo, 'worktree', 'add', '-b', 'other-delivered', other);
    const stat = lstatSync(other);
    const output = await git(other, 'rev-parse', 'HEAD');
    const head = output.trim();
    state.candidates.push({
      branch: 'other-delivered',
      head,
      path: other,
      pr: { headRefOid: head, mergeCommit: head, mergedAt: '2026-11-01T10:00:00Z', number: 8, url: 'https://github.com/virtusize/aoyama/pull/8' },
    });
    state.identities[other] = { dev: stat.dev, ino: stat.ino };
    writeFinish(state);
    launcher('printf "%s\\n" "$$" > worker.started');
    const log = await logGitCalls();
    const selected = choice === 'current' ? [target] : [target, other];
    const supplied = choice === 'current' ? [target] : [other, target];
    await expect(armFinish(state.id, choice, supplied)).resolves.toStrictEqual({ id: state.id, selected, status: 'armed' });
    expect(readFinish(state.id)).toMatchObject({ selected, status: 'armed' });
    expectNoTeardown(target, log);
    expect(existsSync(other)).toBeTruthy();
  });

  test('records a failed startup when the launcher exits without acknowledgement', async () => {
    const { state, target } = await planned();
    launcher('exit 0');
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'merged', [target])).rejects.toMatchObject({ code: 'git_failed', name: 'CliError' });
    const failed = readFinish(state.id);
    expect(failed).toMatchObject({ selected: [target], status: 'completed' });
    expect(failed.errors.map(error => ({ code: error.code, path: error.path }))).toStrictEqual([{ code: 'worker_start_failed', path: state.repo }]);
    expect(existsSync(path.join(finishDirectory(state.id), 'executor.lock'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test('records a log-open failure without starting teardown', async () => {
    const { state, target } = await planned();
    mkdirSync(path.join(finishDirectory(state.id), 'worker.log'));
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'merged', [target])).rejects.toMatchObject({ code: 'git_failed', name: 'CliError' });
    const failed = readFinish(state.id);
    expect(failed).toMatchObject({ selected: [target], status: 'completed' });
    expect(failed.errors.map(error => ({ code: error.code, path: error.path }))).toStrictEqual([{ code: 'worker_start_failed', path: state.repo }]);
    expect(existsSync(path.join(finishDirectory(state.id), 'worker.started'))).toBeFalsy();
    expect(existsSync(path.join(finishDirectory(state.id), 'executor.lock'))).toBeFalsy();
    expectNoTeardown(target, log);
  });

  test('records an operating-system spawn failure without acknowledging startup or teardown', async () => {
    const { state, target } = await planned();
    const log = await logGitCalls();
    const missingLauncher = path.join(tempDir('finish-missing-launcher'), 'tern-wt');
    const originalTimeout = timers.setTimeout;
    let worker: childProcess.ChildProcess | undefined;
    let failedToSpawn = false;
    const originalSpawn = childProcess.spawn;
    let requestedLauncher: string | null = null;
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      requestedLauncher = command;
      worker = originalSpawn(missingLauncher, args, options);
      worker.once('error', () => {
        failedToSpawn = true;
      });
      return worker;
    });
    vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.spyOn(timers, 'setTimeout').mockImplementation(async <T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> => {
      if (failedToSpawn) {
        writeFileSync(path.join(finishDirectory(state.id), 'worker.started'), 'late acknowledgement\n', { mode: 0o600 });
      }
      return await originalTimeout(delay, value, options);
    });
    syncBuiltinESMExports();
    await expect(armFinish(state.id, 'current', [target])).rejects.toMatchObject({ code: 'git_failed', name: 'CliError' });
    const failed = readFinish(state.id);
    expect({
      errors: failed.errors.map(error => ({
        missingExecutable: error.detail?.includes('ENOENT'),
        path: error.path,
        startupFailure: error.code === 'worker_start_failed',
      })),
      keep: failed.keep,
      locked: existsSync(path.join(finishDirectory(state.id), 'executor.lock')),
      removed: failed.removed,
      requestedLauncher,
      selected: failed.selected,
      status: failed.status,
      workerStarted: existsSync(path.join(finishDirectory(state.id), 'worker.started')),
    }).toStrictEqual({
      errors: [{ missingExecutable: true, path: state.repo, startupFailure: true }],
      keep: [],
      locked: false,
      removed: [],
      requestedLauncher: path.resolve(import.meta.dirname, '..', 'bin', 'tern-wt'),
      selected: [target],
      status: 'completed',
      workerStarted: false,
    });
    expectNoTeardown(target, log);
  });

  test.each(startupOutcomes)('closes its private worker log after $outcome startup in an independent process group', async ({ outcome, script, expected }) => {
    const { state, target } = await planned();
    launcher(script);
    const log = await logGitCalls();
    const originalOpen = fs.openSync;
    const originalSpawn = childProcess.spawn;
    const originalTimeout = timers.setTimeout;
    let descriptor: number | undefined;
    let worker: childProcess.ChildProcess | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = originalOpen(file, flags, mode);
      if (file === path.join(finishDirectory(state.id), 'worker.log')) {
        descriptor = fd;
      }
      return fd;
    });
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      worker = originalSpawn(command, args, options);
      return worker;
    });
    if (outcome !== 'acknowledged') {
      vi.spyOn(Date, 'now').mockReturnValue(0);
      vi.spyOn(timers, 'setTimeout').mockImplementation(async <T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> => {
        if (worker !== undefined && (worker.exitCode !== null || worker.signalCode !== null)) {
          writeFileSync(path.join(finishDirectory(state.id), 'worker.started'), 'late acknowledgement\n', { mode: 0o600 });
        }
        return await originalTimeout(delay, value, options);
      });
    }
    syncBuiltinESMExports();
    try {
      const result = await startupResult(state.id, target);
      const group = outcome === 'acknowledged' ? childProcess.spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(worker?.pid)], { encoding: 'utf-8' }) : null;
      expect({
        ...result,
        closed: descriptorClosed(descriptor),
        independentGroup: group === null ? null : group.status === 0 && Number(group.stdout.trim()) === worker?.pid,
        mode: lstatSync(path.join(finishDirectory(state.id), 'worker.log')).mode % 0o1000,
        output: readFileSync(path.join(finishDirectory(state.id), 'worker.log'), 'utf-8'),
      }).toStrictEqual({ ...expected, closed: true, mode: 0o600 });
      expectNoTeardown(target, log);
    } finally {
      await stopWorker(worker);
    }
  });
});
