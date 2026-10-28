import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import timers from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyResources, planResources } from '../src/clean-resources.ts';
import type { ResourceContext } from '../src/clean-resources.ts';
import { run } from '../src/proc.ts';
import { ls, processOf } from '../src/tern.ts';
import { tempDir, useSandbox } from './helpers.ts';

vi.mock(import('../src/proc.ts'));
vi.mock(import('../src/tern.ts'));

let root: string;
let ctx: ResourceContext;
let ids: number[];
let containers: FakeContainer[];
let calls: string[][];
let dockerStatus: number;

interface FakeContainer {
  Config: { Labels: Record<string, string> };
  Id: string;
  Mounts: { Source: string }[];
  Name: string;
}

const processEntry = (pid: number, parent: number, cwd: string, command = 'node worker.js', start = '100', group = pid): void => {
  ids.push(pid);
  const dir = path.join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  rmSync(path.join(dir, 'cwd'), { force: true });
  symlinkSync(cwd, path.join(dir, 'cwd'));
  const fields = ['S', String(parent), String(group), ...Array.from({ length: 16 }, () => '0'), start];
  writeFileSync(path.join(dir, 'stat'), `${pid} (worker) ${fields.join(' ')}`);
  writeFileSync(path.join(dir, 'cmdline'), command.replaceAll(' ', '\0'));
};

const container = (id: string, name: string, source: string, labels: Record<string, string> = {}) => ({
  Config: { Labels: labels },
  Id: id,
  Mounts: [{ Source: source }],
  Name: name,
});

