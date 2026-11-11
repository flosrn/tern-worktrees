import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import type { ProcessIdentity } from '../src/clean-processes.ts';
import { callerStillRunning, finishActivity } from '../src/finish-processes.ts';
import { readFinish } from '../src/finish-store.ts';
import type { FinishPlan } from '../src/finish-types.ts';
import { planFinish } from '../src/finish.ts';
import type { TernProcess } from '../src/tern.ts';
import { ghFixture, ghLog, git, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs, writeTernLsRaw } from './helpers.ts';

// SAFETY: the plan command returns the public FinishPlan contract.
const planned = async (...args: string[]): Promise<FinishPlan> => (await run(['plan', ...args])) as FinishPlan;

const delivered = async () => {
  const repo = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(repo.dir, 'worktree', 'add', '-b', 'delivered', target);
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
  const log = await logGitCalls();
  return { ...repo, head, log, target };
};

const expectReadOnly = (target: string, log: string): void => {
  expect(existsSync(target)).toBeTruthy();
  expect(readLog(log).filter(line => /worktree remove|branch -[dD]|update-ref/u.test(line))).toStrictEqual([]);
  expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
};

const identity = (pid: number, cwd: string, command = 'omp'): ProcessIdentity => ({ command, cwd, group: pid, parent: 1, pid, start: '100' });

const writeStat = (entry: ProcessIdentity): void => {
  const fields = ['S', String(entry.parent), String(entry.group), ...Array.from({ length: 16 }, () => '0'), entry.start];
  writeFileSync(path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(entry.pid), 'stat'), `${entry.pid} (worker) ${fields.join(' ')}`);
};

const writeProcesses = (entries: ProcessIdentity[]): void => {
  for (const entry of entries) {
    const directory = path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(entry.pid));
    mkdirSync(directory, { recursive: true });
    symlinkSync(entry.cwd, path.join(directory, 'cwd'));
    writeStat(entry);
    writeFileSync(path.join(directory, 'cmdline'), entry.command);
  }
  const bin = tempDir('finish-observation-ps');
  const rows = entries.map(entry => `'${entry.pid} ${entry.parent} ${entry.group} ${entry.command}'`).join(' ');
  writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' ${rows}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
};

const writeTerminal = (child: TernProcess | null, foreground: TernProcess | null): void => {
  writeFileSync(path.join(process.env.FAKE_TERN_DIR ?? '', 'process-1.json'), JSON.stringify({ child, foreground, group: foreground?.pid ?? child?.pid ?? null, pane: 1 }));
};

const terminalProcess = (entry: ProcessIdentity, name: string): TernProcess => ({ argv: entry.command.split(' '), cwd: entry.cwd, name, pid: entry.pid });

