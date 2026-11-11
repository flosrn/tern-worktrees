import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import type { FinishState } from '../src/finish-types.ts';
import {
  addDelivered,
  arm,
  delivered,
  executed,
  expectPreserved,
  identity,
  planned,
  processDirectory,
  sampleProcesses,
  statLine,
  terminalProcess,
  writeProcess,
  writeTerminal,
} from './finish-activity-fixture.ts';
import { git, managedPath, readLog, tempDir, ternLog, useSandbox, writeTernLs, writeTernLsRaw } from './helpers.ts';

const expireCallerWait = (): void => {
  let reads = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    reads += 1;
    return reads < 3 ? 0 : 60_000;
  });
};

describe('delivery finish activity identity through system observations', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pinned caller identity', () => {
    it.each(['parent', 'group', 'pid'] as const)('does not exempt a sampled process when only its %s differs from the pinned caller', async changed => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, target);
      writeProcess(caller);
      const observed = { ...caller, [changed]: changed === 'parent' ? 2 : 90_002 };
      if (changed === 'pid') {
        writeProcess(observed);
      }
      const before = changed === 'pid' ? '' : `printf '%s' '${statLine(observed)}' > '${processDirectory(caller.pid)}/stat'`;
      sampleProcesses([observed], before);
      const result = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid));
      expect({ candidates: result.candidates, ready: result.ready }).toStrictEqual({ candidates: [], ready: false });
      expect(result.keep).toContainEqual({ code: 'active_process', path: target });
      expectPreserved(target, log);
    });

    it.each(['parent', 'group'] as const)('keeps an approved target when only the caller %s changes before exit can be proven', async changed => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, target);
      writeProcess(caller);
      sampleProcesses([caller]);
      const plan = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid));
      expect(plan.ready).toBeTruthy();
      await arm(plan, [target]);
      writeFileSync(path.join(processDirectory(caller.pid), 'stat'), statLine({ ...caller, [changed]: changed === 'parent' ? 2 : 90_002 }));
      expireCallerWait();
      const result = await executed(plan.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep).toContainEqual({ code: 'caller_waiting', path: target });
      expectPreserved(target, log);
    });

    it('preserves an approved target and its caller diagnostic when the pinned process can no longer be inspected', async () => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, target);
      writeProcess(caller);
      sampleProcesses([caller]);
      const plan = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid));
      expect(plan.ready).toBeTruthy();
      await arm(plan, [target]);
      writeFileSync(path.join(processDirectory(caller.pid), 'stat'), 'unreadable birth identity');
      const result = await executed(plan.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      const cause = result.keep.find(item => item.path === target);
      expect(cause).toMatchObject({ code: 'inspection_failed', path: target });
      expect(cause?.detail).toContain(String(caller.pid));
      await expect(run(['status', plan.id])).resolves.toMatchObject({ keep: result.keep, removed: [], status: 'completed' });
      expectPreserved(target, log);
    });

    it('does not wait for an unproven caller in an unselected current worktree', async () => {
      const { dir, log } = await delivered();
      const other = await addDelivered(dir, 'other', 8);
      const current = managedPath('current-unmerged');
      await git(dir, 'worktree', 'add', '-b', 'current-unmerged', current);
      const plan = await planned('--repo', dir, '--current', current, '--owned', other);
      expect(plan.ready).toBeTruthy();
      expect(plan.candidates.map(candidate => candidate.path)).not.toContain(current);
      await arm(
        plan,
        plan.candidates.map(candidate => candidate.path),
      );
      const result = await executed(plan.id);
      expect(result.errors).toStrictEqual([]);
      expect(result.removed.map(item => item.path).toSorted()).toStrictEqual(plan.candidates.map(candidate => candidate.path).toSorted());
      expect({
        currentExists: existsSync(current),
        currentRemoval: readLog(log).some(line => line.includes(`worktree remove ${current}`)),
        otherExists: existsSync(other),
      }).toStrictEqual({ currentExists: true, currentRemoval: false, otherExists: false });
    });

    it('still waits for the caller when its directory belongs to only one of two selected worktrees', async () => {
      const { dir, log, target } = await delivered();
      const other = await addDelivered(dir, 'other', 8);
      const caller = identity(90_001, target);
      writeProcess(caller);
      sampleProcesses([caller]);
      const plan = await planned('--repo', dir, '--current', target, '--owned', other, '--pid', String(caller.pid));
      expect(plan.ready).toBeTruthy();
      const selected = plan.candidates.map(candidate => candidate.path);
      expect(selected.toSorted()).toStrictEqual([other, target].toSorted());
      await arm(plan, selected);
      expireCallerWait();
      const result = await executed(plan.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep.filter(item => selected.includes(item.path))).toStrictEqual(selected.map(selectedPath => ({ code: 'caller_waiting', path: selectedPath })));
      expectPreserved(target, log);
      expect(existsSync(other)).toBeTruthy();
    });
  });

  describe('complete Tern listing validation', () => {
    it('accepts a null cwd outside the target while still inspecting its real worktree block', async () => {
      const { dir, log, target } = await delivered();
      writeTernLsRaw(
        JSON.stringify({
          sessions: [
            {
              id: 1,
              name: 'aoyama',
              tabs: [
                {
                  blocks: [
                    { cwd: null, id: 1, title: 'unknown directory' },
                    { cwd: target, id: 2, title: 'idle shell' },
                  ],
                  id: 1,
                  name: 'delivered',
                },
              ],
            },
          ],
        }),
      );
      const plan = await planned('--repo', dir, '--current', target);
      expect({ candidates: plan.candidates.map(candidate => candidate.path), ready: plan.ready }).toStrictEqual({ candidates: [target], ready: true });
      expect(ternLog().filter(line => line.startsWith('process '))).toStrictEqual(['process 2 --json']);
      expectPreserved(target, log);
    });

    it.each(['outside the target', 'holding the target'] as const)('accepts an unnamed tab %s while still inspecting its real worktree block', async placement => {
      const { dir, log, target } = await delivered();
      const targetTab = { blocks: [{ cwd: target, id: 1, title: 'idle shell' }], id: 1 };
      const otherTab = { blocks: [{ cwd: '/elsewhere', id: 2, title: 'other shell' }], id: 2, name: null };
      const tabs = placement === 'holding the target' ? [{ ...targetTab, name: null }] : [{ ...targetTab, name: 'delivered' }, otherTab];
      writeTernLsRaw(JSON.stringify({ sessions: [{ id: 1, name: 'aoyama', tabs }] }));
      const plan = await planned('--repo', dir, '--current', target);
      expect({ candidates: plan.candidates.map(candidate => candidate.path), ready: plan.ready }).toStrictEqual({ candidates: [target], ready: true });
      expect(plan.keep.map(item => item.path)).not.toContain(target);
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json']);
      expectPreserved(target, log);
    });

    it('accepts an empty worktree tab alongside the target block', async () => {
      const { dir, log, target } = await delivered();
      writeTernLsRaw(
        JSON.stringify({
          sessions: [
            {
              id: 1,
              name: 'aoyama',
              tabs: [
                { blocks: [{ cwd: target, id: 1, title: 'idle shell' }], id: 1, name: 'delivered' },
                { blocks: [], id: 2, name: 'empty' },
              ],
            },
          ],
        }),
      );
      const plan = await planned('--repo', dir, '--current', target);
      expect({ candidates: plan.candidates.map(candidate => candidate.path), ready: plan.ready }).toStrictEqual({ candidates: [target], ready: true });
      expect(plan.keep.map(item => item.path)).not.toContain(target);
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json']);
      expectPreserved(target, log);
    });

    it.each(['cwd', 'mixed blocks', 'mixed titles', 'mixed tabs', 'missing tab name', 'session id', 'session name', 'session object', 'listing object', 'sessions array'] as const)(
      'keeps a target when the Tern listing has an invalid %s alongside usable data',
      async invalid => {
        const { dir, log, target } = await delivered();
        const block = { cwd: target, id: 1, title: 'idle shell' };
        const tab = { blocks: [block], id: 1, name: 'delivered' };
        const session = { id: 1, name: 'aoyama', tabs: [tab] };
        const listings = {
          'cwd': { sessions: [{ ...session, tabs: [{ ...tab, blocks: [{ ...block, cwd: 5 }] }] }] },
          'listing object': [],
          'missing tab name': { sessions: [{ ...session, tabs: [tab, { blocks: [], id: 2 }] }] },
          'mixed blocks': { sessions: [{ ...session, tabs: [{ ...tab, blocks: [block, { ...block, cwd: false, id: 2 }] }] }] },
          'mixed tabs': { sessions: [{ ...session, tabs: [tab, { blocks: [], id: 'two', name: 'untrusted' }] }] },
          'mixed titles': { sessions: [{ ...session, tabs: [{ ...tab, blocks: [block, { ...block, id: 2, title: null }] }] }] },
          'session id': { sessions: [{ ...session, id: 'one' }] },
          'session name': { sessions: [{ ...session, name: null }] },
          'session object': { sessions: [session, null] },
          'sessions array': { sessions: null },
        };
        writeTernLsRaw(JSON.stringify(listings[invalid]));
        const plan = await planned('--repo', dir, '--current', target);
        expect({ candidates: plan.candidates, ready: plan.ready }).toStrictEqual({ candidates: [], ready: false });
        const cause = plan.keep.find(item => item.path === target);
        const detail = cause?.detail ?? '';
        expect(cause).toMatchObject({ code: 'tern_failed', path: target });
        expect(detail).toMatch(/\S/u);
        expect(ternLog()).toStrictEqual(['ls --json']);
        expectPreserved(target, log);
      },
    );
  });

  describe('caller and idle-shell exemptions', () => {
    it.each([
      { expected: { candidate: true, ready: true, retainedAsActiveForeground: false }, mismatch: 'missing foreground' },
      { expected: { candidate: false, ready: false, retainedAsActiveForeground: true }, mismatch: 'missing caller identity' },
      { expected: { candidate: false, ready: false, retainedAsActiveForeground: true }, mismatch: 'different caller block' },
      { expected: { candidate: false, ready: true, retainedAsActiveForeground: true }, mismatch: 'different target' },
    ])('limits the caller exemption with $mismatch', async ({ expected, mismatch }) => {
      const { dir, log, target } = await delivered();
      const other = mismatch === 'different target' ? await addDelivered(dir, 'other', 8) : null;
      const caller = identity(90_001, target);
      if (mismatch !== 'missing caller identity') {
        writeProcess(caller);
      }
      sampleProcesses(mismatch === 'missing caller identity' ? [] : [caller]);
      const activeTarget = other ?? target;
      writeTernLs({ aoyama: [activeTarget] });
      writeTerminal(1, null, mismatch === 'missing foreground' ? null : terminalProcess(caller));
      const plan = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid), '--block', mismatch === 'different caller block' ? '2' : '1');
      expect({
        candidate: plan.candidates.some(candidate => candidate.path === activeTarget),
        ready: plan.ready,
        retainedAsActiveForeground: plan.keep.some(item => item.path === activeTarget && item.code === 'active_process'),
      }).toStrictEqual(expected);
      expectPreserved(target, log);
    });

    it.each(['no foreground', 'different foreground'] as const)('does not exempt an OS-owned child shell from process inspection with %s', async foregroundKind => {
      const { dir, log, target } = await delivered();
      const child = identity(90_002, target, 'zsh -l');
      writeProcess(child);
      sampleProcesses([child]);
      writeTernLs({ aoyama: [target] });
      writeTerminal(1, terminalProcess(child, 'zsh'), foregroundKind === 'no foreground' ? null : terminalProcess(identity(90_003, target, 'node server.js'), 'node'));
      const plan = await planned('--repo', dir, '--current', target);
      expect({ candidates: plan.candidates, ready: plan.ready }).toStrictEqual({ candidates: [], ready: false });
      expect(plan.keep).toContainEqual({ code: 'active_process', path: target });
      expectPreserved(target, log);
    });

    it('never exempts the caller process from an owned target that is not the current worktree', async () => {
      const { dir, log, target } = await delivered();
      const current = await addDelivered(dir, 'current', 8);
      const caller = identity(90_001, target);
      writeProcess(caller);
      sampleProcesses([caller]);
      const plan = await planned('--repo', dir, '--current', current, '--owned', target, '--pid', String(caller.pid));
      expect({ candidates: plan.candidates.map(candidate => candidate.path), ready: plan.ready }).toStrictEqual({ candidates: [current], ready: true });
      expect(plan.keep).toContainEqual({ code: 'active_process', path: target });
      expectPreserved(target, log);
    });

    it.each(['foreground', 'process snapshot'] as const)('rechecks a stale caller %s without the prospective exemption after its OS identity exits', async source => {
      const { dir, log, target } = await delivered();
      const caller = identity(90_001, target);
      writeProcess(caller);
      sampleProcesses([caller]);
      writeTernLs({ aoyama: [target] });
      writeTerminal(1, null, terminalProcess(caller));
      const plan = await planned('--repo', dir, '--current', target, '--pid', String(caller.pid), '--block', '1');
      expect(plan.ready).toBeTruthy();
      await arm(plan, [target]);
      rmSync(processDirectory(caller.pid), { recursive: true });
      if (source === 'process snapshot') {
        writeTernLs({});
        const inspector = identity(process.pid, dir, 'bun finish');
        writeProcess(inspector);
        sampleProcesses(
          [caller, inspector],
          `mkdir -p '${processDirectory(caller.pid)}'\nln -s '${target}' '${processDirectory(caller.pid)}/cwd'\nprintf '%s' '${statLine(caller)}' > '${processDirectory(caller.pid)}/stat'\nprintf '%s' '${caller.command}' > '${processDirectory(caller.pid)}/cmdline'`,
        );
      }
      const result = await executed(plan.id);
      expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
      expect(result.keep).toContainEqual({ code: 'active_process', path: target });
      expectPreserved(target, log);
    });
  });

  describe('public activity causes', () => {
    it.each([
      { expected: { candidate: false, ready: false, status: 'planned' }, phase: 'plan' },
      { expected: { candidate: true, ready: true, status: 'completed' }, phase: 'execute' },
    ] as const)('retains the process evidence in inspection_failed detail during $phase', async ({ expected, phase }) => {
      const { dir, log, target } = await delivered();
      const approval = phase === 'execute' ? await planned('--repo', dir, '--owned', target) : null;
      if (approval !== null) {
        await arm(approval, [target]);
      }
      const uncertain = identity(90_017, target, 'node delivery-audit-worker.js');
      writeProcess(uncertain);
      rmSync(path.join(processDirectory(uncertain.pid), 'stat'));
      sampleProcesses([uncertain]);
      const result = approval === null ? await planned('--repo', dir, '--owned', target) : await executed(approval.id);
      const cause = result.keep.find(item => item.path === target);
      expect(cause).toMatchObject({ code: 'inspection_failed', path: target });
      expect(cause?.detail).toContain(String(uncertain.pid));
      expect(cause?.detail).toContain(uncertain.command);
      // SAFETY: the status command returns the public FinishState contract.
      const state = (await run(['status', result.id])) as FinishState;
      const expectedPaths = expected.candidate ? [target] : [];
      expect({
        candidates: state.candidates.map(candidate => candidate.path),
        errors: state.errors,
        ready: state.ready,
        removed: state.removed,
        status: state.status,
      }).toStrictEqual({
        candidates: expectedPaths,
        errors: [],
        ready: expected.ready,
        removed: [],
        status: expected.status,
      });
      await expect(run(['status', result.id])).resolves.toMatchObject({ keep: result.keep });
      expectPreserved(target, log);
    });

    it.each([
      { expected: { candidate: false, ready: false, status: 'planned' }, phase: 'plan', source: 'terminal' },
      { expected: { candidate: false, ready: false, status: 'planned' }, phase: 'plan', source: 'process snapshot' },
      { expected: { candidate: true, ready: true, status: 'completed' }, phase: 'execute', source: 'terminal' },
      { expected: { candidate: true, ready: true, status: 'completed' }, phase: 'execute', source: 'process snapshot' },
    ] as const)('keeps a busy worktree with a structured cause and no freeform detail during $phase from $source', async ({ expected, phase, source }) => {
      const { dir, log, target } = await delivered();
      const approval = phase === 'execute' ? await planned('--repo', dir, '--owned', target) : null;
      expect(approval?.ready ?? true).toBeTruthy();
      if (approval !== null) {
        await arm(approval, [target]);
      }
      const busy = identity(90_018, target, 'node delivery-monitor.js');
      if (source === 'terminal') {
        writeTernLs({ aoyama: [target] });
        writeTerminal(1, null, terminalProcess(busy, 'node'));
      } else {
        writeProcess(busy);
        sampleProcesses([busy]);
      }
      const result = approval === null ? await planned('--repo', dir, '--owned', target) : await executed(approval.id);
      expect(result.keep.filter(item => item.path === target)).toStrictEqual([{ code: 'active_process', path: target }]);
      // SAFETY: the status command returns the public FinishState contract.
      const state = (await run(['status', result.id])) as FinishState;
      const expectedPaths = expected.candidate ? [target] : [];
      expect({
        candidates: state.candidates.map(candidate => candidate.path),
        errors: state.errors,
        ready: state.ready,
        removed: state.removed,
        status: state.status,
      }).toStrictEqual({
        candidates: expectedPaths,
        errors: [],
        ready: expected.ready,
        removed: [],
        status: expected.status,
      });
      await expect(run(['status', result.id])).resolves.toMatchObject({ keep: result.keep });
      expectPreserved(target, log);
    });
  });

  describe('inspection warnings', () => {
    it.each([false, true])('retains process warnings across multiple target observations without duplicates: distinct=%s', async distinct => {
      const { dir, log, target } = await delivered();
      const other = await addDelivered(dir, 'other', 8);
      const entry = identity(90_001, target, 'node server.js');
      writeProcess(entry);
      rmSync(path.join(processDirectory(entry.pid), 'stat'));
      const bin = tempDir('finish-warning-ps');
      const lock = path.join(bin, 'first-call');
      writeFileSync(
        path.join(bin, 'ps'),
        `#!/bin/sh\nif mkdir '${lock}' 2>/dev/null; then\n  printf '%s\\n' '90001 1 90001 node server.js'\nelse\n  printf '%s\\n' '90001 1 90001 ${distinct ? 'node watcher.js' : 'node server.js'}'\nfi\n`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      const plan = await planned('--repo', dir, '--current', target, '--owned', other);
      const expected = ['Process inspection incomplete: 90001 (node server.js).', ...(distinct ? ['Process inspection incomplete: 90001 (node watcher.js).'] : [])];
      expect(plan.warnings.toSorted()).toStrictEqual(expected.toSorted());
      expect(plan.keep).toContainEqual(expect.objectContaining({ code: 'inspection_failed', path: target }));
      expect(plan.candidates.map(candidate => candidate.path)).toStrictEqual([other]);
      expectPreserved(target, log);
      expect(existsSync(other)).toBeTruthy();
    });
  });
});
