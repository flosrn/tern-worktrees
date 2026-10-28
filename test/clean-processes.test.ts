import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { identityOf, processSnapshot } from '../src/clean-processes.ts';
import { applyResources, planResources } from '../src/clean-resources.ts';
import type { ResourcePlan } from '../src/clean-resources.ts';
import { run } from '../src/proc.ts';
import { ls, processOf } from '../src/tern.ts';
import { resourceFixture } from './clean-resource-fixture.ts';
import type { ResourceFixture } from './clean-resource-fixture.ts';

vi.mock(import('../src/proc.ts'));
vi.mock(import('../src/tern.ts'));

const START = 'Wed Oct 28 12:00:00 2026';
const NOW = Date.UTC(2026, 9, 28, 12, 0, 1, 999);
const WORKTREE = '/repo/remove';
const row = (pid: number, command = 'node worker.js', parent = 1, group = pid, start = START, uid = 501): string => `${pid} ${parent} ${group} ${uid} ${start} ${command}`;
const cwd = (pid: number, directory = WORKTREE): string => `p${pid}\0\nfcwd\0n${directory}\0\n`;
const emptyPlan = (): ResourcePlan => ({ containers: [], keep: [], paths: [], processes: [], protectedWorktrees: [], warnings: [] });

describe('macOS process inspection', () => {
  let f: ResourceFixture;
  let ps: string;
  let lsof: string;
  let psStatus: number;
  let lsofStatus: number;
  let psError: string;
  let lsofError: string;

  beforeEach(() => {
    f = resourceFixture();
    vi.stubEnv('TERN_WT_PROC_ROOT', '');
    vi.stubGlobal('process', { ...process, getuid: () => 501, platform: 'darwin' });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    ps = row(920_001);
    lsof = cwd(920_001);
    psStatus = 0;
    lsofStatus = 0;
    psError = '';
    lsofError = '';
    vi.mocked(run).mockImplementation(async argv => {
      f.state.calls.push(argv);
      await Promise.resolve();
      if (argv[0] === 'ps') {
        return { status: psStatus, stderr: psError, stdout: ps };
      }
      if (argv[0] === 'lsof') {
        return { status: lsofStatus, stderr: lsofError, stdout: lsof };
      }
      return { status: 0, stderr: '', stdout: '' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('macOS process snapshots', () => {
    it('samples all owned cwd records and ancestry with one command each, without signalling', async () => {
      ps = `  ${row(920_001, 'node   worker.js', 42, 77)}  \n`;
      lsof = cwd(920_001, '/repo/remove/with spaces');
      const plan = emptyPlan();
      await expect(processSnapshot(f.ctx, plan)).resolves.toStrictEqual([
        { command: 'node worker.js', cwd: '/repo/remove/with spaces', group: 77, parent: 42, pid: 920_001, start: START },
      ]);
      expect(f.state.calls).toStrictEqual([
        ['ps', '-ww', '-x', '-U', '501', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,args='],
        ['lsof', '-nP', '-a', '-u', '501', '-d', 'cwd', '-F0pfn'],
      ]);
      expect(vi.mocked(run)).toHaveBeenCalledWith(f.state.calls[0], { env: { LC_ALL: 'C', TZ: 'UTC' } });
      expect(plan).toStrictEqual(emptyPlan());
      expect(f.kill).not.toHaveBeenCalled();
    });

    it('starts both host inspections before awaiting either command', async () => {
      const invoked: string[] = [];
      vi.mocked(run).mockImplementation(async argv => {
        invoked.push(argv[0] ?? '');
        await Promise.resolve();
        expect(invoked).toStrictEqual(['ps', 'lsof']);
        return { status: 0, stderr: '', stdout: argv[0] === 'ps' ? ps : lsof };
      });
      await expect(processSnapshot(f.ctx, emptyPlan())).resolves.toHaveLength(1);
    });

    it.each([1, 127])('protects every worktree when lsof exits with %s, ignoring partial cwd output', async status => {
      lsofStatus = status;
      lsofError = 'permission denied';
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(f.ctx.worktrees);
      expect(plan.warnings).toStrictEqual([`Cannot inspect process cwd with lsof (exit ${status}): permission denied; worktree process ownership cannot be proven.`]);
      expect(plan.keep.filter(item => item.kind === 'worktree').every(item => item.reason.includes('lsof'))).toBeTruthy();
      expect(f.kill).not.toHaveBeenCalled();
    });

    it('explains lsof failure even when the command supplies no error text', async () => {
      lsofStatus = 127;
      const plan = emptyPlan();
      await expect(processSnapshot(f.ctx, plan)).resolves.toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Cannot inspect process cwd with lsof (exit 127); worktree process ownership cannot be proven.']);
      expect(plan.protectedWorktrees).toStrictEqual(f.ctx.worktrees);
    });

    it('treats lsof warnings as incomplete inspection even with a successful exit', async () => {
      lsofError = '  cannot inspect a volume\n';
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(f.ctx.worktrees);
      expect(plan.warnings[0]).toContain('cannot inspect a volume');
    });

    it('protects every worktree on ps failure without accepting partial rows', async () => {
      psStatus = 1;
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(f.ctx.worktrees);
      expect(plan.warnings).toStrictEqual(['Cannot inspect processes; worktree process ownership cannot be proven.']);
    });

    it('does not invoke host commands without an owned user identity', async () => {
      const host = { ...process };
      Reflect.deleteProperty(host, 'getuid');
      vi.stubGlobal('process', host);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(f.ctx.worktrees);
      expect(plan.warnings[0]).toContain('current user');
      expect(f.state.calls.some(argv => ['ps', 'lsof'].includes(argv[0] ?? ''))).toBeFalsy();
      await expect(identityOf(920_001)).rejects.toThrow('current user');
    });

    it('accepts an empty successful snapshot without inventing worktree ownership', async () => {
      ps = '';
      lsof = '';
      const plan = emptyPlan();
      await expect(processSnapshot(f.ctx, plan)).resolves.toStrictEqual([]);
      expect(plan).toStrictEqual(emptyPlan());
    });
  });

  describe('macOS process ownership evidence', () => {
    it.each(['0', '-1', '1.5', '9007199254740992', 'not-a-pid'])('ignores invalid process and lsof PID %s', async invalid => {
      ps += `\n${invalid} 1 1 501 ${START} worker`;
      lsof += `p${invalid}\0\nfcwd\0n/repo/live\0\n`;
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([920_001]);
      expect(plan.warnings).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
    });

    it('excludes other users even if lsof reports a matching cwd', async () => {
      ps = row(920_001, 'worker', 1, 920_001, START, 502);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.keep).toStrictEqual([]);
    });

    it.each(['ps -ww -x -U 501', '/bin/ps -ww -x -p 920001', '/usr/sbin/lsof -nP -a -u 501'])('ignores transient inspector %s', async command => {
      ps = row(920_001, command);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it.each(['myps -ww -x -U 501', 'mylsof -nP -a -u 501'])('does not exclude an unrelated command named %s', async command => {
      ps = row(920_001, command);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([{ command, cwd: WORKTREE, pid: 920_001 }]);
    });

    it('does not associate open source files or unrelated cwd records with a worktree', async () => {
      lsof = 'n/repo/remove\0\np920001\0\nftxt\0n/repo/remove/source.ts\0\nfcwd\0n/other\0\np920002\0\nfcwd\0n/repo/live\0\n';
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.keep).toStrictEqual([]);
    });

    it.each(['', 'relative/path', '/repo/remove (deleted)'])('preserves a PID whose cwd cannot be proven: %s', async directory => {
      lsof = directory === '' ? 'p920001\0\nfcwd\0\n' : cwd(920_001, directory);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.keep).toContainEqual({ id: '920001', kind: 'process', reason: 'Process inspection incomplete: 920001 (node worker.js); process preserved.' });
      expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 920001 (node worker.js).']);
    });

    it.each([
      { command: '', group: 920_001, parent: 1, start: START },
      { command: 'worker', group: 0, parent: 1, start: START },
      { command: 'worker', group: 1.5, parent: 1, start: START },
      { command: 'worker', group: 920_001, parent: -1, start: START },
      { command: 'worker', group: 920_001, parent: 1.5, start: START },
      { command: 'worker', group: 920_001, parent: 1, start: 'Wed Oct 28 99:00:00 2026' },
      { command: 'worker', group: 920_001, parent: 1, start: 'Wed Oct 28 12:00:01 2026' },
      { command: 'worker', group: 920_001, parent: 1, start: 'Wed Oct 28 12:00:02 2026' },
    ])('protects only the known cwd for an incomplete or too recent identity: %j', async entry => {
      ps = row(920_001, entry.command, entry.parent, entry.group, entry.start);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([WORKTREE]);
      expect(plan.warnings).toHaveLength(1);
    });

    it('accepts a root parent but never treats a sibling-prefix cwd as a worktree', async () => {
      ps = row(920_001, 'omp', 0);
      lsof = cwd(920_001, '/repo/remove-other');
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
    });
  });

  describe('macOS process protection rules', () => {
    it('reuses Linux caller, ancestor, omp descendant, infrastructure and browser protections', async () => {
      const entries = [
        row(process.pid, 'node clean', process.ppid),
        row(process.ppid, 'bash', 920_010),
        row(920_010, 'bash'),
        row(920_011, 'omp'),
        row(920_013, 'node child', 920_012),
        row(920_012, 'node child', 920_011),
        row(920_014, 'tern-daemon'),
        row(920_015, 'dockerd'),
        row(920_016, 'chrome_crashpad_handler'),
        row(920_017, 'node orphan'),
        row(920_018, 'node busy', 88),
      ];
      ps = entries.join('\n');
      lsof = [process.pid, process.ppid, 920_010, 920_011, 920_012, 920_013, 920_014, 920_015, 920_016, 920_017, 920_018].map(pid => cwd(pid)).join('');
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([920_017, 920_018]);
      expect(plan.protectedWorktrees).toStrictEqual([WORKTREE]);
      expect(plan.keep.filter(item => item.kind === 'process')).toHaveLength(9);
      expect(f.kill).not.toHaveBeenCalled();
    });

    it('protects busy Tern groups and descendants while allowing the idle shell of a removed worktree', async () => {
      ps = [row(920_001, 'bash'), row(920_002, 'node', 920_001), row(920_003, 'node', 1, 920_001), row(920_004, 'bash')].join('\n');
      lsof = [920_001, 920_002, 920_003, 920_004].map(pid => cwd(pid)).join('');
      vi.mocked(ls).mockResolvedValue({
        sessions: [
          {
            id: 1,
            name: 'repo',
            tabs: [
              {
                blocks: [
                  { cwd: WORKTREE, id: 1, title: 'busy' },
                  { cwd: WORKTREE, id: 2, title: 'idle' },
                ],
                id: 1,
                name: 'work',
              },
            ],
          },
        ],
      });
      vi.mocked(processOf).mockImplementation(async block => {
        await Promise.resolve();
        const shell = { argv: [], cwd: WORKTREE, name: 'bash', pid: block === 1 ? 920_001 : 920_004 };
        return { child: shell, foreground: block === 1 ? { argv: [], cwd: WORKTREE, name: 'node', pid: 920_002 } : shell, group: shell.pid, pane: 1 };
      });
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([920_004]);
      expect(plan.protectedWorktrees).toStrictEqual([WORKTREE]);
    });
  });

  describe('macOS targeted process identity', () => {
    it('re-reads a single owned PID with targeted ps and lsof selections', async () => {
      await expect(identityOf(920_001)).resolves.toStrictEqual({ command: 'node worker.js', cwd: WORKTREE, group: 920_001, parent: 1, pid: 920_001, start: START });
      expect(f.state.calls).toStrictEqual([
        ['ps', '-ww', '-x', '-p', '920001', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,args='],
        ['lsof', '-nP', '-a', '-u', '501', '-d', 'cwd', '-F0pfn', '-p', '920001'],
      ]);
    });

    it('does not accept a different PID from a targeted identity query', async () => {
      ps = row(920_002);
      lsof = cwd(920_002);
      await expect(identityOf(920_001)).rejects.toThrow('Cannot prove owned process identity');
    });

    it.each(['ps-failed', 'lsof-failed', 'cwd-missing', 'malformed'])('rejects a targeted inspection that is %s rather than reporting a false exit', async failure => {
      if (failure === 'ps-failed') {
        psStatus = 1;
      } else if (failure === 'lsof-failed') {
        lsofStatus = 1;
      } else if (failure === 'cwd-missing') {
        lsof = '';
      } else {
        ps = row(920_001, 'worker', 1, 0);
      }
      await expect(identityOf(920_001)).rejects.toThrow(/Cannot inspect|Process inspection incomplete/u);
    });
  });

  describe('macOS signal safety', () => {
    it('never signals a reused PID with the same command and cwd but a different start second', async () => {
      const plan = await planResources(f.ctx);
      vi.mocked(Date.now).mockReturnValue(NOW + 1000);
      ps = row(920_001, 'node worker.js', 1, 920_001, 'Wed Oct 28 12:00:01 2026');
      const result = await applyResources(plan, plan.warnings);
      expect(f.kill).not.toHaveBeenCalled();
      expect(result.failedProcesses).toStrictEqual([920_001]);
      expect(plan.warnings).toContain('Preserved process 920001: identity or cwd changed.');
    });

    it('does not select identities born in the sampling second, whose PID reuse would be indistinguishable', async () => {
      ps = row(920_001, 'node worker.js', 1, 920_001, 'Wed Oct 28 12:00:01 2026');
      const plan = await planResources(f.ctx);
      await applyResources(plan, plan.warnings);
      expect(f.kill).not.toHaveBeenCalled();
      expect(plan.protectedWorktrees).toStrictEqual([WORKTREE]);
    });

    it('does not escalate to KILL if the PID is reused after TERM', async () => {
      const plan = await planResources(f.ctx);
      f.kill.mockImplementation(() => {
        vi.mocked(Date.now).mockReturnValue(NOW + 1000);
        ps = row(920_001, 'node worker.js', 1, 920_001, 'Wed Oct 28 12:00:01 2026');
        return true;
      });
      const result = await applyResources(plan, plan.warnings);
      expect(f.kill.mock.calls).toStrictEqual([[920_001, 'SIGTERM']]);
      expect(result.failedProcesses).toStrictEqual([920_001]);
    });

    it('sends TERM and then KILL only after fresh matching identities', async () => {
      const plan = await planResources(f.ctx);
      f.kill.mockImplementation((_pid, signal) => {
        if (signal === 'SIGKILL') {
          ps = '';
          lsof = '';
        }
        return true;
      });
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [] });
      expect(f.kill.mock.calls).toStrictEqual([
        [920_001, 'SIGTERM'],
        [920_001, 'SIGKILL'],
      ]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('never signals when cwd inspection becomes unavailable after planning', async () => {
      const plan = await planResources(f.ctx);
      lsofStatus = 127;
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [920_001] });
      expect(f.kill).not.toHaveBeenCalled();
      expect(plan.warnings.join(' ')).toContain('lsof');
    });

    it.each(['cwd', 'command'])('never signals after the planned %s changes', async changed => {
      const plan = await planResources(f.ctx);
      if (changed === 'cwd') {
        lsof = cwd(920_001, '/repo/live');
      } else {
        ps = row(920_001, 'omp');
      }
      const result = await applyResources(plan, plan.warnings);
      expect(f.kill).not.toHaveBeenCalled();
      expect(result.failedProcesses).toStrictEqual([920_001]);
    });
  });

  describe('macOS incomplete and vanished processes', () => {
    it('does not mistake a cwd lsof row without an owning PID for evidence', async () => {
      lsof = 'fcwd\0n/repo/remove\0\n';
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.warnings).toHaveLength(1);
    });

    it('keeps inspection uncertainty outside worktrees from protecting them', async () => {
      ps = row(920_001, 'worker', -1);
      lsof = cwd(920_001, '/other');
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.keep.filter(item => item.kind === 'process')).toHaveLength(1);
    });

    it('uses the inspection start time even if the command finishes in the next second', async () => {
      ps = row(920_001, 'worker', 1, 920_001, 'Wed Oct 28 12:00:01 2026');
      vi.mocked(run).mockImplementation(async argv => {
        vi.mocked(Date.now).mockReturnValue(NOW + 1000);
        await Promise.resolve();
        return { status: 0, stderr: '', stdout: argv[0] === 'ps' ? ps : lsof };
      });
      const plan = emptyPlan();
      await expect(processSnapshot(f.ctx, plan)).resolves.toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([WORKTREE]);
    });

    it.each([0, 1])('recognizes a disappeared PID when ps exits %s with no row, even if lsof finds nothing', async status => {
      ps = '';
      psStatus = status;
      lsofStatus = 1;
      lsof = '';
      await expect(identityOf(920_001)).resolves.toBeNull();
    });

    it('does not treat a targeted ps error with an empty row as a process exit', async () => {
      ps = '';
      psStatus = 127;
      await expect(identityOf(920_001)).rejects.toThrow('Cannot inspect processes');
    });

    it('preserves a PID whose owner changed instead of declaring it exited', async () => {
      ps = row(920_001, 'worker', 1, 920_001, START, 502);
      await expect(identityOf(920_001)).rejects.toThrow('Cannot prove owned process identity');
    });

    it('preserves a process when cwd inspection fails after TERM', async () => {
      const plan = await planResources(f.ctx);
      f.kill.mockImplementation(() => {
        lsofStatus = 127;
        return true;
      });
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [920_001] });
      expect(f.kill.mock.calls).toStrictEqual([[920_001, 'SIGTERM']]);
      expect(plan.warnings.join(' ')).toContain('lsof');
    });

    it('rejects a targeted empty ps result carrying an error diagnostic', async () => {
      ps = '';
      psError = 'permission denied';
      await expect(identityOf(920_001)).rejects.toThrow('Cannot prove owned process identity');
    });
  });

  describe('macOS cwd paths and ownership boundaries', () => {
    it.each([
      { directory: '/repo/remove/with spaces', encoded: '/repo/remove/with spaces' },
      { directory: '/repo/remove/é', encoded: String.raw`/repo/remove/\xc3\xa9` },
      { directory: '/repo/remove/back\\slash', encoded: String.raw`/repo/remove/back\\slash` },
      { directory: '/repo/remove/line\nnext\tcolumn\rreturn\bback\fform', encoded: String.raw`/repo/remove/line\nnext\tcolumn\rreturn\bback\fform` },
      { directory: '/repo/remove/literal\\n', encoded: String.raw`/repo/remove/literal\\n` },
    ])('reads escaped cwd names without confusing path bytes: $encoded', async entry => {
      lsof = cwd(920_001, entry.encoded);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([{ command: 'node worker.js', cwd: entry.directory, pid: 920_001 }]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('keeps a non-orphan repository worker and ignores unrelated orphans', async () => {
      ps = [row(920_001, 'node worker.js', 99), row(920_002), row(920_003, 'node worker.js', 88)].join('\n');
      lsof = cwd(920_001, '/repo/main') + cwd(920_002, '/other') + cwd(920_003, '/repo/live');
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.keep.filter(item => item.kind === 'process').map(item => item.id)).toStrictEqual(['920001', '920003']);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/live']);
    });

    it('preserves the owned snapshot when Tern session ownership is unavailable', async () => {
      vi.mocked(ls).mockRejectedValue(new Error('offline'));
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(f.ctx.worktrees);
      expect(plan.warnings).toStrictEqual(['Cannot prove live Tern session ownership; processes are preserved.']);
    });

    it('preserves a recently started targeted identity instead of treating it as exited', async () => {
      ps = row(920_001, 'node worker.js', 1, 920_001, 'Wed Oct 28 12:00:01 2026');
      await expect(identityOf(920_001)).rejects.toThrow('Process inspection incomplete');
    });

    it('does not inherit the preceding PID cwd descriptor', async () => {
      ps += `\n${row(920_002)}`;
      lsof += 'p920002\0n/repo/live\0\n';
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([920_001]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 920002 (node worker.js).']);
    });

    it('selects only the requested identity from multiple targeted rows', async () => {
      ps = `${row(920_002)}\n${row(920_001)}`;
      lsof = cwd(920_002, '/other') + cwd(920_001);
      await expect(identityOf(920_001)).resolves.toStrictEqual({ command: 'node worker.js', cwd: WORKTREE, group: 920_001, parent: 1, pid: 920_001, start: START });
    });
  });
});
