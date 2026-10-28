import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyResources, planResources } from '../src/clean-resources.ts';
import { run } from '../src/proc.ts';
import { processOf } from '../src/tern.ts';
import { dockerContainer, resourceFixture } from './clean-resource-fixture.ts';
import type { ResourceFixture } from './clean-resource-fixture.ts';

vi.mock(import('../src/proc.ts'));
vi.mock(import('../src/tern.ts'));
vi.mock(import('node:fs/promises'), { spy: true });

const REMOVED_WORKTREE = '/repo/remove';
describe('resource mutation safety', () => {
  let f: ResourceFixture;
  beforeEach(() => {
    f = resourceFixture();
  });
  afterEach(() => {
    vi.mocked(readdir).mockReset();
    vi.mocked(lstat).mockReset();
    vi.mocked(readlink).mockReset();
    vi.mocked(stat).mockReset();
    vi.mocked(readFile).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('process inspection safety', () => {
    it('requests the owned process table with the required columns', async () => {
      f.entry(910_001);
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      const plan = await planResources(f.ctx);
      expect(plan.processes).toHaveLength(1);
      expect(f.state.calls[0]).toStrictEqual(['ps', '-u', String(process.getuid?.()), '-o', 'pid=,ppid=,pgid=,args=']);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('requests an empty user selector if the host has no uid API', async () => {
      f.entry(910_001);
      const host = { ...process };
      Reflect.deleteProperty(host, 'getuid');
      vi.stubGlobal('process', host);
      const plan = await planResources(f.ctx);
      expect(f.state.calls[0]).toStrictEqual(['ps', '-u', '', '-o', 'pid=,ppid=,pgid=,args=']);
      expect(plan.processes).toStrictEqual([]);
    });

    it.each(['prefix123', '123suffix'])('does not inspect ps when proc contains only %s', async name => {
      mkdirSync(path.join(f.root, name));
      await planResources(f.ctx);
      expect(f.state.calls.some(argv => argv[0] === 'ps')).toBeFalsy();
    });

    it('normalizes padded stat fields and null-terminated argv', async () => {
      const dir = f.entry(910_002);
      const rawStat = readFileSync(path.join(dir, 'stat'), 'utf-8');
      writeFileSync(path.join(dir, 'stat'), `${rawStat.replace(') ', ')   ').replaceAll(' ', '  ')}  \n`);
      writeFileSync(path.join(dir, 'cmdline'), '\0node\0worker.js\0');
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([{ command: 'node worker.js', cwd: REMOVED_WORKTREE, pid: 910_002 }]);
    });

    it.each(['missing-start', 'relative-cwd', 'deleted-cwd'])('rejects a single %s identity', async invalid => {
      const suffix = invalid === 'deleted-cwd' ? ' (deleted)' : '';
      const cwd = invalid === 'relative-cwd' ? 'relative' : `/repo/remove${suffix}`;
      const dir = f.entry(910_003, cwd);
      if (invalid === 'missing-start') {
        writeFileSync(path.join(dir, 'stat'), '910003 (worker) S 1 910003');
      }
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 910003 (worker).']);
    });

    it('ignores a vanished ps identity without freezing unrelated worktrees', async () => {
      f.entry(910_004);
      f.state.ids.push(910_005);
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([910_004]);
    });

    it('keeps an unreadable cwd PID and command without freezing unrelated worktrees', async () => {
      f.entry(910_004);
      vi.mocked(readlink).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 910004 (worker).']);
      expect(plan.keep).toContainEqual({ id: '910004', kind: 'process', reason: 'Process inspection incomplete: 910004 (worker); process preserved.' });
      expect(plan.processes).toStrictEqual([]);
    });

    it('protects only a known cwd when its process identity is incomplete', async () => {
      const dir = f.entry(910_006);
      rmSync(path.join(dir, 'stat'));
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual([REMOVED_WORKTREE]);
      expect(plan.keep).toContainEqual({ id: REMOVED_WORKTREE, kind: 'worktree', reason: 'Process inspection incomplete: 910006 (worker); process preserved.' });
    });

    it.each([Object.assign(new Error('denied'), { code: 'EACCES' }), 'denied'])('keeps a PID when its process directory cannot be inspected: %s', async failure => {
      f.entry(910_030);
      vi.mocked(stat).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 910030 (worker).']);
    });

    it('ignores a process that disappears while its cwd is being inspected', async () => {
      const dir = f.entry(910_031);
      vi.mocked(readlink).mockImplementationOnce(async () => {
        rmSync(dir, { recursive: true });
        await Promise.resolve();
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      });
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.keep).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('reports ps failure without accepting its partial stdout', async () => {
      f.entry(910_006);
      f.state.psStatus = 1;
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Cannot inspect processes; worktree process ownership cannot be proven.']);
    });

    it.each(['ps -u 501', '/usr/bin/ps -u 501', '/ps  -u 501', 'ps  -u 501'])('excludes the transient inspector %s', async command => {
      f.entry(910_007, REMOVED_WORKTREE, command);
      f.state.ps = `  910007   1 910007 ${command}`;
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it.each(['myps -u 501', 'ps -u501'])('does not mistake %s for the inspector', async command => {
      f.entry(910_008, REMOVED_WORKTREE, command);
      f.state.ps = `  910008   1 910008 ${command}`;
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([910_008]);
    });

    it.each(['0', '-1', '1.5', '9007199254740992', 'not-a-pid'])('ignores invalid PID %s without an ownership warning', async value => {
      f.entry(910_009);
      f.state.ps = `  910009   1 910009 worker\n${value} 1 1 bad`;
      const plan = await planResources(f.ctx);
      expect(plan.warnings).toStrictEqual([]);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([910_009]);
    });
  });

  describe('process ancestry protection', () => {
    it.each(['env tern', 'docker', 'containerd', 'containerd-shim-runc-v2', '/usr/bin/sshd', 'env rootlesskit'])('preserves infrastructure command %s', async command => {
      f.entry(910_010, REMOVED_WORKTREE, command);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.keep.some(item => item.kind === 'process')).toBeTruthy();
    });

    it('protects omp descendants even when proc order is reverse ancestry', async () => {
      f.entry(910_013, REMOVED_WORKTREE, 'worker', 910_012);
      f.entry(910_012, REMOVED_WORKTREE, 'worker', 910_011);
      f.entry(910_011, '/repo/live', 'omp');
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
    });

    it('protects cwd of omp without a repository child', async () => {
      f.entry(910_014, '/repo/live', 'omp');
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/live']);
    });

    it('protects the caller cwd even when its proc identity is absent', async () => {
      f.ctx.worktrees = [process.cwd()];
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual([process.cwd()]);
    });

    it('does not recurse forever through cyclic caller ancestry', async () => {
      f.entry(process.pid, REMOVED_WORKTREE, 'node', process.ppid);
      f.entry(process.ppid, '/repo/live', 'bash', process.pid);
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual([REMOVED_WORKTREE, '/repo/live']);
    });

    it.each(['systemd  --user', 'systemd --user --quiet'])('recognizes orphan adopted by %s', async command => {
      f.entry(910_015, '/other', command);
      f.entry(910_016, '/repo/main', 'worker', 910_015);
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([910_016]);
    });

    it('protects the caller parent even if the caller is missing from proc', async () => {
      f.entry(process.ppid);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
    });

    it('protects caller descendants without a Tern block', async () => {
      f.entry(910_017, REMOVED_WORKTREE, 'worker', process.pid);
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
    });
  });

  describe('Tern ownership protection', () => {
    it('keeps idle blocks live for Testcontainers but does not mark them busy', async () => {
      f.block(REMOVED_WORKTREE);
      f.state.containers = [dockerContainer('idle-owner', [REMOVED_WORKTREE, '/external'], { 'org.testcontainers': 'true', 'org.testcontainers.sessionId': 's' })];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual([]);
      expect(plan.keep).toStrictEqual([{ id: 'idle-owner', kind: 'container', reason: 'Testcontainers session termination cannot be proven.' }]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('protects a busy child cwd when the block and foreground have no cwd', async () => {
      f.block(null);
      vi.mocked(processOf).mockResolvedValue({
        child: { argv: [], cwd: '/repo/live', name: 'bash', pid: 910_018 },
        foreground: { argv: [], cwd: null, name: 'node', pid: 910_019 },
        group: null,
        pane: 1,
      });
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/live']);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('protects a null-cwd idle block child outside the removed roots', async () => {
      f.entry(910_020, '/repo/main', 'bash');
      f.block(null);
      const shell = { argv: [], cwd: '/repo/main', name: 'bash', pid: 910_020 };
      vi.mocked(processOf).mockResolvedValue({ child: shell, foreground: shell, group: null, pane: 1 });
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('uses the host proc root on Linux when the override is unset', async () => {
      vi.stubEnv('TERN_WT_PROC_ROOT', '');
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      vi.mocked(readdir).mockRejectedValueOnce(new Error('unavailable'));
      await planResources(f.ctx);
      expect(readdir).toHaveBeenCalledWith('/proc');
    });

    it('protects the caller ancestor cwd even when its process is outside all roots', async () => {
      f.entry(process.pid, '/outside', 'node', process.ppid);
      f.entry(process.ppid, '/repo/live', 'bash');
      const plan = await planResources(f.ctx);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/live']);
    });

    it('keeps a foreground-only busy process without treating its absent child as an inspection failure', async () => {
      f.block(null);
      vi.mocked(processOf).mockResolvedValue({ child: null, foreground: { argv: [], cwd: '/repo/live', name: 'node', pid: 910_021 }, group: null, pane: 1 });
      const plan = await planResources(f.ctx);
      expect(plan.warnings).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/live']);
    });

    it('does not look up a prunable directory when none was supplied', async () => {
      const plan = await planResources(f.ctx);
      expect(plan.paths).toStrictEqual([]);
      expect(lstat).not.toHaveBeenCalled();
    });

    it('does not confuse an embedded infrastructure name with a shared daemon', async () => {
      f.entry(910_022, REMOVED_WORKTREE, 'mytern');
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([910_022]);
    });

    it('keeps an idle block process outside the removal selection', async () => {
      f.entry(910_023, '/repo/main', 'bash');
      f.block('/repo/main');
      const shell = { argv: [], cwd: '/repo/main', name: 'bash', pid: 910_023 };
      vi.mocked(processOf).mockResolvedValue({ child: shell, foreground: shell, group: null, pane: 1 });
      const plan = await planResources(f.ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('does not preserve an unrelated process whose name only contains an infrastructure suffix', async () => {
      f.entry(910_024, REMOVED_WORKTREE, 'mycontainerd-shim-worker');
      const plan = await planResources(f.ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([910_024]);
      expect(f.kill).not.toHaveBeenCalled();
    });
  });

  describe('Docker ownership evidence', () => {
    it('lists all full container identities and never inspects an empty list', async () => {
      await planResources(f.ctx);
      expect(f.state.calls).toStrictEqual([['docker', 'ps', '-aq', '--no-trunc']]);
    });

    it('rejects a failed listing even when stdout contains a valid container', async () => {
      f.state.containers = [dockerContainer('old')];
      f.state.listStatus = 1;
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual([]);
      expect(f.state.calls).toStrictEqual([['docker', 'ps', '-aq', '--no-trunc']]);
    });

    it('splits padded listings without passing empty IDs to Docker', async () => {
      f.state.containers = [dockerContainer('a'), dockerContainer('b')];
      f.state.dockerList = '  a  \n b \n';
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual(['a', 'b']);
      expect(f.state.calls[1]).toStrictEqual(['docker', 'inspect', 'a', 'b']);
    });

    it('ignores failed inspect output even when its JSON is valid', async () => {
      f.state.containers = [dockerContainer('old')];
      f.state.inspectStatus = 1;
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual([]);
    });

    it('rejects malformed inspect JSON without inventing a container', async () => {
      vi.mocked(run).mockResolvedValue({ status: 0, stderr: '', stdout: 'bad-json' });
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual([]);
    });

    it('accepts missing names and null labels when mounts prove exclusive ownership', async () => {
      f.state.containers = [{ Config: { Labels: null }, Id: 'nameless', Mounts: [{ Source: REMOVED_WORKTREE }] }];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual(['nameless']);
    });

    it.each<Record<string, string>>([{ 'tern-wt': 'shared' }, { 'tern-wt.owner': 'shared' }, { owner: 'tern-wt' }, { owner: '/service/tern-wt' }])(
      'preserves exact and dotted shared labels %j',
      async labels => {
        f.state.containers = [dockerContainer('shared', [REMOVED_WORKTREE], labels)];
        const plan = await planResources(f.ctx);
        expect(plan.containers).toStrictEqual([]);
      },
    );

    it('allows a non-shared name with an internal slash', async () => {
      f.state.containers = [{ ...dockerContainer('not-shared'), Name: 'tern/-wt-db' }];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual(['not-shared']);
    });
  });
  describe('Docker removal ownership', () => {
    it('requires a session id even if no owner or companion can be found', async () => {
      f.state.containers = [dockerContainer('no-session', [REMOVED_WORKTREE], { 'org.testcontainers': 'true' })];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual([]);
      expect(plan.keep).toStrictEqual([{ id: 'no-session', kind: 'container', reason: 'Testcontainers session termination cannot be proven.' }]);
    });

    it('ignores unrelated companions with another session or missing metadata', async () => {
      f.state.containers = [
        dockerContainer('ended', [REMOVED_WORKTREE], { 'org.testcontainers': 'true', 'org.testcontainers.sessionId': 's' }),
        dockerContainer('other', ['/outside'], { 'org.testcontainers.sessionId': 't' }),
        { Config: null, Id: 'no-config' },
        { Config: { Labels: null }, Id: 'no-labels' },
      ];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual(['ended']);
    });

    it('removes exclusive mounts with unrelated external volumes but preserves mixed live mounts', async () => {
      f.state.containers = [
        dockerContainer('external', [REMOVED_WORKTREE, '/var/cache']),
        dockerContainer('mixed', [REMOVED_WORKTREE, '/repo/live']),
        dockerContainer('main', ['/repo/main']),
      ];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual(['external']);
      expect(plan.keep).toStrictEqual(['mixed', 'main'].map(id => ({ id, kind: 'container', reason: 'Container is not exclusively tied to a removed worktree.' })));
    });

    it('preserves a container mounted in a protected removal worktree', async () => {
      f.entry(910_019, REMOVED_WORKTREE, 'omp');
      f.state.containers = [dockerContainer('protected')];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual([]);
    });

    it('rejects relative labels as ownership evidence', async () => {
      f.state.containers = [dockerContainer('relative', [REMOVED_WORKTREE], { owner: path.relative(process.cwd(), '/repo/live') })];
      const plan = await planResources(f.ctx);
      expect(plan.containers).toStrictEqual(['relative']);
    });

    it('never removes a container absent from planning', async () => {
      f.state.containers = [dockerContainer('unplanned')];
      const warnings: string[] = [];
      await applyResources({ containers: ['unplanned'], paths: [], processes: [] }, warnings);
      expect(warnings).toStrictEqual(['Preserved container unplanned: identity or ownership changed.']);
      expect(f.state.calls.some(argv => argv[1] === 'rm')).toBeFalsy();
    });

    it('reports Docker failures with a trimmed diagnostic', async () => {
      f.state.containers = [dockerContainer('failed')];
      const plan = await planResources(f.ctx);
      f.state.rmStatus = 1;
      f.state.stderr = '  permission denied\n';
      await applyResources(plan, plan.warnings);
      expect(plan.warnings).toStrictEqual(['Cannot remove container failed: permission denied']);
    });
  });
});
