import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { executeFinish, finishStatus } from '../src/finish-execute.ts';
import { finishDirectory, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import {
  FIXTURE_BIN,
  REPO_DIR,
  ghFixture,
  git,
  gitShim,
  ignoreGlobally,
  logGitCalls,
  managedPath,
  readLog,
  tempDir,
  ternLog,
  tmpRepo,
  useGithubOrigin,
  useSandbox,
  writeTernLs,
} from './helpers.ts';

const approval = async () => {
  const { dir } = await tmpRepo('aoyama');
  const targets = [managedPath('delivered'), managedPath('other-delivered')];
  const branches = ['delivered', 'other-delivered'];
  await git(dir, 'worktree', 'add', '-b', branches[0], targets[0]);
  await git(dir, 'worktree', 'add', '-b', branches[1], targets[1]);
  const output = await git(dir, 'rev-parse', 'HEAD');
  const head = output.trim();
  await useGithubOrigin();
  for (const branch of branches) {
    ghFixture(
      [
        'pr',
        'list',
        '--repo',
        'virtusize/aoyama',
        '--head',
        branch,
        '--state',
        'merged',
        '--limit',
        '100',
        '--json',
        'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
      ],
      JSON.stringify([
        {
          headRefName: branch,
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
  }
  writeTernLs({ aoyama: [dir, ...targets] });
  fs.writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown: 'worktree' }));
  const state: StoredFinish = {
    caller: { block: null, identity: null, pid: null, session: null },
    candidates: targets.map((target, index) => ({
      branch: branches[index],
      head,
      path: target,
      pr: { headRefOid: head, mergeCommit: head, mergedAt: '2026-11-01T10:00:00Z', number: 7, url: 'https://github.com/virtusize/aoyama/pull/7' },
    })),
    current: null,
    errors: [],
    excluded: [],
    id: randomBytes(24).toString('hex'),
    identities: Object.fromEntries(
      [dir, ...targets].map(directory => {
        const stat = fs.lstatSync(directory);
        return [directory, { dev: stat.dev, ino: stat.ino }];
      }),
    ),
    inFlight: null,
    keep: [],
    notified: false,
    owned: targets,
    ready: true,
    removed: [],
    repo: dir,
    selected: targets,
    status: 'armed',
    version: 2,
    warnings: [],
  };
  writeFinish(state);
  return { state, targets };
};

// SAFETY: only the valid StoredFinish fixture and its executor write this checkpoint.
const durable = (id: string): StoredFinish => JSON.parse(fs.readFileSync(path.join(finishDirectory(id), 'state.json'), 'utf-8')) as StoredFinish;

// The shim kills an actual CLI executor before its next external effect. Only the real atomic checkpoints stay.
const interruption = async (state: StoredFinish, target: string, effect: 'inspection' | 'removal' | 'close') => {
  const directory = tempDir('finish-interruption');
  const pid = path.join(directory, 'executor.pid');
  const marker = path.join(directory, 'interrupted');
  const stop = `: >'${marker}'; kill -KILL "$(cat '${pid}')"; exit 71`;
  if (effect === 'close') {
    const tern = path.join(directory, 'tern');
    fs.writeFileSync(tern, `#!/bin/sh\nif [ "$1 $2" = 'close 2' ] && [ ! -e '${marker}' ]; then ${stop}; fi\nexec '${path.join(FIXTURE_BIN, 'tern')}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('TERN_BIN', tern);
  } else {
    const condition =
      effect === 'inspection'
        ? `"$2" = '${target}' ] && [ "$3 $4 $5 $6" = 'rev-parse --path-format=absolute --git-common-dir --show-toplevel'`
        : `"$2" = '${state.repo}' ] && [ "$5 $6 $7" = 'worktree remove ${target}'`;
    await gitShim(`if [ ${condition} ] && [ ! -e '${marker}' ]; then ${stop}; fi`);
  }
  // These interruption tests cross a process boundary. The child must execute the same mutant as the consumer.
  // coverageAnalysis:off also selects checkpoints executed only by that child rather than by parent-side resumption.
  // SAFETY: Stryker exposes only its optional active-mutant identifier on this process-global object.
  const mutant = (globalThis as typeof globalThis & { __stryker__?: { activeMutant?: string } }).__stryker__?.activeMutant;
  const env = { ...process.env };
  if (mutant !== undefined) {
    env.__STRYKER_ACTIVE_MUTANT__ = mutant;
  }
  const result = spawnSync('/bin/sh', ['-c', `printf '%s\\n' "$$" >'${pid}'; exec '${path.join(REPO_DIR, 'bin', 'tern-wt')}' finish execute '${state.id}'`], {
    encoding: 'utf-8',
    env,
    timeout: 10_000,
  });
  expect({ interrupted: fs.existsSync(marker), signal: result.signal, status: result.status, timedOut: result.error !== undefined }).toStrictEqual({
    interrupted: true,
    signal: 'SIGKILL',
    status: null,
    timedOut: false,
  });
  const lock = path.join(finishDirectory(state.id), 'executor.lock');
  expect(fs.readFileSync(lock, 'utf-8')).toBe(fs.readFileSync(pid, 'utf-8'));
  // Explicit operator recovery of the crashed worker's proven lock. Execution must not steal it.
  fs.unlinkSync(lock);
};

const pinCaller = (state: StoredFinish, target: string): string => {
  const pid = 90_001;
  const directory = path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(pid));
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(target, path.join(directory, 'cwd'));
  fs.writeFileSync(path.join(directory, 'stat'), `${pid} (worker) ${['S', '1', String(pid), ...Array.from({ length: 16 }, () => '0'), '100'].join(' ')}`);
  fs.writeFileSync(path.join(directory, 'cmdline'), 'omp');
  const bin = tempDir('finish-checkpoint-ps');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' '${pid} 1 ${pid} omp'\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  state.current = target;
  state.caller = { block: null, identity: { command: 'omp', cwd: target, group: pid, parent: 1, pid, start: '100' }, pid, session: null };
  writeFinish(state);
  return directory;
};

describe('finish checkpoints and multi-target resumption', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test('removes every approved target, including ignored files identical to the main checkout', async () => {
    const { state, targets } = await approval();
    await ignoreGlobally('.env');
    for (const directory of [state.repo, ...targets]) {
      fs.writeFileSync(path.join(directory, '.env'), 'SHARED_LOCAL_VALUE=preserved-in-main\n');
    }
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: [],
      removed: targets.map((target, index) => ({ branchDeleted: false, closedBlocks: [index + 2], path: target })),
      status: 'completed',
    });
    expect(targets.map(target => fs.existsSync(target))).toStrictEqual([false, false]);
    expect(fs.readFileSync(path.join(state.repo, '.env'), 'utf-8')).toBe('SHARED_LOCAL_VALUE=preserved-in-main\n');
    await expect(run(['execute', state.id])).resolves.toStrictEqual(result);
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 2 --json', 'close 3 --json']);
  });

  test.each(['removed', 'keep', 'errors'] as const)('resumes the next selected target after a durable %s result', async recorded => {
    const {
      state,
      targets: [first, second],
    } = await approval();
    state.status = 'running';
    if (recorded === 'removed') {
      state.removed.push({ branchDeleted: false, closedBlocks: [2], path: first });
      await git(state.repo, 'worktree', 'remove', first);
    } else {
      state[recorded].push({ code: recorded === 'keep' ? 'retained' : 'teardown_failed', path: first });
    }
    writeFinish(state);
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
      errors: state.errors,
      keep: state.keep,
      removed: [...state.removed, { branchDeleted: false, closedBlocks: [3], path: second }],
      status: 'completed',
    });
    expect([fs.existsSync(first), fs.existsSync(second)]).toStrictEqual([recorded !== 'removed', false]);
    expect(readLog(log).filter(line => line.includes('worktree remove'))).toHaveLength(1);
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 3 --json']);
    await expect(run(['status', state.id])).resolves.toStrictEqual(result);
  });

  test.each(['planned', 'declined', 'completed'] as const)('execute is read-only for a %s plan', async status => {
    const { state, targets } = await approval();
    state.status = status;
    writeFinish(state);
    const before = fs.readFileSync(path.join(finishDirectory(state.id), 'state.json'), 'utf-8');
    const expected = finishStatus(state.id);
    const log = await logGitCalls();
    await expect(run(['execute', state.id])).resolves.toStrictEqual(expected);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      started: fs.existsSync(path.join(finishDirectory(state.id), 'worker.started')),
      targets: targets.map(target => fs.existsSync(target)),
    }).toStrictEqual({ closes: [], removals: [], started: false, targets: [true, true] });
    expect(fs.readFileSync(path.join(finishDirectory(state.id), 'state.json'), 'utf-8')).toBe(before);
  });

  test('checkpoints running before the first target inspection and resumes both targets', async () => {
    const { state, targets } = await approval();
    await interruption(state, targets[0], 'inspection');
    expect(durable(state.id)).toMatchObject({ errors: [], inFlight: null, keep: [], removed: [], status: 'running' });
    await expect(run(['status', state.id])).resolves.toMatchObject({ status: 'running' });
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, paths: result.removed.map(item => item.path), status: result.status }).toStrictEqual({
      errors: [],
      keep: [],
      paths: targets,
      status: 'completed',
    });
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 2 --json', 'close 3 --json']);
  });

  test.each(['removal', 'close'] as const)('persists inFlight before %s and never replays an interrupted target', async effect => {
    const {
      state,
      targets: [first, second],
    } = await approval();
    await interruption(state, first, effect);
    expect({ state: durable(state.id), targets: [fs.existsSync(first), fs.existsSync(second)] }).toMatchObject({
      state: { errors: [], inFlight: first, keep: [], removed: [], status: 'running' },
      targets: [effect === 'removal', true],
    });
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep.map(item => item.path), removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: [first],
      removed: [{ branchDeleted: false, closedBlocks: [3], path: second }],
      status: 'completed',
    });
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      inFlight: readFinish(state.id).inFlight,
      removals: readLog(log).filter(line => line.includes('worktree remove')).length,
    }).toStrictEqual({ closes: ['close 3 --json'], inFlight: null, removals: 1 });
    await expect(run(['execute', state.id])).resolves.toStrictEqual(result);
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 3 --json']);
  });

  test.each(['removed', 'errors', 'changed', 'interrupted'] as const)('checkpoints the first %s outcome before inspecting the next target', async outcome => {
    const {
      state,
      targets: [first, second],
    } = await approval();
    if (outcome === 'errors') {
      await gitShim(`case "$*" in *"worktree remove ${first}") echo 'fixture removal denied' >&2; exit 1;; esac`);
    } else if (outcome === 'changed') {
      await git(first, 'branch', '-m', 'renamed-after-approval');
    } else if (outcome === 'interrupted') {
      state.inFlight = first;
      state.status = 'running';
      writeFinish(state);
    }
    await interruption(state, second, 'inspection');
    const collection = { changed: 'keep', errors: 'errors', interrupted: 'keep', removed: 'removed' }[outcome];
    expect(durable(state.id)).toMatchObject({ [collection]: [{ path: first }], inFlight: null, status: 'running' });
    const saved = readFinish(state.id);
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
      errors: saved.errors,
      keep: saved.keep,
      removed: [...saved.removed, { branchDeleted: false, closedBlocks: [3], path: second }],
      status: 'completed',
    });
    expect([fs.existsSync(first), fs.existsSync(second)]).toStrictEqual([outcome !== 'removed', false]);
    expect(readLog(log).filter(line => line.includes('worktree remove'))).toHaveLength(1);
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(outcome === 'removed' ? ['close 2 --json', 'close 3 --json'] : ['close 3 --json']);
  });

  test('saves each caller-dependent keep before the next filesystem effect and resumes without duplicating it', async () => {
    const {
      state,
      targets: [first, second],
    } = await approval();
    state.current = first;
    writeFinish(state);
    const interrupted = new Error('fixture checkpoint interruption');
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === path.join(finishDirectory(state.id), 'state.json')) {
        // SAFETY: this file is the valid checkpoint written by the tested executor.
        const pending = JSON.parse(fs.readFileSync(from, 'utf-8')) as StoredFinish;
        if (pending.keep.length === 2 || pending.status === 'completed') {
          throw interrupted;
        }
      }
      original(from, to);
    });
    syncBuiltinESMExports();
    await expect(executeFinish(state.id)).rejects.toBe(interrupted);
    expect(durable(state.id)).toMatchObject({ errors: [], inFlight: null, keep: [{ path: first }], removed: [], status: 'running' });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    fs.unlinkSync(path.join(finishDirectory(state.id), `state-${process.pid}.tmp`));
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep.map(item => item.path), removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: [first, second],
      removed: [],
      status: 'completed',
    });
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    await expect(run(['status', state.id])).resolves.toStrictEqual(result);
  });

  test('retains all targets when the pinned caller is still alive exactly at its deadline', async () => {
    const { state, targets } = await approval();
    const directory = pinCaller(state, targets[0]);
    const log = await logGitCalls();
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      reads += 1;
      if (reads >= 3) {
        fs.rmSync(directory, { force: true, recursive: true });
        return 30_000;
      }
      return 0;
    });
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep.map(item => item.path), removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: targets,
      removed: [],
      status: 'completed',
    });
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      targets: targets.map(target => fs.existsSync(target)),
    }).toStrictEqual({ closes: [], removals: [], targets: [true, true] });
  });

  test('does not exempt the caller foreground block after waiting for its process exit', async () => {
    const {
      state,
      targets: [first, second],
    } = await approval();
    state.current = first;
    state.caller = { block: 2, identity: { command: 'omp', cwd: first, group: 90_001, parent: 1, pid: 90_001, start: '100' }, pid: 90_001, session: null };
    writeFinish(state);
    fs.writeFileSync(
      path.join(process.env.FAKE_TERN_DIR ?? '', 'process-2.json'),
      JSON.stringify({
        child: { argv: ['/bin/zsh', '-l'], cwd: first, name: 'zsh', pid: 61_321 },
        foreground: { argv: ['omp'], cwd: first, name: 'omp', pid: 90_001 },
        group: 90_001,
        pane: 2,
      }),
    );
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep.map(item => item.path), paths: result.removed.map(item => item.path), status: result.status }).toStrictEqual({
      errors: [],
      keep: [first],
      paths: [second],
      status: 'completed',
    });
    expect(readLog(log).filter(line => line.includes('worktree remove'))).toHaveLength(1);
    expect([fs.existsSync(first), fs.existsSync(second)]).toStrictEqual([true, false]);
    expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 3 --json']);
  });

  test('retains real tab-close warnings in the durable result and completion notices', async () => {
    const { state, targets } = await approval();
    vi.stubEnv('FAKE_TERN_FAIL', 'close');
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: [],
      removed: targets.map(target => ({ branchDeleted: false, closedBlocks: [], path: target })),
      status: 'completed',
    });
    expect(result.warnings).toHaveLength(2);
    expect(targets.map(target => fs.existsSync(target))).toStrictEqual([false, false]);
    await expect(run(['status', state.id])).resolves.toStrictEqual(result);
    await expect(run(['notices'])).resolves.toStrictEqual({ completed: [result], pending: [] });
  });
});
