/* oxlint-disable no-throw-literal */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { armFinish, executeFinish } from '../src/finish-execute.ts';
import { finishDirectory, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { planFinish } from '../src/finish.ts';
import { ghFixture, git, logGitCalls, managedPath, readLog, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const approval = async () => {
  const { dir } = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  const mainStat = fs.lstatSync(dir);
  const targetStat = fs.lstatSync(target);
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
    identities: { [dir]: { dev: mainStat.dev, ino: mainStat.ino }, [target]: { dev: targetStat.dev, ino: targetStat.ino } },
    inFlight: null,
    keep: [],
    notified: false,
    owned: [target],
    ready: true,
    removed: [],
    repo: dir,
    selected: [target],
    status: 'armed',
    version: 2,
    warnings: [],
  };
  writeFinish(state);
  return { state, target };
};

describe('finish external filesystem error values', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test('keeps a candidate and its diagnostic when filesystem inspection throws a plain value', async () => {
    const { state, target } = await approval();
    const originalLstat = fs.lstatSync;
    let injected = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      if (file === target) {
        injected = true;
        // oxlint-disable-next-line typescript/only-throw-error
        throw 'candidate filesystem unavailable';
      }
      return originalLstat(file, options);
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    const result = await planFinish({ current: state.repo, owned: [target], repo: state.repo });
    expect({
      candidates: result.candidates,
      closes: ternLog().filter(line => line.startsWith('close ')),
      injected,
      keep: result.keep.filter(item => item.path === target),
      ready: result.ready,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      targetExists: fs.existsSync(target),
    }).toStrictEqual({
      candidates: [],
      closes: [],
      injected: true,
      keep: [{ code: 'inspection_failed', detail: 'candidate filesystem unavailable', path: target }],
      ready: false,
      removals: [],
      targetExists: true,
    });
  });

  test('persists failed startup when opening the worker log throws a plain value', async () => {
    const { state, target } = await approval();
    state.selected = [];
    state.status = 'planned';
    writeFinish(state);
    const workerLog = path.join(finishDirectory(state.id), 'worker.log');
    const originalOpen = fs.openSync;
    let injected = false;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === workerLog) {
        injected = true;
        // oxlint-disable-next-line typescript/only-throw-error
        throw 'worker log unavailable';
      }
      return originalOpen(file, flags, mode);
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    await expect(armFinish(state.id, 'current', [target])).rejects.toThrow('must stay open');
    const result = readFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      injected,
      locked: fs.existsSync(path.join(finishDirectory(state.id), 'executor.lock')),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      status: result.status,
      targetExists: fs.existsSync(target),
      workerStarted: fs.existsSync(path.join(finishDirectory(state.id), 'worker.started')),
    }).toStrictEqual({
      closes: [],
      errors: [{ code: 'worker_start_failed', detail: 'worker log unavailable', path: state.repo }],
      injected: true,
      locked: false,
      removals: [],
      removed: [],
      status: 'completed',
      targetExists: true,
      workerStarted: false,
    });
  });

  test('keeps an approved target when revalidation throws a plain filesystem value', async () => {
    const { state, target } = await approval();
    const originalLstat = fs.lstatSync;
    let injected = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      if (file === target) {
        injected = true;
        // oxlint-disable-next-line typescript/only-throw-error
        throw 'approved path unavailable';
      }
      return originalLstat(file, options);
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      injected,
      keep: result.keep,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      status: result.status,
      targetExists: fs.existsSync(target),
    }).toStrictEqual({
      closes: [],
      errors: [],
      injected: true,
      keep: [{ code: 'inspection_failed', detail: 'approved path unavailable', path: target }],
      removals: [],
      removed: [],
      status: 'completed',
      targetExists: true,
    });
  });

  test('records a teardown failure when configuration inspection throws a plain filesystem value', async () => {
    const { state, target } = await approval();
    const config = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json');
    const originalExists = fs.existsSync;
    let injected = false;
    vi.spyOn(fs, 'existsSync').mockImplementation(file => {
      if (file === config) {
        injected = true;
        // oxlint-disable-next-line typescript/only-throw-error
        throw 'teardown configuration unavailable';
      }
      return originalExists(file);
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      inFlight: readFinish(state.id).inFlight,
      injected,
      keep: result.keep,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      status: result.status,
      targetExists: fs.existsSync(target),
    }).toStrictEqual({
      closes: [],
      errors: [{ code: 'teardown_failed', detail: 'teardown configuration unavailable', path: target }],
      inFlight: null,
      injected: true,
      keep: [],
      removals: [],
      removed: [],
      status: 'completed',
      targetExists: true,
    });
  });

  test('keeps the caller worktree when process identity reading throws a plain filesystem value', async () => {
    const { state, target } = await approval();
    const pid = 90_001;
    const directory = path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(pid));
    fs.mkdirSync(directory);
    const fields = ['S', '1', String(pid), ...Array.from({ length: 16 }, () => '0'), '100'];
    fs.writeFileSync(path.join(directory, 'stat'), `${pid} (worker) ${fields.join(' ')}`);
    fs.writeFileSync(path.join(directory, 'cmdline'), 'omp');
    fs.symlinkSync(target, path.join(directory, 'cwd'));
    state.current = target;
    state.caller = { block: null, identity: { command: 'omp', cwd: target, group: pid, parent: 1, pid, start: '100' }, pid, session: null };
    writeFinish(state);
    let requestedPath: string | null = null;
    vi.spyOn(fsPromises, 'readFile').mockImplementationOnce(file => {
      requestedPath = file === path.join(directory, 'stat') ? path.join(directory, 'stat') : null;
      // oxlint-disable-next-line typescript/only-throw-error
      throw 'caller identity unavailable';
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      keep: result.keep,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      requestedPath,
      status: result.status,
      targetExists: fs.existsSync(target),
    }).toStrictEqual({
      closes: [],
      errors: [],
      keep: [{ code: 'inspection_failed', detail: 'caller identity unavailable', path: target }],
      removals: [],
      removed: [],
      requestedPath: path.join(directory, 'stat'),
      status: 'completed',
      targetExists: true,
    });
  });
});
