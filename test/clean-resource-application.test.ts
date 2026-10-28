import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyResources, planResources } from '../src/clean-resources.ts';
import { resourceFixture } from './clean-resource-fixture.ts';
import type { ResourceFixture } from './clean-resource-fixture.ts';
import { tempDir } from './helpers.ts';

vi.mock(import('../src/proc.ts'));
vi.mock(import('../src/tern.ts'));
vi.mock(import('node:fs/promises'), { spy: true });
const REMOVED_WORKTREE = '/repo/remove';

describe('resource application safety', () => {
  let f: ResourceFixture;
  beforeEach(() => {
    f = resourceFixture();
  });
  afterEach(() => {
    vi.mocked(lstat).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  describe('process signalling identity', () => {
    it.each(['cwd', 'command'])('does not signal when %s changes before apply', async change => {
      f.entry(920_001);
      const plan = await planResources(f.ctx);
      f.entry(920_001, change === 'cwd' ? '/repo/live' : REMOVED_WORKTREE, change === 'command' ? 'python other.py' : 'node worker.js');
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [920_001] });
      expect(f.kill).not.toHaveBeenCalled();
      expect(plan.warnings).toStrictEqual(['Preserved process 920001: identity or cwd changed.']);
    });

    it('accepts an already vanished process without marking it failed', async () => {
      const dir = f.entry(920_002);
      const plan = await planResources(f.ctx);
      rmSync(dir, { recursive: true });
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [] });
      expect(f.kill).not.toHaveBeenCalled();
    });

    it('waits for a graceful exit without an unnecessary KILL or failure', async () => {
      const dir = f.entry(920_003);
      const plan = await planResources(f.ctx);
      f.delay.mockImplementation(async () => {
        rmSync(dir, { force: true, recursive: true });
        await Promise.resolve();
      });
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [] });
      expect(f.kill.mock.calls).toStrictEqual([[920_003, 'SIGTERM']]);
      expect(f.delay.mock.calls).toStrictEqual([[100]]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('waits ten grace intervals before escalating and checks the killed process exits', async () => {
      const dir = f.entry(920_004);
      const plan = await planResources(f.ctx);
      f.kill.mockImplementation((_pid, signal) => {
        if (signal === 'SIGKILL') {
          rmSync(dir, { recursive: true });
        }
        return true;
      });
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [] });
      expect(f.delay.mock.calls).toStrictEqual(Array.from({ length: 11 }, () => [100]));
      expect(f.kill.mock.calls).toStrictEqual([
        [920_004, 'SIGTERM'],
        [920_004, 'SIGKILL'],
      ]);
      expect(plan.warnings).toStrictEqual([]);
    });

    it('stops waiting after identity changes and never kills the replacement', async () => {
      f.entry(920_005);
      const plan = await planResources(f.ctx);
      f.delay.mockImplementation(async () => {
        f.entry(920_005, '/repo/live');
        await Promise.resolve();
      });
      await expect(applyResources(plan, plan.warnings)).resolves.toStrictEqual({ failedProcesses: [920_005] });
      expect(f.kill.mock.calls).toStrictEqual([[920_005, 'SIGTERM']]);
      expect(f.delay.mock.calls).toStrictEqual([[100]]);
      expect(plan.warnings).toStrictEqual(['Preserved process 920005: process remains alive after signalling.']);
    });

    it('reports signal rejection and a surviving process separately', async () => {
      f.entry(920_006);
      const plan = await planResources(f.ctx);
      f.kill.mockImplementation(() => {
        throw new Error('denied');
      });
      await applyResources(plan, plan.warnings);
      expect(plan.warnings).toStrictEqual(['Cannot stop process 920006: Error: denied', 'Preserved process 920006: process remains alive after signalling.']);
    });
  });

  describe('directory identity', () => {
    it('preserves the repository itself even when empty and Git marks it prunable', async () => {
      f.ctx.repo = tempDir('empty-repo');
      f.ctx.prunableWorktrees = [f.ctx.repo];
      const plan = await planResources(f.ctx);
      expect(plan.paths).toStrictEqual([]);
    });

    it('preserves a replaced directory with a different inode', async () => {
      const base = tempDir('inode');
      const target = path.join(base, 'target');
      mkdirSync(target);
      f.ctx.prunableWorktrees = [target];
      const plan = await planResources(f.ctx);
      renameSync(target, path.join(base, 'original'));
      mkdirSync(target);
      await applyResources(plan, plan.warnings);
      expect(existsSync(target)).toBeTruthy();
      expect(plan.warnings).toStrictEqual([`Preserved path ${target}: directory identity changed.`]);
    });

    it('preserves a symlink substituted for a planned empty directory', async () => {
      const target = tempDir('symlink-target');
      const other = tempDir('symlink-other');
      f.ctx.prunableWorktrees = [target];
      const plan = await planResources(f.ctx);
      renameSync(target, `${target}-original`);
      symlinkSync(other, target);
      await applyResources(plan, plan.warnings);
      rmSync(`${target}-original`, { recursive: true });
      expect(existsSync(target)).toBeTruthy();
      expect(existsSync(other)).toBeTruthy();
      expect(plan.warnings).toStrictEqual([`Preserved path ${target}: directory identity changed.`]);
    });

    it('preserves a path whose filesystem device changed', async () => {
      const target = tempDir('changed-device');
      f.ctx.prunableWorktrees = [target];
      const plan = await planResources(f.ctx);
      const original = await lstat(target);
      vi.mocked(lstat).mockResolvedValue(Object.assign(original, { dev: original.dev + 1 }));
      await applyResources(plan, plan.warnings);
      expect(existsSync(target)).toBeTruthy();
      expect(plan.warnings).toStrictEqual([`Preserved path ${target}: directory identity changed.`]);
    });

    it.each([new Error('denied'), 'denied'])('reports path inspection failures instead of silently discarding them: %s', async failure => {
      const target = tempDir('path-error');
      vi.mocked(lstat).mockRejectedValue(failure);
      const warnings: string[] = [];
      await applyResources({ containers: [], paths: [target], processes: [] }, warnings);
      expect(warnings).toStrictEqual([`Preserved path ${target}: ${String(failure)}`]);
    });
  });
});
