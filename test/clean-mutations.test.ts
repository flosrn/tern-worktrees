import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyResources, planResources } from '../src/clean-resources.ts';
import type { ResourcePlan } from '../src/clean-resources.ts';
import { run } from '../src/commands/clean.ts';
import { CliError } from '../src/proc.ts';
import { guardBusyTabs } from '../src/teardown.ts';
import { ls } from '../src/tern.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { git, gitShim, logGitCalls, readLog, tempDir, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';

vi.mock(import('../src/clean-resources.ts'), { spy: true });
vi.mock(import('../src/teardown.ts'), { spy: true });
vi.mock(import('../src/tern.ts'), { spy: true });
vi.mock(import('../src/work-to-lose.ts'), { spy: true });

const resources = (): ResourcePlan => ({ containers: [], keep: [], paths: [], processes: [], protectedWorktrees: [], warnings: [] });

const linked = async (): Promise<{ dir: string; repo: string }> => {
  const repo = await tmpRepo('app');
  const dir = path.join(tempDir('outside'), 'merged');
  await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
  return { dir, repo: repo.dir };
};

describe('clean observable safety decisions', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({ work: [] });
  });

  afterEach(() => {
    vi.mocked(planResources).mockReset();
    vi.mocked(applyResources).mockReset();
    vi.mocked(guardBusyTabs).mockReset();
    vi.mocked(ls).mockReset();
    vi.mocked(guardWorkToLose).mockReset();
  });

  describe('complete planning results', () => {
    it('reports only actual retained and selected objects in a clean checkout', async () => {
      const repo = await tmpRepo('app');
      const result = await run(['--repo', repo.dir]);
      expect(result).toStrictEqual({
        default: 'main',
        keep: [
          { id: 'main', kind: 'branch', reason: 'default branch' },
          { id: repo.dir, kind: 'worktree', reason: 'main checkout' },
        ],
        remove: { branches: [], containers: [], paths: [], processes: [], worktrees: [] },
        repo: repo.dir,
        warnings: [],
      });
    });

    it('preserves a caller exactly at the linked worktree root', async () => {
      const { dir, repo } = await linked();
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const result = await run(['--repo', repo]);
        expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'caller active worktree' });
        expect(result.remove.worktrees).toStrictEqual([]);
      } finally {
        cwd.mockRestore();
      }
    });

    it('propagates the matching branch reason without unrelated retained entries', async () => {
      const { dir, repo } = await linked();
      writeFileSync(path.join(dir, 'feature.txt'), 'local work\n');
      await git(dir, 'add', 'feature.txt');
      await git(dir, 'commit', '--quiet', '-m', 'local work');
      const result = await run(['--repo', repo]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'not merged' });
      expect(result.remove.worktrees).toStrictEqual([]);
    });

    it('retains multiple dirty paths in the reported inspection reason', async () => {
      const { dir, repo } = await linked();
      vi.mocked(guardWorkToLose).mockRejectedValueOnce(new CliError('dirty_worktree', 'work to lose', { files: ['draft.txt', 'secret.env'] }));
      const result = await run(['--repo', repo]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'worktree inspection failed: work to lose: draft.txt, secret.env' });
    });

    it('does not interpret unrelated failure metadata as dirty paths', async () => {
      const { dir, repo } = await linked();
      vi.mocked(guardWorkToLose).mockRejectedValueOnce(new CliError('git_failed', 'status unavailable', { files: ['not-a-dirty-path'] }));
      const result = await run(['--repo', repo]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'worktree inspection failed: status unavailable' });
    });

    it('includes resource retention reasons and warnings in the public plan', async () => {
      const repo = await tmpRepo('app');
      const selected = resources();
      selected.keep = [{ id: 'worker', kind: 'process', reason: 'protected process' }];
      selected.warnings = ['process inspection unavailable'];
      vi.mocked(planResources).mockResolvedValue(selected);
      const result = await run(['--repo', repo.dir]);
      expect(result.keep).toContainEqual({ id: 'worker', kind: 'process', reason: 'protected process' });
      expect(result.warnings).toStrictEqual(['process inspection unavailable']);
    });

    it('passes only missing prunable worktrees to the resource boundary', async () => {
      const { dir, repo } = await linked();
      const missing = path.join(tempDir('outside'), 'missing');
      await git(repo, 'worktree', 'add', '--quiet', '-b', 'missing', missing, 'origin/main');
      rmSync(missing, { recursive: true });
      vi.mocked(planResources).mockResolvedValue(resources());
      await run(['--repo', repo]);
      const context = vi.mocked(planResources).mock.calls[0]?.[0];
      expect(context?.prunableWorktrees).toStrictEqual([missing]);
      expect(context?.removeWorktrees).toStrictEqual([]);
      expect(context?.repo).toBe(repo);
      expect(context?.worktrees.toSorted()).toStrictEqual([repo, dir, missing].toSorted());
    });

    it('keeps unaffected removal candidates when resource selection protects another', async () => {
      const { dir, repo } = await linked();
      const other = path.join(tempDir('outside'), 'other');
      await git(repo, 'worktree', 'add', '--quiet', '-b', 'other', other, 'origin/main');
      vi.mocked(planResources).mockImplementation(async context => {
        await Promise.resolve();
        return { ...resources(), protectedWorktrees: context.removeWorktrees.includes(dir) ? [dir] : [] };
      });
      const result = await run(['--repo', repo]);
      expect(result.remove.worktrees).toStrictEqual([other]);
      expect(result.remove.branches).toStrictEqual(['other']);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'busy or protected process' });
    });
  });

  describe('unproven integration', () => {
    it('preserves unique work despite a gone upstream', async () => {
      const { dir, repo } = await linked();
      writeFileSync(path.join(dir, 'unique.txt'), 'unique work\n');
      await git(dir, 'add', 'unique.txt');
      await git(dir, 'commit', '--quiet', '-m', 'unique work');
      await git(dir, 'push', '--quiet', '-u', 'origin', 'merged');
      await git(repo, 'push', '--quiet', 'origin', '--delete', 'merged');
      const result = await run(['--repo', repo]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: 'merged', kind: 'branch', reason: 'not merged' });
    });
  });

  it('reports the specific resource protection reason before worktree inspection', async () => {
    const { dir, repo } = await linked();
    vi.mocked(planResources).mockResolvedValue({
      ...resources(),
      keep: [{ id: dir, kind: 'worktree', reason: 'process inspection requires Linux /proc' }],
      protectedWorktrees: [dir],
    });
    const result = await run(['--repo', repo]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'process inspection requires Linux /proc' });
    expect(result.keep).not.toContainEqual({ id: dir, kind: 'worktree', reason: 'active or protected process' });
  });

  it('reports a specific resource reason when selection newly protects a worktree', async () => {
    const { dir, repo } = await linked();
    vi.mocked(planResources).mockImplementation(async context => {
      await Promise.resolve();
      return context.removeWorktrees.includes(dir)
        ? { ...resources(), keep: [{ id: dir, kind: 'worktree', reason: 'process cwd unreadable' }], protectedWorktrees: [dir] }
        : resources();
    });
    const result = await run(['--repo', repo]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'process cwd unreadable' });
  });

  describe('optional lock environment', () => {
    it('disables optional locks while inspecting the checkout', async () => {
      const repo = await tmpRepo('app');
      const log = path.join(tempDir('locks'), 'values');
      await gitShim(`case " $* " in *" worktree list "*) printf '%s\\n' "$GIT_OPTIONAL_LOCKS" >> '${log}';; esac`);
      await run(['--repo', repo.dir]);
      expect(readLog(log)).toStrictEqual(['0']);
    });

    it('restores an absent optional lock setting after planning', async () => {
      const repo = await tmpRepo('app');
      vi.stubEnv('GIT_OPTIONAL_LOCKS', undefined);
      await run(['--repo', repo.dir]);
      expect(process.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
    });
  });

  describe('destructive boundary failures', () => {
    it('reports ordinary removal errors without retrying with force', async () => {
      const { dir, repo } = await linked();
      await gitShim('case " $* " in *" worktree remove "*) printf "  refused  \\n" >&2; exit 1;; esac');
      const log = await logGitCalls();
      const result = await run(['--repo', repo, '--apply']);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'removal failed: refused' });
      expect(result.keep).toContainEqual({ id: 'merged', kind: 'branch', reason: 'checked out in a retained worktree' });
      expect(readLog(log).filter(line => line.includes('worktree remove --force'))).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
    });

    it('trims branch deletion and prune diagnostics', async () => {
      const repo = await tmpRepo('app');
      await git(repo.dir, 'branch', 'merged');
      await gitShim('case " $* " in *" branch -D "*) printf "  branch-refused  \\n" >&2; exit 1;; *" worktree prune "*) printf "  prune-refused  \\n" >&2; exit 1;; esac');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.warnings).toStrictEqual(['branch merged not deleted: branch-refused', 'worktree prune failed: prune-refused']);
    });

    it('reports successful pruning without a failure warning', async () => {
      const repo = await tmpRepo('app');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.warnings).toStrictEqual([]);
    });

    it('retains the worktree and its branch when its HEAD changes after planning', async () => {
      const { dir, repo } = await linked();
      const changed = `${'1'.repeat(40)}\n`;
      await gitShim(`case " $* " in *" -C ${dir} rev-parse HEAD "*) printf '${changed}'; exit 0;; esac`);
      const result = await run(['--repo', repo, '--apply']);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'removal failed: worktree HEAD changed after planning' });
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
    });

    it('rejects a failed branch head lookup even if stdout matches the planned tip', async () => {
      const repo = await tmpRepo('app');
      await git(repo.dir, 'branch', 'merged');
      const head = await git(repo.dir, 'rev-parse', 'merged');
      const marker = path.join(tempDir('race'), 'applied');
      await gitShim(`case " $* " in
        *" worktree list "*) if [ -e '${marker}' ]; then touch '${marker}.lookup'; else touch '${marker}'; fi;;
        *" rev-parse refs/heads/merged "*) if [ -e '${marker}.lookup' ]; then printf '${head}'; exit 1; fi;;
      esac`);
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: 'merged', kind: 'branch', reason: 'branch changed after planning' });
    });

    it('passes the removing repository to the last work inspection', async () => {
      const { dir, repo } = await linked();
      const result = await run(['--repo', repo, '--apply']);
      expect(guardWorkToLose).toHaveBeenLastCalledWith(dir, { removing: repo }, repo);
      expect(result.remove.worktrees).toStrictEqual([dir]);
    });

    it('requires a descriptive repository argument error', async () => {
      await expect(run([])).rejects.toMatchObject({ code: 'bad_args', message: 'clean needs --repo <dir>' });
    });
  });

  describe('process stop outcomes', () => {
    it('reports stopped processes and prevents only worktrees belonging to failed stops', async () => {
      const { dir, repo } = await linked();
      const unrelated = path.join(tempDir('outside'), 'unrelated');
      const stopped = { command: 'worker', cwd: dir, pid: 63_550 };
      const failed = { command: 'worker', cwd: unrelated, pid: 63_551 };
      vi.mocked(planResources).mockResolvedValue({ ...resources(), processes: [stopped, failed] });
      vi.mocked(applyResources).mockResolvedValue({ failedProcesses: [failed.pid] });
      const result = await run(['--repo', repo, '--apply']);
      expect(result.remove.processes).toStrictEqual([stopped]);
      expect(result.remove.worktrees).toStrictEqual([dir]);
      expect(existsSync(dir)).toBeFalsy();
    });
  });
});
