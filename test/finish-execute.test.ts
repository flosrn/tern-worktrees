import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { executeFinish } from '../src/finish-execute.ts';
import { lockFinish, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { ghFixture, git, gitShim, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const mergedResponse = (head: string, number = 7, mergedAt = '2026-11-01T10:00:00Z'): void => {
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
        mergedAt,
        number,
        state: 'MERGED',
        url: `https://github.com/virtusize/aoyama/pull/${number}`,
      },
    ]),
  );
};

const approved = async () => {
  const repo = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(repo.dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  await useGithubOrigin();
  mergedResponse(head);
  writeTernLs({ aoyama: [repo.dir, target] });
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
    selected: [target],
    status: 'armed',
    version: 2,
    warnings: [],
  };
  writeFinish(state);
  return { head, repo, state, target };
};

const pinCaller = (state: StoredFinish, target: string): string => {
  const pid = 90_001;
  const directory = path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(pid));
  mkdirSync(directory, { recursive: true });
  symlinkSync(target, path.join(directory, 'cwd'));
  const fields = ['S', '1', String(pid), ...Array.from({ length: 16 }, () => '0'), '100'];
  writeFileSync(path.join(directory, 'stat'), `${pid} (worker) ${fields.join(' ')}`);
  writeFileSync(path.join(directory, 'cmdline'), 'omp');
  const bin = tempDir('finish-execute-ps');
  writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' '${pid} 1 ${pid} omp'\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  state.current = target;
  state.caller = { block: null, identity: { command: 'omp', cwd: target, group: pid, parent: 1, pid, start: '100' }, pid, session: null };
  writeFinish(state);
  return directory;
};

