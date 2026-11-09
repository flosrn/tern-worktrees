import childProcess from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TimerOptions } from 'node:timers';
import timers from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { armFinish } from '../src/finish-execute.ts';
import type { FinishPlan, FinishState } from '../src/finish-types.ts';
import { finishDirectory, lockFinish, readFinish, writeFinish } from '../src/finish-store.ts';
import { ghFixture, git, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const aliasPlan = async () => {
  const { dir } = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  await useGithubOrigin();
  ghFixture(
    [
      'pr',
      'list',
      '--repo',
      'virtusize/aoyama',
      '--head',
      'delivered',
      '--state',
      'merged',
      '--limit',
      '100',
      '--json',
      'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
    ],
    JSON.stringify([
      {
        headRefName: 'delivered',
        headRefOid: head,
        isCrossRepository: false,
        mergeCommit: { oid: head },
        mergedAt: '2026-11-01T10:00:00Z',
        number: 7,
        state: 'MERGED',
        url: 'https://github.com/virtusize/aoyama/pull/7',
      },
    ]),
  );
  ghFixture(['api', `repos/virtusize/aoyama/git/trees/${head}?recursive=1`], JSON.stringify({ sha: head, tree: [], truncated: false }));
  const alias = path.join(tempDir('finish-alias'), 'owned');
  symlinkSync(target, alias);
  // SAFETY: the plan command returns the public FinishPlan contract.
  const plan = (await run(['plan', '--repo', dir, '--current', dir, '--owned', alias])) as FinishPlan;
  return { alias, plan, target };
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

const stopRecordedWorker = (marker: string): void => {
  if (!existsSync(marker)) {
    return;
  }
  const pid = Number(readFileSync(marker, 'utf-8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

describe('finish approved selection', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['absent', 'alias', 'extra', 'duplicate'] as const)('rejects %s selection before worker startup or teardown', async supplied => {
    const { alias, plan, target } = await aliasPlan();
    const paths = { absent: [], alias: [alias], duplicate: [target, target], extra: [target, alias] };
    const selected = paths[supplied].flatMap(value => ['--selected', value]);
    const log = await logGitCalls();
    await expect(run(['arm', plan.id, '--choice', 'current', ...selected])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      status: readFinish(plan.id).status,
      targetExists: existsSync(target),
      workerLogged: existsSync(path.join(finishDirectory(plan.id), 'worker.log')),
      workerStarted: existsSync(path.join(finishDirectory(plan.id), 'worker.started')),
    }).toStrictEqual({ closes: [], removals: [], status: 'planned', targetExists: true, workerLogged: false, workerStarted: false });
  });

  it('accepts the canonical selected path shown by the saved plan', async () => {
    const { plan, target } = await aliasPlan();
    expect(plan.candidates.map(candidate => candidate.path)).toStrictEqual([target]);
    const bin = tempDir('finish-selected-launcher');
    writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$$" > worker.started\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const result = await run(['arm', plan.id, '--choice', 'current', '--selected', target]);
    expect(result).toStrictEqual({ id: plan.id, selected: [target], status: 'armed' });
    expect(readFinish(plan.id)).toMatchObject({ selected: [target], status: 'armed' });
  });

  it.each(['armed', 'running'] as const)('does not wait or execute a locked %s selection at its stopping boundary', async status => {
    const { plan, target } = await aliasPlan();
    const state = readFinish(plan.id);
    state.selected = [target];
    state.status = status;
    writeFinish(state);
    const release = lockFinish(plan.id);
    if (release === null) {
      throw new Error('Fixture could not acquire executor lock');
    }
    const log = await logGitCalls();
    const originalTimeout = timers.setTimeout;
    let reads = 0;
    let released = false;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      reads += 1;
      return status === 'running' || reads === 1 ? 0 : 5000;
    });
    vi.spyOn(timers, 'setTimeout').mockImplementation(async <T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> => {
      if (!released) {
        release();
        released = true;
      }
      return await originalTimeout(delay, value, options);
    });
    try {
      await expect(run(['execute', plan.id])).resolves.toMatchObject({ errors: [], removed: [], selected: [target], status });
      const marker = path.join(finishDirectory(plan.id), 'worker.started');
      expect({
        closes: ternLog().filter(line => line.startsWith('close ')),
        locked: existsSync(path.join(finishDirectory(plan.id), 'executor.lock')),
        marker: readFileSync(marker, 'utf-8'),
        mode: lstatSync(marker).mode % 0o1000,
        removals: readLog(log).filter(line => line.includes('worktree remove')),
        state: readFinish(plan.id),
        targetExists: existsSync(target),
      }).toStrictEqual({ closes: [], locked: true, marker: `${process.pid}\n`, mode: 0o600, removals: [], state, targetExists: true });
    } finally {
      if (!released) {
        release();
      }
    }
  });

  it('preserves the selected worktree when its pinned caller is still alive at the exact deadline', async () => {
    const { plan, target } = await aliasPlan();
    const state = readFinish(plan.id);
    const pid = 90_001;
    const directory = path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(pid));
    mkdirSync(directory, { recursive: true });
    symlinkSync(target, path.join(directory, 'cwd'));
    const fields = ['S', '1', String(pid), ...Array.from({ length: 16 }, () => '0'), '100'];
    writeFileSync(path.join(directory, 'stat'), `${pid} (worker) ${fields.join(' ')}`);
    writeFileSync(path.join(directory, 'cmdline'), 'omp');
    const bin = tempDir('finish-selection-ps');
    writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' '${pid} 1 ${pid} omp'\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    state.caller = { block: null, identity: { command: 'omp', cwd: target, group: pid, parent: 1, pid, start: '100' }, pid, session: null };
    state.current = target;
    state.selected = [target];
    state.status = 'armed';
    writeFinish(state);
    writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown: 'worktree' }));
    const log = await logGitCalls();
    const originalTimeout = timers.setTimeout;
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      reads += 1;
      return reads < 3 ? 0 : 30_000;
    });
    vi.spyOn(timers, 'setTimeout').mockImplementation(async <T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> => {
      rmSync(directory, { recursive: true });
      return await originalTimeout(delay, value, options);
    });
    // SAFETY: The public execute action returns the FinishState contract.
    const result = (await run(['execute', plan.id])) as FinishState;
    expect({
      callerExists: existsSync(directory),
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      mainExists: existsSync(plan.repo),
      mainKept: result.keep.some(item => item.path === plan.repo && item.code === 'not_managed'),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      status: result.status,
      targetExists: existsSync(target),
      targetKept: result.keep.some(item => item.path === target && item.code === 'caller_waiting'),
    }).toStrictEqual({
      callerExists: true,
      closes: [],
      errors: [],
      mainExists: true,
      mainKept: true,
      removals: [],
      removed: [],
      status: 'completed',
      targetExists: true,
      targetKept: true,
    });
  });
});