describe('delivery finish observations', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  describe('canonical worktree directories', () => {
    it.each(['worktree', 'worktree root'])('keeps a registered target reached through a symbolic-link %s', async alias => {
      const { dir, log, target } = await delivered();
      const original = alias === 'worktree' ? target : path.dirname(path.dirname(target));
      const moved = `${original}-original`;
      renameSync(original, moved);
      symlinkSync(moved, original);
      const result = await planned('--repo', dir);
      expect({ candidates: result.candidates, kept: result.keep.map(item => item.path).toSorted(), ready: result.ready }).toStrictEqual({
        candidates: [],
        kept: [dir, target].toSorted(),
        ready: false,
      });
      expect({
        alias: lstatSync(original).isSymbolicLink(),
        githubCalls: ghLog(),
        preservedDirectory: existsSync(moved),
        targetGitCalls: readLog(log).filter(line => line.startsWith(`-C ${target} `)),
        ternCalls: ternLog(),
      }).toStrictEqual({ alias: true, githubCalls: [], preservedDirectory: true, targetGitCalls: [], ternCalls: [] });
      expectReadOnly(target, log);
    });

    it('plans an exact-HEAD merged current worktree when the caller omits exclusions', async () => {
      const { dir, head, log, target } = await delivered();
      const result = await planFinish({ current: target, owned: [target], repo: dir });
      expect({ candidates: result.candidates.map(candidate => ({ head: candidate.head, path: candidate.path })), ready: result.ready }).toStrictEqual({
        candidates: [{ head, path: target }],
        ready: true,
      });
      expect(result.keep.map(item => item.path)).toStrictEqual([dir]);
      expectReadOnly(target, log);
    });
  });

  describe('untrusted Tern listings', () => {
    it.each([
      { block: null, label: 'block object', tab: {} },
      { block: { id: 1.5 }, label: 'block ID', tab: {} },
      { block: { title: null }, label: 'block title', tab: {} },
      { block: {}, label: 'tab object', tab: null },
      { block: {}, label: 'tab ID', tab: { id: 'one' } },
      { block: {}, label: 'tab name', tab: { name: 1 } },
    ])('keeps a worktree when its $label is malformed', async ({ block, tab }) => {
      const { dir, log, target } = await delivered();
      const listedBlock = block === null ? null : { cwd: target, id: 1, title: 'sh', ...block };
      const listedTab = tab === null ? null : { blocks: [listedBlock], id: 1, name: 'delivered', ...tab };
      writeTernLsRaw(JSON.stringify({ sessions: [{ id: 1, name: 'aoyama', tabs: [listedTab] }] }));
      const result = await planned('--repo', dir, '--current', target);
      expect({ candidates: result.candidates, kept: result.keep.map(item => item.path).toSorted(), ready: result.ready }).toStrictEqual({
        candidates: [],
        kept: [dir, target].toSorted(),
        ready: false,
      });
      expect(result.keep).toContainEqual(expect.objectContaining({ code: 'tern_failed', path: target }));
      expect(ghLog()).toStrictEqual([]);
      expect(ternLog()).toStrictEqual(['ls --json']);
      expectReadOnly(target, log);
    });
  });

  describe('terminal and process ownership', () => {
    it.each([
      { childKind: 'absent', code: null },
      { childKind: 'idle shell', code: null },
      { childKind: 'busy command', code: 'active_process' },
    ])('attributes the prospective caller independently of its $childKind terminal child', async ({ childKind, code }) => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, target);
      const childName = childKind === 'idle shell' ? 'zsh' : 'node';
      const childCommand = childKind === 'idle shell' ? 'zsh -l' : 'node agent.js';
      const child = childKind === 'absent' ? null : identity(90_002, target, childCommand);
      writeProcesses(child === null ? [caller] : [caller, child]);
      writeTernLs({ aoyama: [target] });
      writeTerminal(child === null ? null : terminalProcess(child, childName), terminalProcess(caller, 'omp'));
      const result = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid), '--block', '1');
      const busy = childKind === 'busy command';
      expect({
        candidates: result.candidates.map(candidate => candidate.path),
        code: result.keep.find(item => item.path === target)?.code ?? null,
        kept: result.keep.map(item => item.path).toSorted(),
        ready: result.ready,
      }).toStrictEqual({
        candidates: busy ? [] : [target],
        code,
        kept: (busy ? [dir, target] : [dir]).toSorted(),
        ready: !busy,
      });
      expectReadOnly(target, log);
    });

    it('keeps a worktree with an owned process even when the terminal has no child or foreground process', async () => {
      const { dir, log, target } = await delivered();
      writeProcesses([identity(90_002, target, 'node server.js')]);
      writeTernLs({ aoyama: [target] });
      writeTerminal(null, null);
      const result = await planned('--repo', dir, '--current', target);
      expect({ candidates: result.candidates, ready: result.ready }).toStrictEqual({ candidates: [], ready: false });
      expect(result.keep).toContainEqual({ code: 'active_process', path: target });
      expectReadOnly(target, log);
    });

    it('does not attribute outside processes, the inspector, or an idle terminal shell as active work', async () => {
      const { dir, log, target } = await delivered();
      const plan = await planned('--repo', dir, '--current', target);
      const state = readFinish(plan.id);
      const shell = identity(90_002, target, 'zsh -l');
      writeProcesses([identity(90_003, dir, 'node unrelated.js'), identity(process.pid, target, 'bun finish'), shell]);
      writeTernLs({ aoyama: [target] });
      writeTerminal(terminalProcess(shell, 'zsh'), terminalProcess(shell, 'zsh'));
      const activity = await finishActivity(state, target, false);
      expect({ blocks: activity.blocks.map(entry => entry.block.id), reason: activity.reason, warnings: state.warnings }).toStrictEqual({
        blocks: [1],
        reason: null,
        warnings: [],
      });
      expectReadOnly(target, log);
    });
  });

  describe('caller exit evidence', () => {
    it('distinguishes the still-running caller from a reused PID with a different birth identity', async () => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, target);
      writeProcesses([caller]);
      const plan = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid));
      const state = readFinish(plan.id);
      state.selected = [target];
      await expect(callerStillRunning(state)).resolves.toBe('waiting');
      writeStat({ ...caller, start: '200' });
      await expect(callerStillRunning(state)).resolves.toBe('unproven');
      expectReadOnly(target, log);
    });

    it('does not wait for a pinned caller whose directory is outside every selected worktree', async () => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, dir);
      writeProcesses([caller]);
      const plan = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid));
      const state = readFinish(plan.id);
      state.selected = [target];
      await expect(callerStillRunning(state)).resolves.toBeNull();
      expectReadOnly(target, log);
    });

    it('requires exit evidence for an omitted caller PID only when its current worktree is selected', async () => {
      const { dir, log, target } = await delivered();
      const plan = await planned('--repo', dir, '--current', target);
      const state = readFinish(plan.id);
      state.selected = [target];
      await expect(callerStillRunning(state)).resolves.toBe('unproven');
      state.selected = [];
      await expect(callerStillRunning(state)).resolves.toBeNull();
      state.current = null;
      state.selected = [target];
      await expect(callerStillRunning(state)).resolves.toBeNull();
      expectReadOnly(target, log);
    });

    it('does not treat a numeric caller PID without a planning identity as proof of exit', async () => {
      const { dir, log, target } = await delivered();
      const plan = await planned('--repo', dir, '--current', target, '--pid', '90001');
      const state = readFinish(plan.id);
      state.selected = [target];
      await expect(callerStillRunning(state)).resolves.toBe('unproven');
      expectReadOnly(target, log);
    });
  });
});