describe('approved delivery finish execution', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('teardown and durable results', () => {
    test.each(['worktree', 'worktree+branch'])('applies the %s branch policy and never repeats tab closure', async teardown => {
      const { repo, state, target } = await approved();
      writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown }));
      vi.stubEnv('FAKE_TERN_GONE_BEFORE_CLOSE', target);
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
        errors: [],
        keep: [],
        removed: [{ branchDeleted: teardown === 'worktree+branch', closedBlocks: [2], path: target }],
        status: 'completed',
      });
      expect({ main: existsSync(repo.dir), target: existsSync(target) }).toStrictEqual({ main: true, target: false });
      const branches = await git(repo.dir, 'branch', '--list', 'delivered');
      expect(branches.trim() !== '').toBe(teardown === 'worktree');
      await expect(run(['execute', state.id])).resolves.toStrictEqual(result);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 2 --json']);
    });

    test('notices expose completion until acknowledgement without executing teardown again', async () => {
      const { state } = await approved();
      await expect(run(['notices'])).resolves.toStrictEqual({ completed: [], pending: [state.id] });
      const result = await executeFinish(state.id);
      await expect(run(['notices'])).resolves.toStrictEqual({ completed: [result], pending: [] });
      await expect(run(['acknowledge', state.id])).resolves.toStrictEqual({ acknowledged: true, id: state.id });
      await expect(run(['notices'])).resolves.toStrictEqual({ completed: [], pending: [] });
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 2 --json']);
    });

    test('records a real git removal failure without closing the worktree tab', async () => {
      const { state, target } = await approved();
      await gitShim('case "$*" in *"worktree remove"*) echo "denied finish removal" >&2; exit 1;; esac');
      const result = await executeFinish(state.id);
      expect({ keep: result.keep, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
        keep: [],
        removed: [],
        status: 'completed',
        targetExists: true,
      });
      expect(result.errors).toStrictEqual([{ code: 'git_failed', detail: 'denied finish removal', path: target }]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
      expect(readFinish(state.id).inFlight).toBeNull();
      await expect(executeFinish(state.id)).resolves.toStrictEqual(result);
    });
  });

  describe('approved target revalidation', () => {
    test.each(['HEAD', 'lock', 'work to lose', 'replaced path', 'PR'])('preserves a target after changed %s', async change => {
      const { head, repo, state, target } = await approved();
      const log = await logGitCalls();
      switch (change) {
        case 'HEAD': {
          await git(target, 'commit', '--allow-empty', '-m', 'new work after approval');
          break;
        }
        case 'lock': {
          await git(repo.dir, 'worktree', 'lock', target);
          break;
        }
        case 'work to lose': {
          writeFileSync(path.join(target, 'later.txt'), 'keep this work\n');
          break;
        }
        case 'replaced path': {
          renameSync(target, `${target}-original`);
          mkdirSync(target);
          writeFileSync(path.join(target, 'replacement.txt'), 'keep this replacement\n');
          break;
        }
        case 'PR': {
          mergedResponse(head, 8);
          break;
        }
        default: {
          throw new Error('Unknown revalidation case');
        }
      }
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
        errors: [],
        removed: [],
        status: 'completed',
        targetExists: true,
      });
      expect(result.keep.map(item => item.path)).toStrictEqual([target]);
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
      const preservedFile = change === 'work to lose' ? readFileSync(path.join(target, 'later.txt'), 'utf-8') : null;
      expect(preservedFile).toBe(change === 'work to lose' ? 'keep this work\n' : null);
    });

    test.each([true, false])('does not replay an interrupted teardown when path exists=%s', async present => {
      const { state, target } = await approved();
      state.inFlight = target;
      state.status = 'running';
      writeFinish(state);
      if (!present) {
        await git(state.repo, 'worktree', 'remove', target);
      }
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
        errors: [],
        removed: [],
        status: 'completed',
        targetExists: present,
      });
      expect(result.keep).toContainEqual({ code: 'interrupted', path: target });
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
      expect(readFinish(state.id).inFlight).toBeNull();
    });
  });

  describe('caller identity and executor ownership', () => {
    test('an absent pinned caller permits teardown', async () => {
      const { state, target } = await approved();
      const directory = pinCaller(state, target);
      rmSync(directory, { recursive: true });
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, keep: result.keep, status: result.status }).toStrictEqual({ errors: [], keep: [], status: 'completed' });
      expect(result.removed.map(item => item.path)).toStrictEqual([target]);
      expect(existsSync(target)).toBeFalsy();
    });

    test('a missing caller identity preserves its selected current worktree', async () => {
      const { state, target } = await approved();
      state.current = target;
      writeFinish(state);
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
        errors: [],
        removed: [],
        status: 'completed',
        targetExists: true,
      });
      expect(result.keep).toContainEqual({ code: 'caller_waiting', path: target });
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('a reused pinned PID preserves the selected worktree', async () => {
      const { state, target } = await approved();
      const directory = pinCaller(state, target);
      writeFileSync(path.join(directory, 'cmdline'), 'different-worker');
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
        errors: [],
        removed: [],
        status: 'completed',
        targetExists: true,
      });
      expect(result.keep).toContainEqual({ code: 'caller_waiting', path: target });
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('a caller still alive at the deadline preserves its selected worktree', async () => {
      const { state, target } = await approved();
      pinCaller(state, target);
      const log = await logGitCalls();
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 60_000;
        return now;
      });
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
        errors: [],
        removed: [],
        status: 'completed',
        targetExists: true,
      });
      expect(result.keep).toContainEqual({ code: 'caller_waiting', path: target });
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('an executor lock held past startup leaves approval and targets untouched', async () => {
      const { state, target } = await approved();
      const release = lockFinish(state.id);
      if (release === null) {
        throw new Error('Fixture could not acquire executor lock');
      }
      const log = await logGitCalls();
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 60_000;
        return now;
      });
      try {
        const result = await executeFinish(state.id);
        expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status, targetExists: existsSync(target) }).toStrictEqual({
          errors: [],
          keep: [],
          removed: [],
          status: 'armed',
          targetExists: true,
        });
        expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
        expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
        await expect(run(['acknowledge', state.id])).resolves.toStrictEqual({ acknowledged: false, id: state.id });
      } finally {
        release();
      }
    });
  });

  describe('resumption and uncertain observations', () => {
    test.each(['removed', 'keep', 'errors'])('does not replay a target with a recorded %s result', async recorded => {
      const { state, target } = await approved();
      state.status = 'running';
      if (recorded === 'removed') {
        state.removed.push({ branchDeleted: false, closedBlocks: [2], path: target });
        await git(state.repo, 'worktree', 'remove', target);
      } else if (recorded === 'keep') {
        state.keep.push({ code: 'retained', path: target });
      } else {
        state.errors.push({ code: 'teardown_failed', path: target });
      }
      writeFinish(state);
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
        errors: state.errors,
        keep: state.keep,
        removed: state.removed,
        status: 'completed',
      });
      expect(existsSync(target)).toBe(recorded !== 'removed');
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('preserves a target replaced by a symbolic link to its original directory', async () => {
      const { state, target } = await approved();
      const original = `${target}-original`;
      renameSync(target, original);
      symlinkSync(original, target);
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep).toStrictEqual([{ code: 'path_identity_changed', path: target }]);
      expect({
        closes: ternLog().filter(line => line.startsWith('close ')),
        originalExists: existsSync(original),
        removals: readLog(log).filter(line => line.includes('worktree remove')),
        targetIsLink: lstatSync(target).isSymbolicLink(),
      }).toStrictEqual({ closes: [], originalExists: true, removals: [], targetIsLink: true });
    });

    test('preserves a target whose foreground process became busy after approval', async () => {
      const { state, target } = await approved();
      writeFileSync(
        path.join(process.env.FAKE_TERN_DIR ?? '', 'process-2.json'),
        JSON.stringify({
          child: { argv: ['/bin/zsh', '-l'], cwd: target, name: 'zsh', pid: 61_321 },
          foreground: { argv: ['bun', 'server.ts'], cwd: target, name: 'bun', pid: 61_322 },
          group: 61_322,
          pane: 2,
        }),
      );
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep).toStrictEqual([{ code: 'active_process', path: target }]);
      expect(existsSync(target)).toBeTruthy();
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('preserves a target when its merged proof timestamp changes', async () => {
      const { head, state, target } = await approved();
      mergedResponse(head, 7, '2026-11-02T10:00:00Z');
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep).toStrictEqual([{ code: 'not_merged', path: target }]);
      expect(existsSync(target)).toBeTruthy();
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('preserves a target when an attributed process stat cannot be read', async () => {
      const { state, target } = await approved();
      const directory = pinCaller(state, target);
      state.current = null;
      state.caller = { block: null, identity: null, pid: null, session: null };
      writeFinish(state);
      rmSync(path.join(directory, 'stat'));
      mkdirSync(path.join(directory, 'stat'));
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep.map(item => ({ code: item.code, path: item.path }))).toStrictEqual([{ code: 'inspection_failed', path: target }]);
      expect(existsSync(target)).toBeTruthy();
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('does not infer caller exit from an unreadable process cwd', async () => {
      const { state, target } = await approved();
      const directory = pinCaller(state, target);
      rmSync(path.join(directory, 'cwd'));
      const log = await logGitCalls();
      const result = await executeFinish(state.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep.map(item => ({ code: item.code, path: item.path }))).toStrictEqual([{ code: 'inspection_failed', path: target }]);
      expect(existsSync(target)).toBeTruthy();
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
    });

    test('waits until the pinned caller exits before removing its worktree', async () => {
      const { state, target } = await approved();
      writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown: 'worktree' }));
      const directory = pinCaller(state, target);
      let clockReads = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        clockReads += 1;
        if (clockReads === 3) {
          rmSync(directory, { recursive: true });
        }
        return 0;
      });
      const result = await executeFinish(state.id);
      expect(result).toMatchObject({ errors: [], keep: [], status: 'completed' });
      expect(result.removed).toStrictEqual([{ branchDeleted: false, closedBlocks: [2], path: target }]);
      expect(existsSync(target)).toBeFalsy();
      expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual(['close 2 --json']);
    });

    test.each([false, true])('rechecks durable state after executor lock contention: completed=%s', async completed => {
      const { state, target } = await approved();
      writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown: 'worktree' }));
      const release = lockFinish(state.id);
      if (release === null) {
        throw new Error('Fixture could not acquire executor lock');
      }
      let released = false;
      let clockReads = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        clockReads += 1;
        if (clockReads === 2) {
          if (completed) {
            state.status = 'completed';
            writeFinish(state);
          }
          release();
          released = true;
        }
        return 0;
      });
      const log = await logGitCalls();
      try {
        const result = await executeFinish(state.id);
        expect({
          closes: ternLog().filter(line => line.startsWith('close ')),
          errors: result.errors,
          keep: result.keep,
          removalCalls: readLog(log).filter(line => line.includes('worktree remove')).length,
          removed: result.removed,
          status: result.status,
          targetExists: existsSync(target),
        }).toStrictEqual({
          closes: completed ? [] : ['close 2 --json'],
          errors: [],
          keep: [],
          removalCalls: completed ? 0 : 1,
          removed: completed ? [] : [{ branchDeleted: false, closedBlocks: [2], path: target }],
          status: 'completed',
          targetExists: completed,
        });
      } finally {
        if (!released) {
          release();
        }
      }
    });
  });
});
