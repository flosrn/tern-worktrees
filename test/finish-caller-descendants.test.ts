import path from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ProcessIdentity } from '../src/clean-processes.ts';
import type { FinishPlan } from '../src/finish-types.ts';
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
import { useSandbox, writeTernListing, writeTernLs } from './helpers.ts';

const descendant = (pid: number, parent: number, cwd: string, command: string): ProcessIdentity => ({ ...identity(pid, cwd, command), parent });
const observe = (processes: ProcessIdentity[], before = ''): void => {
  for (const entry of processes) {
    writeProcess(entry);
  }
  sampleProcesses(processes, before);
};
const planCurrent = async (dir: string, target: string, caller: ProcessIdentity): Promise<FinishPlan> =>
  await planned('--repo', dir, '--current', target, '--pid', String(caller.pid), '--block', '1');
const outcome = (plan: FinishPlan, target: string) => ({
  candidates: plan.candidates.map(candidate => candidate.path),
  code: plan.keep.find(item => item.path === target)?.code ?? null,
  ready: plan.ready,
});

describe('background descendants of the pinned caller', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['child', 'grandchild'] as const)('plans the current worktree when a background %s of the caller holds it', async relation => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, target);
    const chain =
      relation === 'child'
        ? [descendant(90_002, caller.pid, target, 'omp __omp_worker_daemon_broker')]
        : [descendant(90_002, caller.pid, dir, 'bun eval-runner.ts'), descendant(90_003, 90_002, target, 'python3 -m kernel')];
    observe([caller, ...chain]);
    writeTernLs({ aoyama: [target] });
    writeTerminal(1, null, terminalProcess(caller));
    const plan = await planCurrent(dir, target, caller);
    expect(outcome(plan, target)).toStrictEqual({ candidates: [target], code: null, ready: true });
    expectPreserved(target, log);
  });

  it.each(['a missing link', 'PID 1', 'a cycle'] as const)('keeps the current worktree when the ancestry ends at %s', async ending => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, target);
    const chains = {
      'PID 1': [descendant(90_002, 1, target, 'node worker.js')],
      'a cycle': [descendant(90_002, 90_003, target, 'node worker.js'), descendant(90_003, 90_002, dir, 'node supervisor.js')],
      'a missing link': [descendant(90_002, 90_003, target, 'node worker.js'), descendant(90_003, caller.pid, dir, 'node supervisor.js')],
    };
    observe([caller, ...chains[ending]]);
    if (ending === 'a missing link') {
      rmSync(path.join(processDirectory(90_003), 'stat'));
    }
    const plan = await planCurrent(dir, target, caller);
    expect(outcome(plan, target)).toStrictEqual({ candidates: [], code: 'active_process', ready: false });
    expectPreserved(target, log);
  });

  it.each(['start', 'command'] as const)('does not exempt children of a process whose PID matches the caller but whose %s differs', async changed => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, dir);
    const rewrite =
      changed === 'start'
        ? `printf '%s' '${statLine({ ...caller, start: '200' })}' > '${processDirectory(caller.pid)}/stat'`
        : `printf '%s' 'omp --resumed' > '${processDirectory(caller.pid)}/cmdline'`;
    observe([caller, descendant(90_002, caller.pid, target, 'omp __omp_worker_daemon_broker')], rewrite);
    const plan = await planCurrent(dir, target, caller);
    expect(outcome(plan, target)).toStrictEqual({ candidates: [], code: 'active_process', ready: false });
    expectPreserved(target, log);
  });

  it.each(['the busy terminal command', 'a process under the busy terminal command'] as const)('keeps the current worktree for %s started by the caller', async holder => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, target);
    const command = descendant(90_002, caller.pid, holder === 'the busy terminal command' ? target : dir, 'node agent.js');
    observe([caller, command, ...(holder === 'the busy terminal command' ? [] : [descendant(90_003, command.pid, target, 'node agent-worker.js')])]);
    writeTernLs({ aoyama: [target] });
    writeTerminal(1, terminalProcess(command, 'node'), terminalProcess(caller));
    const plan = await planCurrent(dir, target, caller);
    expect(outcome(plan, target)).toStrictEqual({ candidates: [], code: 'active_process', ready: false });
    expectPreserved(target, log);
  });

  it.each([
    { foreground: 'the caller', place: 'outside the target' },
    { foreground: 'the caller', place: 'without a directory' },
    { foreground: 'the command', place: 'outside the target' },
  ] as const)('keeps the current worktree for a busy terminal command when the caller block is $place and the foreground is $foreground', async ({ foreground, place }) => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, target);
    const command = descendant(90_002, caller.pid, target, 'node agent.js');
    observe([caller, command]);
    writeTernListing({
      sessions: [{ id: 1, name: 'aoyama', tabs: [{ blocks: [{ cwd: place === 'outside the target' ? dir : null, id: 1, title: 'omp' }], id: 1, name: 'tab' }] }],
    });
    const shell = terminalProcess(identity(90_000, dir, 'zsh -l'), 'zsh');
    writeTerminal(1, foreground === 'the caller' ? terminalProcess(command, 'node') : shell, terminalProcess(foreground === 'the caller' ? caller : command));
    const plan = await planCurrent(dir, target, caller);
    expect(outcome(plan, target)).toStrictEqual({ candidates: [], code: 'active_process', ready: false });
    expectPreserved(target, log);
  });

  it('plans the current worktree for a background child when the caller block is outside the target and has no command', async () => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, target);
    observe([caller, descendant(90_002, caller.pid, target, 'omp __omp_worker_daemon_broker')]);
    writeTernLs({ aoyama: [dir] });
    writeTerminal(1, null, terminalProcess(caller));
    const plan = await planCurrent(dir, target, caller);
    expect(outcome(plan, target)).toStrictEqual({ candidates: [target], code: null, ready: true });
    expectPreserved(target, log);
  });

  it('keeps an owned target that is not the current worktree when a caller descendant holds it', async () => {
    const { dir, log, target } = await delivered();
    const current = await addDelivered(dir, 'current', 8);
    const caller = identity(90_001, current);
    observe([caller, descendant(90_002, caller.pid, target, 'omp __omp_worker_daemon_broker')]);
    const plan = await planned('--repo', dir, '--current', current, '--owned', target, '--pid', String(caller.pid));
    expect(outcome(plan, target)).toStrictEqual({ candidates: [current], code: 'active_process', ready: true });
    expectPreserved(target, log);
  });

  it('plans an owned target that is not the current worktree while the caller terminal runs the caller', async () => {
    const { dir, log, target } = await delivered();
    const current = await addDelivered(dir, 'current', 8);
    const caller = identity(90_001, current);
    observe([caller]);
    writeTernLs({ aoyama: [current] });
    writeTerminal(1, null, terminalProcess(caller));
    const plan = await planned('--repo', dir, '--current', current, '--owned', target, '--pid', String(caller.pid), '--block', '1');
    expect({ candidates: plan.candidates.map(candidate => candidate.path).toSorted(), ready: plan.ready }).toStrictEqual({ candidates: [current, target].toSorted(), ready: true });
    expectPreserved(target, log);
  });

  it.each(['alone', 'beside a stale caller sample'] as const)('keeps an approved target when a former descendant still runs %s after the caller exits', async sample => {
    const { dir, log, target } = await delivered();
    const caller = identity(90_001, target);
    const broker = descendant(90_002, caller.pid, target, 'omp __omp_worker_daemon_broker');
    observe([caller, broker]);
    const plan = await planCurrent(dir, target, caller);
    expect(plan.ready).toBeTruthy();
    await arm(plan, [target]);
    rmSync(processDirectory(caller.pid), { recursive: true });
    if (sample === 'alone') {
      sampleProcesses([broker]);
    } else {
      const recreate = `mkdir -p '${processDirectory(caller.pid)}'\nln -s '${target}' '${processDirectory(caller.pid)}/cwd'\nprintf '%s' '${statLine(caller)}' > '${processDirectory(caller.pid)}/stat'\nprintf '%s' '${caller.command}' > '${processDirectory(caller.pid)}/cmdline'`;
      sampleProcesses([caller, broker], recreate);
    }
    const result = await executed(plan.id);
    expect(result).toMatchObject({ errors: [], removed: [], status: 'completed' });
    expect(result.keep).toContainEqual({ code: 'active_process', path: target });
    expectPreserved(target, log);
  });
});