describe('finish worker lifecycle', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test.each([false, true])('the real worker publishes its own PID and private marker before waiting for approval lock: existing=%s', async existing => {
    const { plan, target } = await aliasPlan();
    const state = readFinish(plan.id);
    state.status = 'armed';
    state.selected = [target];
    writeFinish(state);
    const marker = path.join(finishDirectory(state.id), 'worker.started');
    if (existing) {
      writeFileSync(marker, 'obsolete worker acknowledgement that must be replaced\n', { mode: 0o600 });
    }
    const release = lockFinish(state.id);
    if (release === null) {
      throw new Error('Fixture could not acquire executor lock');
    }
    const log = await logGitCalls();
    const worker = childProcess.spawn(
      '/bin/sh',
      ['-c', 'umask 022; exec "$@"', 'finish-worker', path.resolve(import.meta.dirname, '..', 'bin', 'tern-wt'), 'finish', 'execute', state.id],
      { stdio: 'ignore' },
    );
    const exited = childClosed(worker);
    try {
      await expect.poll(() => (existsSync(marker) ? readFileSync(marker, 'utf-8') : null), { timeout: 3000 }).toBe(`${worker.pid}\n`);
      expect(lstatSync(marker).mode % 0o1000).toBe(0o600);
      expect(readFinish(state.id)).toStrictEqual(state);
      expect(existsSync(path.join(finishDirectory(state.id), 'executor.lock'))).toBeTruthy();
      expect({
        closes: ternLog().filter(line => line.startsWith('close ')),
        removals: readLog(log).filter(line => line.includes('worktree remove')),
        targetExists: existsSync(target),
      }).toStrictEqual({ closes: [], removals: [], targetExists: true });
    } finally {
      worker.kill('SIGKILL');
      await exited;
      release();
    }
  });

  test('lets the approving CLI exit while its acknowledged detached worker stays alive', async () => {
    const { plan, target } = await aliasPlan();
    const bun = childProcess.execFileSync('/usr/bin/which', ['bun'], { encoding: 'utf-8' }).trim();
    const bin = tempDir('finish-lifecycle-launcher');
    writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$$" > worker.started; exec sleep 60\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const moduleUrl = new URL('../src/commands/finish.ts', import.meta.url).href;
    const script = `import { run } from ${JSON.stringify(moduleUrl)}; await run(${JSON.stringify(['arm', plan.id, '--choice', 'current', '--selected', target])});`;
    const parent = childProcess.spawn(bun, ['--eval', script], { stdio: 'ignore' });
    const exited = childClosed(parent);
    const marker = path.join(finishDirectory(plan.id), 'worker.started');
    try {
      await expect.poll(() => parent.exitCode, { timeout: 3000 }).toBe(0);
      const workerPid = Number(readFileSync(marker, 'utf-8').trim());
      expect(Number.isSafeInteger(workerPid) && workerPid > 0).toBeTruthy();
      expect(() => process.kill(workerPid, 0)).not.toThrow();
      expect({
        closes: ternLog().filter(line => line.startsWith('close ')),
        selected: readFinish(plan.id).selected,
        status: readFinish(plan.id).status,
        targetExists: existsSync(target),
      }).toStrictEqual({ closes: [], selected: [target], status: 'armed', targetExists: true });
    } finally {
      parent.kill('SIGKILL');
      await exited;
      stopRecordedWorker(marker);
    }
  });

  test('fails closed exactly at the startup deadline while an unacknowledged child is still alive', async () => {
    const { plan, target } = await aliasPlan();
    const state = readFinish(plan.id);
    const bin = tempDir('finish-deadline-launcher');
    writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const log = await logGitCalls();
    const originalSpawn = childProcess.spawn;
    const originalTimeout = timers.setTimeout;
    let worker: childProcess.ChildProcess | undefined;
    let reads = 0;
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      worker = originalSpawn(command, args, options);
      return worker;
    });
    vi.spyOn(Date, 'now').mockImplementation(() => {
      reads += 1;
      return reads === 1 ? 0 : 5000;
    });
    vi.spyOn(timers, 'setTimeout').mockImplementation(async <T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> => {
      const elapsed = await originalTimeout(delay, value, options);
      writeFileSync(path.join(finishDirectory(state.id), 'worker.started'), 'late acknowledgement\n', { mode: 0o600 });
      return elapsed;
    });
    syncBuiltinESMExports();
    try {
      await expect(armFinish(state.id, 'current', [target])).rejects.toMatchObject({ code: 'git_failed', name: 'CliError' });
      expect(readFinish(state.id)).toMatchObject({ removed: [], selected: [target], status: 'completed' });
      expect(existsSync(path.join(finishDirectory(state.id), 'worker.started'))).toBeFalsy();
      expect(existsSync(path.join(finishDirectory(state.id), 'executor.lock'))).toBeFalsy();
      expect({
        closes: ternLog().filter(line => line.startsWith('close ')),
        removals: readLog(log).filter(line => line.includes('worktree remove')),
        targetExists: existsSync(target),
      }).toStrictEqual({ closes: [], removals: [], targetExists: true });
    } finally {
      await stopWorker(worker);
    }
  });
});