describe('repository resources', () => {
  beforeEach(() => {
    useSandbox();
    root = process.env.TERN_WT_PROC_ROOT ?? '';
    ctx = { removeWorktrees: ['/repo/wt/remove'], repo: '/repo/main', worktrees: ['/repo/wt/remove', '/repo/wt/live'] };
    ids = [];
    containers = [];
    calls = [];
    dockerStatus = 0;
    vi.spyOn(timers, 'setTimeout').mockResolvedValue(undefined);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(run).mockImplementation(async argv => {
      calls.push(argv);
      await Promise.resolve();
      if (argv[0] === 'ps') {
        return { status: 0, stderr: '', stdout: ids.map(pid => `${pid} 1 ${pid} worker`).join('\n') };
      }
      if (argv[1] === 'ps') {
        return { status: dockerStatus, stderr: '', stdout: containers.map(item => item.Id).join('\n') };
      }
      if (argv[1] === 'inspect') {
        return { status: 0, stderr: '', stdout: JSON.stringify(containers.filter(item => argv.includes(item.Id))) };
      }
      return { status: dockerStatus, stderr: 'docker failure', stdout: '' };
    });
    vi.mocked(ls).mockResolvedValue({ sessions: [] });
    vi.mocked(processOf).mockResolvedValue({ child: null, foreground: null, group: null, pane: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('process ownership', () => {
    it('excludes caller and every ancestor, preserving their worktrees', async () => {
      processEntry(process.pid, process.ppid, '/repo/wt/remove');
      processEntry(process.ppid, 900_001, '/repo/wt/live', 'bash');
      processEntry(900_001, 1, '/repo/main', 'bash');
      processEntry(900_002, 1, '/repo/main');
      const plan = await planResources(ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([900_002]);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/wt/remove', '/repo/wt/live']);
      expect(calls.every(argv => !['rm', 'kill'].includes(argv[1] ?? ''))).toBeTruthy();
    });

    it('preserves omp descendants, shared daemons and browser crash handlers', async () => {
      processEntry(900_010, 1, '/repo/wt/live', 'omp');
      processEntry(900_011, 900_010, '/repo/wt/remove');
      processEntry(900_012, 1, '/repo/main', 'rootlesskit');
      processEntry(900_013, 1, '/repo/main', 'chrome_crashpad_handler');
      processEntry(900_014, 1, '/repo/main', 'systemd --user');
      processEntry(900_015, 900_014, '/repo/main');
      const plan = await planResources(ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([900_015]);
      expect(plan.protectedWorktrees).toContain('/repo/wt/live');
      expect(plan.keep.filter(item => item.kind === 'process')).toHaveLength(5);
    });

    it('protects live block children, groups and descendants outside removed worktrees', async () => {
      processEntry(900_020, 1, '/repo/main');
      processEntry(900_021, 900_020, '/repo/wt/remove');
      processEntry(900_022, 1, '/repo/main', 'worker', '100', 42);
      processEntry(900_023, 99, '/repo/wt/remove');
      vi.mocked(ls).mockResolvedValue({
        sessions: [
          {
            id: 1,
            name: 'repo',
            tabs: [
              {
                blocks: [
                  { cwd: '/repo/main', id: 1, title: 'shell' },
                  { cwd: '/repo/wt/remove', id: 2, title: 'old' },
                ],
                id: 1,
                name: 'main',
              },
            ],
          },
        ],
      });
      vi.mocked(processOf).mockResolvedValue({ child: { argv: [], cwd: '/repo/main', name: 'node', pid: 900_020 }, foreground: null, group: 42, pane: 1 });
      const plan = await planResources(ctx);
      expect(plan.processes.map(item => item.pid)).toStrictEqual([900_023]);
    });

    it('preserves uncertain processes when Tern cannot be sampled', async () => {
      processEntry(900_030, 1, '/repo/main');
      vi.mocked(ls).mockRejectedValue(new Error('offline'));
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toStrictEqual(['Cannot prove live Tern session ownership; processes are preserved.']);
      expect(plan.keep).toContainEqual({ id: '900030', kind: 'process', reason: 'Process 900030 (node worker.js): Live session ownership is uncertain.' });
    });

    it('ignores unrelated processes and preserves non-orphan repository workers', async () => {
      processEntry(900_040, 99, '/repo/main');
      processEntry(900_041, 1, '/other');
      ids.push(900_042);
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.keep.map(item => item.id)).toStrictEqual(['900040']);
    });

    it('preserves processes when ps is unavailable', async () => {
      processEntry(900_045, 1, '/repo/main');
      vi.mocked(run).mockResolvedValue({ status: 127, stderr: '', stdout: '' });
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toHaveLength(1);
    });
  });

  describe('container ownership', () => {
    it('excludes shared containers and keeps unproven test sessions and unrelated databases', async () => {
      containers = [
        container('shared', '/tern-wt-db', ctx.removeWorktrees[0] ?? ''),
        container('label', '/db', '/repo/wt/remove', { 'com.docker.compose.project': 'tern-wt-services' }),
        container('test', '/test', '/repo/wt/remove', { 'org.testcontainers': 'true' }),
        container('unrelated', '/mongo', '/unrelated/webhook-roll'),
        container('main', '/main', '/repo/main'),
        container('old', '/old', '/repo/wt/remove'),
      ];
      const plan = await planResources(ctx);
      expect(plan.containers).toStrictEqual(['old']);
      expect(plan.keep.map(item => item.id)).toStrictEqual(['test', 'main']);
      expect(calls.some(argv => argv[1] === 'rm')).toBeFalsy();
      await applyResources(plan, plan.warnings);
      expect(calls.filter(argv => argv[1] === 'rm')).toStrictEqual([['docker', 'rm', '-f', 'old']]);
    });

    it('silently tolerates missing Docker and invalid Docker output', async () => {
      dockerStatus = 127;
      const missingDocker = await planResources(ctx);
      expect(missingDocker.warnings).toStrictEqual([]);
      vi.mocked(run).mockResolvedValue({ status: 0, stderr: '', stdout: 'not JSON' });
      const invalidDocker = await planResources(ctx);
      expect(invalidDocker.containers).toStrictEqual([]);
    });

    it('does not remove a container whose ownership changed after planning', async () => {
      containers = [container('changed', '/old', '/repo/wt/remove')];
      const plan = await planResources(ctx);
      containers[0] = container('changed', '/tern-wt-db', '/repo/wt/remove');
      await applyResources(plan, plan.warnings);
      expect(calls.some(argv => argv[1] === 'rm')).toBeFalsy();
      expect(plan.warnings[0]).toContain('ownership changed');
    });
  });

  describe('prunable directories', () => {
    it('only removes Git-known empty directories, never symlinks or hard-to-rebuild files', async () => {
      const base = tempDir('prunable');
      const empty = path.join(base, 'empty');
      const hard = path.join(base, 'hard');
      const link = path.join(base, 'link');
      mkdirSync(empty);
      mkdirSync(hard);
      writeFileSync(path.join(hard, '.env'), 'keep');
      symlinkSync(empty, link);
      ctx.prunableWorktrees = [empty, hard, link, path.join(base, 'gone')];
      const plan = await planResources(ctx);
      expect(plan.paths).toStrictEqual([empty]);
      await applyResources(plan, plan.warnings);
      expect(plan.warnings).toStrictEqual([]);
      const afterRemoval = await planResources(ctx);
      expect(afterRemoval.paths).toStrictEqual([]);
    });

    it('preserves a directory that acquired files after planning', async () => {
      const empty = tempDir('new-files');
      ctx.prunableWorktrees = [empty];
      const plan = await planResources(ctx);
      writeFileSync(path.join(empty, '.env'), 'keep');
      await applyResources(plan, plan.warnings);
      expect(plan.warnings[0]).toContain('Preserved path');
    });
  });

  describe('process signals', () => {
    it('never signals a reused PID or an unplanned process', async () => {
      processEntry(900_050, 1, '/repo/main');
      const plan = await planResources(ctx);
      processEntry(900_050, 1, '/repo/main', 'node worker.js', '200');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const result = await applyResources(plan, plan.warnings);
      expect(result.failedProcesses).toStrictEqual([900_050]);
      await applyResources({ containers: [], paths: [], processes: [{ command: 'node', cwd: '/repo/main', pid: 900_051 }] }, plan.warnings);
      expect(kill).not.toHaveBeenCalled();
      expect(plan.warnings).toHaveLength(2);
    });

    it('sends TERM then KILL only to the same surviving identity', async () => {
      processEntry(900_060, 1, '/repo/main');
      const plan = await planResources(ctx);
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const result = await applyResources(plan, plan.warnings);
      expect(result.failedProcesses).toStrictEqual([900_060]);
      expect(kill.mock.calls).toStrictEqual([
        [900_060, 'SIGTERM'],
        [900_060, 'SIGKILL'],
      ]);
    });

    it('does not KILL a process that exits or changes cwd after TERM', async () => {
      processEntry(900_070, 1, '/repo/main');
      const plan = await planResources(ctx);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        rmSync(path.join(root, '900070'), { force: true, recursive: true });
        return true;
      });
      await applyResources(plan, plan.warnings);
      expect(kill.mock.calls).toStrictEqual([[900_070, 'SIGTERM']]);
    });

    it('reports signal and Docker failures without touching other resources', async () => {
      processEntry(900_080, 1, '/repo/main');
      containers = [container('failed', '/old', '/repo/wt/remove')];
      const plan = await planResources(ctx);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('denied');
      });
      dockerStatus = 1;
      const result = await applyResources(plan, plan.warnings);
      expect(result.failedProcesses).toStrictEqual([900_080]);
      expect(plan.warnings).toHaveLength(3);
    });
  });

  describe('directory protection', () => {
    it('does not inspect real processes on unsupported hosts without an override', async () => {
      vi.stubEnv('TERN_WT_PROC_ROOT', '');
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings[0]).toContain('Linux');
      expect(plan.protectedWorktrees).toStrictEqual(ctx.worktrees);
      expect(plan.keep).toContainEqual({
        id: '/repo/wt/remove',
        kind: 'worktree',
        reason: 'Process inspection unavailable: Linux /proc or macOS lsof required; worktree process ownership cannot be proven.',
      });
      expect(calls.some(argv => argv[0] === 'ps')).toBeFalsy();
    });

    it('preserves active directories even when Git marks them prunable', async () => {
      const active = tempDir('active-prunable');
      ctx.worktrees = [active];
      ctx.prunableWorktrees = [active, ctx.repo];
      processEntry(process.pid, process.ppid, active);
      const plan = await planResources(ctx);
      expect(plan.paths).toStrictEqual([]);
    });

    it('preserves changed and unknown directory identities and accepts already removed directories', async () => {
      const empty = tempDir('identity-path');
      ctx.prunableWorktrees = [empty];
      const plan = await planResources(ctx);
      rmSync(empty, { recursive: true });
      await applyResources(plan, plan.warnings);
      expect(plan.warnings).toStrictEqual([]);
      await applyResources({ containers: [], paths: [tempDir('unknown-path')], processes: [] }, plan.warnings);
      expect(plan.warnings[0]).toContain('identity changed');
    });
  });

  describe('uncertain ownership', () => {
    it('preserves vanished containers and failed Docker inspections', async () => {
      containers = [container('gone', '/old', '/repo/wt/remove')];
      const plan = await planResources(ctx);
      containers = [];
      await applyResources(plan, plan.warnings);
      expect(plan.warnings[0]).toContain('ownership changed');
      vi.mocked(run).mockImplementation(async argv => {
        await Promise.resolve();
        return { status: argv[1] === 'inspect' ? 1 : 0, stderr: '', stdout: argv[1] === 'ps' ? 'gone' : '' };
      });
      const afterInspectionFailure = await planResources(ctx);
      expect(afterInspectionFailure.containers).toStrictEqual([]);
    });

    it('rejects malformed and deleted process identities', async () => {
      processEntry(900_090, 1, '/repo/main');
      writeFileSync(path.join(root, '900090', 'stat'), 'bad');
      processEntry(900_091, 1, '/repo/main (deleted)');
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
    });

    it('removes repo-tied Testcontainers only after their session has no live owner or companion', async () => {
      containers = [container('ended', '/test', '/repo/wt/remove', { 'org.testcontainers': 'true', 'org.testcontainers.sessionId': 'ended-session' })];
      const endedSession = await planResources(ctx);
      expect(endedSession.containers).toStrictEqual(['ended']);
      containers.push(container('ryuk', '/ryuk', '/other', { 'org.testcontainers.sessionId': 'ended-session' }));
      const liveCompanion = await planResources(ctx);
      expect(liveCompanion.containers).toStrictEqual([]);
      containers.pop();
      processEntry(900_099, 1, '/repo/wt/remove');
      const liveOwner = await planResources(ctx);
      expect(liveOwner.containers).toStrictEqual([]);
    });

    it('protects every worktree when the process directory is inaccessible', async () => {
      rmSync(root, { recursive: true });
      const plan = await planResources(ctx);
      expect(plan.protectedWorktrees).toStrictEqual(ctx.worktrees);
      expect(plan.warnings[0]).toContain('process directory');
    });

    it('preserves a worktree whose non-orphan process belongs to an uncertain external parent', async () => {
      ctx.removeWorktrees = [];
      processEntry(900_110, 777, '/repo/wt/live');
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toStrictEqual(['/repo/wt/live']);
    });
  });

  describe('busy Tern worktrees', () => {
    it('keeps busy blocks, their groups and descendants even in selected worktrees', async () => {
      processEntry(901_000, 1, '/repo/wt/remove', 'bash');
      processEntry(901_001, 901_000, '/repo/wt/remove');
      processEntry(901_002, 1, '/repo/wt/remove', 'worker', '100', 42);
      vi.mocked(ls).mockResolvedValue({ sessions: [{ id: 1, name: 'repo', tabs: [{ blocks: [{ cwd: '/repo/wt/remove', id: 1, title: 'busy' }], id: 1, name: 'work' }] }] });
      vi.mocked(processOf).mockResolvedValue({
        child: { argv: [], cwd: '/repo/wt/remove', name: 'bash', pid: 901_000 },
        foreground: { argv: [], cwd: '/repo/wt/remove', name: 'node', pid: 901_001 },
        group: 42,
        pane: 1,
      });
      const plan = await planResources(ctx);
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      await applyResources(plan, plan.warnings);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.protectedWorktrees).toContain('/repo/wt/remove');
      expect(kill).not.toHaveBeenCalled();
    });

    it('uses the busy foreground cwd when a block has no directory or child', async () => {
      vi.mocked(ls).mockResolvedValue({ sessions: [{ id: 1, name: 'repo', tabs: [{ blocks: [{ cwd: null, id: 1, title: 'busy' }], id: 1, name: 'work' }] }] });
      vi.mocked(processOf).mockResolvedValue({ child: null, foreground: { argv: [], cwd: '/repo/wt/remove', name: 'node', pid: 901_010 }, group: null, pane: 1 });
      const plan = await planResources(ctx);
      expect(plan.protectedWorktrees).toContain('/repo/wt/remove');
    });

    it('does not protect a selected worktree for its idle shell alone', async () => {
      processEntry(901_020, 1, '/repo/wt/remove', 'bash');
      const shell = { argv: [], cwd: '/repo/wt/remove', name: 'bash', pid: 901_020 };
      vi.mocked(ls).mockResolvedValue({ sessions: [{ id: 1, name: 'repo', tabs: [{ blocks: [{ cwd: '/repo/wt/remove', id: 1, title: 'idle' }], id: 1, name: 'work' }] }] });
      vi.mocked(processOf).mockResolvedValue({ child: shell, foreground: shell, group: 901_020, pane: 1 });
      const plan = await planResources(ctx);
      expect(plan.processes.map(entry => entry.pid)).toStrictEqual([901_020]);
      expect(plan.protectedWorktrees).toStrictEqual([]);
    });
  });

  describe('resource inspection boundaries', () => {
    it('preserves identities when the host cannot identify the current user', async () => {
      processEntry(901_030, 1, '/repo/wt/remove');
      const withoutUser = { ...process };
      Reflect.deleteProperty(withoutUser, 'getuid');
      vi.stubGlobal('process', withoutUser);
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).toContain('Process inspection incomplete: 901030 (worker).');
    });

    it('rejects process directories owned by another user', async () => {
      processEntry(901_040, 1, '/repo/wt/remove');
      vi.spyOn(process, 'getuid').mockReturnValue(999_999);
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
    });

    it('falls back to the host process directory without an override', async () => {
      vi.stubEnv('TERN_WT_PROC_ROOT', '');
      const hostProcess = { ...process, platform: 'linux' };
      Reflect.deleteProperty(hostProcess, 'getuid');
      vi.stubGlobal('process', hostProcess);
      vi.mocked(run).mockResolvedValue({ status: 127, stderr: '', stdout: '' });
      const plan = await planResources(ctx);
      expect(plan.processes).toStrictEqual([]);
      expect(plan.warnings).not.toStrictEqual([]);
    });

    it('accepts absent Docker labels and mount metadata without inventing ownership', async () => {
      vi.mocked(run).mockResolvedValue({
        status: 0,
        stderr: '',
        stdout: JSON.stringify([
          { Config: { Labels: null }, Id: 'no-labels', Mounts: null, Name: '/db' },
          { Config: null, Id: 'no-config', Mounts: [{ Source: '/repo/wt/remove' }], Name: '/db' },
        ]),
      });
      const plan = await planResources(ctx);
      expect(plan.containers).toStrictEqual(['no-config']);
      expect(plan.keep).toStrictEqual([]);
    });
  });
});
