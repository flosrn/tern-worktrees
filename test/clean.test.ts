import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyResources, planResources } from '../src/clean-resources.ts';
import type { ResourcePlan } from '../src/clean-resources.ts';
import { run } from '../src/commands/clean.ts';
import { guardBusyTabs, isCleanMerged } from '../src/teardown.ts';
import { close, ls } from '../src/tern.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import {
  cliJson,
  ghFixture,
  git,
  gitShim,
  ignoreGlobally,
  logGitCalls,
  readLog,
  tempDir,
  ternLog,
  tmpRepo,
  useGithubOrigin,
  useSandbox,
  writeTernLs,
  writeTernLsRaw,
} from './helpers.ts';

vi.mock(import('../src/clean-resources.ts'), { spy: true });
vi.mock(import('../src/teardown.ts'), { spy: true });
vi.mock(import('../src/tern.ts'), { spy: true });
vi.mock(import('../src/work-to-lose.ts'), { spy: true });
const tempTernDir = (): string => {
  const dir = process.env.FAKE_TERN_DIR;
  if (dir === undefined) {
    throw new Error('Missing fake Tern directory');
  }
  return dir;
};
describe('clean command', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({ work: [] });
  });

  afterEach(() => {
    vi.mocked(planResources).mockReset();
    vi.mocked(applyResources).mockReset();
    vi.mocked(guardBusyTabs).mockReset();
    vi.mocked(isCleanMerged).mockReset();
    vi.mocked(close).mockReset();
    vi.mocked(ls).mockReset();
    vi.mocked(guardWorkToLose).mockReset();
  });

  describe('planning and applying merged worktrees', () => {
    it('plans linked worktrees outside the managed root without any mutation', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      const index = readFileSync(path.join(repo.dir, '.git', 'index'));
      const log = await logGitCalls();
      const result = await cliJson(['clean', '--repo', repo.dir]);
      expect(result).toMatchObject({ default: 'main', remove: { branches: ['merged'], worktrees: [dir] }, repo: repo.dir });
      expect(result).not.toHaveProperty('applied');
      expect(existsSync(dir)).toBeTruthy();
      expect(readFileSync(path.join(repo.dir, '.git', 'index'))).toStrictEqual(index);
      expect(readLog(log).filter(line => /(?:fetch|worktree remove|worktree prune|branch -D)/u.test(line))).toStrictEqual([]);
    });

    it('never closes blocks during planning', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      await run(['--repo', repo.dir]);
      expect(ternLog().filter(line => line.startsWith('close'))).toStrictEqual([]);
    });

    it('keeps work to lose and unmerged branches with reasons', async () => {
      const repo = await tmpRepo('app');
      const base = tempDir('worktrees');
      const dirty = path.join(base, 'dirty');
      const unmerged = path.join(base, 'unmerged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'dirty', dirty, 'origin/main');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'unmerged', unmerged, 'origin/main');
      writeFileSync(path.join(dirty, 'draft.txt'), 'draft\n');
      writeFileSync(path.join(unmerged, 'feature.txt'), 'unmerged work\n');
      await git(unmerged, 'add', 'feature.txt');
      await git(unmerged, 'commit', '--quiet', '-m', 'unmerged work');
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep.find(item => item.id === dirty && item.kind === 'worktree')?.reason).toContain('work');
      expect(result.keep.find(item => item.id === 'unmerged' && item.kind === 'branch')?.reason).toBe('not merged');
      expect(result.keep.find(item => item.id === unmerged && item.kind === 'worktree')?.reason).toContain('not merged');
      expect(readFileSync(path.join(dirty, 'draft.txt'), 'utf-8')).toBe('draft\n');
    });

    it('applies merged worktree and branch removal before closing its tab', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_GONE_BEFORE_CLOSE', dir);
      await expect(cliJson(['clean', '--repo', repo.dir, '--apply'])).resolves.toMatchObject({ applied: true, remove: { branches: ['merged'], worktrees: [dir] } });
      expect(existsSync(dir)).toBeFalsy();
      await expect(git(repo.dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).resolves.toBe('main\n');
      expect(ternLog().some(line => line.startsWith('close'))).toBeTruthy();
    });

    it('fetches remote updates and prunes worktree metadata when applying', async () => {
      const repo = await tmpRepo('app');
      const log = await logGitCalls();
      await run(['--repo', repo.dir, '--apply']);
      expect(readLog(log).some(line => line.includes('fetch') && line.includes('--prune'))).toBeTruthy();
      expect(readLog(log).some(line => line.includes('worktree prune'))).toBeTruthy();
    });

    it('recomputes after fetching instead of applying an earlier dry-run plan', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      const planned = await run(['--repo', repo.dir]);
      expect(planned.remove.worktrees).toStrictEqual([dir]);
      await gitShim(`case " $* " in *" fetch "*) printf 'changed during fetch\\n' > '${dir}/draft.txt';; esac`);
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(existsSync(dir)).toBeTruthy();
      expect(result.keep.find(item => item.id === dir && item.kind === 'worktree')?.reason).toContain('work');
    });
  });

  describe('worktree safety guards', () => {
    it('keeps locked, detached unmerged and caller worktrees', async () => {
      const repo = await tmpRepo('app');
      const base = tempDir('outside');
      const locked = path.join(base, 'locked');
      const detached = path.join(base, 'detached');
      const active = path.join(base, 'active');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'locked', locked, 'origin/main');
      await git(repo.dir, 'worktree', 'lock', locked);
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', detached, 'origin/main');
      await git(detached, 'commit', '--quiet', '--allow-empty', '-m', 'detached work');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'active', active, 'origin/main');
      const nested = path.join(active, 'nested');
      mkdirSync(nested);
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(nested);
      try {
        const result = await run(['--repo', repo.dir]);
        expect(result.keep).toStrictEqual(
          expect.arrayContaining([
            { id: locked, kind: 'worktree', reason: 'locked worktree' },
            { id: detached, kind: 'worktree', reason: 'detached HEAD is not reachable from origin/default' },
            { id: active, kind: 'worktree', reason: 'caller active worktree' },
          ]),
        );
      } finally {
        cwd.mockRestore();
      }
    });

    it('keeps worktrees if Tern cannot inspect them', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      vi.stubEnv('FAKE_TERN_FAIL', 'ls');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'Tern inspection unavailable' });
      expect(existsSync(dir)).toBeTruthy();
    });

    it('keeps ignored hard-to-rebuild files and reports their paths', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      await ignoreGlobally('.env.local');
      writeFileSync(path.join(dir, '.env.local'), 'TOKEN=keep\n');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep.find(item => item.id === dir && item.kind === 'worktree')?.reason).toContain('!! .env.local');
      expect(readFileSync(path.join(dir, '.env.local'), 'utf-8')).toBe('TOKEN=keep\n');
    });

    it('removes a detached HEAD reachable from origin/default', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'detached');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', dir, 'origin/main');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([dir]);
      expect(existsSync(dir)).toBeFalsy();
    });

    it('keeps worktrees when process inspection fails or Tern JSON is malformed', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_FAIL', 'process');
      const unavailable = await run(['--repo', repo.dir]);
      expect(unavailable.remove.worktrees).toStrictEqual([]);
      expect(existsSync(dir)).toBeTruthy();
      vi.stubEnv('FAKE_TERN_FAIL', '');
      writeTernLsRaw('{');
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('Tern inspection failed'));
    });

    it('keeps worktrees with busy foreground blocks', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      const foreground = { argv: ['worker'], cwd: dir, name: 'worker', pid: 63_542 };
      writeFileSync(path.join(tempTernDir(), 'process-1.json'), JSON.stringify({ child: null, foreground, group: 63_542, pane: 1 }));
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'busy or protected process' });
      expect(ternLog().filter(line => line.startsWith('close'))).toStrictEqual([]);
    });

    it('preserves busy blocks even when their process is eligible for cleanup', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      const foreground = { argv: ['worker'], cwd: dir, name: 'worker', pid: 63_543 };
      writeFileSync(path.join(tempTernDir(), 'process-1.json'), JSON.stringify({ child: null, foreground, group: 63_543, pane: 1 }));
      vi.mocked(planResources).mockImplementation(async context => {
        await Promise.resolve();
        const selected: ResourcePlan = {
          containers: [],
          keep: [],
          paths: [],
          processes: context.removeWorktrees.includes(dir) ? [{ command: 'worker', cwd: dir, pid: 63_543 }] : [],
          protectedWorktrees: [],
          warnings: [],
        };
        return selected;
      });
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.processes).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'busy or protected process' });
      expect(existsSync(dir)).toBeTruthy();
      expect(ternLog().filter(line => line.startsWith('close'))).toStrictEqual([]);
    });
  });

  describe('application failures', () => {
    it('reports a failed removal and leaves its branch and tab intact', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      await gitShim('case " $* " in *" worktree remove "*) echo refused >&2; exit 1;; esac');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('refused'));
      expect(existsSync(dir)).toBeTruthy();
      expect(ternLog().filter(line => line.startsWith('close'))).toStrictEqual([]);
    });

    it('reports close, branch deletion and prune failures in the applied result', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_FAIL', 'close');
      await gitShim('case " $* " in *" branch -D "*) echo branch-refused >&2; exit 1;; *" worktree prune "*) echo prune-refused >&2; exit 1;; esac');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.applied).toBeTruthy();
      expect(result.remove.worktrees).toStrictEqual([dir]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.warnings).toStrictEqual(
        expect.arrayContaining([expect.stringContaining('not closed'), expect.stringContaining('branch-refused'), expect.stringContaining('prune-refused')]),
      );
    });

    it('preserves optional-lock settings even when planning fails', async () => {
      const repo = await tmpRepo('app');
      vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
      await gitShim('case " $* " in *" worktree list "*) echo list-refused >&2; exit 1;; esac');
      await expect(run(['--repo', repo.dir])).rejects.toMatchObject({ code: 'git_failed' });
      expect(process.env.GIT_OPTIONAL_LOCKS).toBe('1');
    });
  });

  describe('branch reachability', () => {
    it('removes a squashed worktree even when another remote branch holds its commits', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'squashed');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'squashed', dir, 'origin/main');
      writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
      await git(dir, 'add', 'feature.txt');
      await git(dir, 'commit', '--quiet', '-m', 'feature');
      await git(dir, 'push', '--quiet', '-u', 'origin', 'squashed');
      await git(dir, 'push', '--quiet', 'origin', 'squashed:archive');
      await git(repo.dir, 'merge', '--quiet', '--squash', 'squashed');
      await git(repo.dir, 'commit', '--quiet', '-m', 'squash feature');
      await git(repo.dir, 'push', '--quiet', 'origin', 'main');
      await git(repo.origin, 'branch', '-D', 'squashed');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([dir]);
      expect(result.remove.branches).toStrictEqual(['squashed']);
    });

    it('removes squashed gone-upstream commits absent from all remotes', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'squashed');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'squashed', dir, 'origin/main');
      writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
      await git(dir, 'add', 'feature.txt');
      await git(dir, 'commit', '--quiet', '-m', 'feature');
      await git(dir, 'push', '--quiet', '-u', 'origin', 'squashed');
      await git(repo.dir, 'merge', '--quiet', '--squash', 'squashed');
      await git(repo.dir, 'commit', '--quiet', '-m', 'squash feature');
      await git(repo.dir, 'push', '--quiet', 'origin', 'main');
      await git(repo.origin, 'branch', '-D', 'squashed');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.branches).toContain('squashed');
      expect(result.remove.worktrees).toContain(dir);
    });

    it('keeps branches when their inspection fails', async () => {
      const repo = await tmpRepo('app');
      await git(repo.dir, 'branch', 'merged');
      await gitShim('case " $* " in *" rev-parse refs/heads/merged "*) echo inspect-refused >&2; exit 1;; esac');
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: 'merged', kind: 'branch', reason: 'branch inspection failed: inspect-refused' });
    });

    it('reports a fetch failure and still recomputes a conservative plan', async () => {
      const repo = await tmpRepo('app');
      await git(repo.dir, 'branch', 'merged');
      await gitShim('case " $* " in *" fetch "*) echo offline >&2; exit 1;; esac');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.applied).toBeTruthy();
      expect(result.warnings).toContainEqual(expect.stringContaining('fetch failed:'));
      expect(result.remove.branches).toStrictEqual(['merged']);
    });

    it('accepts a merged PR only when its head contains the complete local head', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'feature');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature', dir, 'origin/main');
      writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
      await git(dir, 'add', 'feature.txt');
      await git(dir, 'commit', '--quiet', '-m', 'feature');
      await git(dir, 'push', '--quiet', 'origin', 'feature');
      const head = await git(dir, 'rev-parse', 'HEAD');
      const tip = head.trim();
      await useGithubOrigin();
      ghFixture(
        ['pr', 'list', '--repo', 'virtusize/aoyama', '--state', 'merged', '--limit', '10000', '--json', 'headRefName,headRefOid,number'],
        JSON.stringify([{ headRefName: 'feature', headRefOid: tip, number: 1 }]),
      );
      const planned = await run(['--repo', repo.dir]);
      expect(planned.remove.worktrees).toStrictEqual([dir]);
      writeFileSync(path.join(dir, 'feature.txt'), 'feature after merge\n');
      await git(dir, 'commit', '--quiet', '-am', 'after merge');
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: 'feature', kind: 'branch', reason: 'not merged' });
    });

    it('keeps a branch when the merged PR query fails', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'feature');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature', dir, 'origin/main');
      writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
      await git(dir, 'add', 'feature.txt');
      await git(dir, 'commit', '--quiet', '-m', 'feature');
      await useGithubOrigin();
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('merged PR check failed'));
    });
  });

  describe('special worktrees and arguments', () => {
    it('removes a clean submodule worktree with the guarded Git fallback', async () => {
      const repo = await tmpRepo('app');
      const sub = await tmpRepo('sub');
      await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', sub.origin, 'sub');
      await git(repo.dir, 'commit', '--quiet', '-am', 'add submodule');
      await git(repo.dir, 'push', '--quiet', 'origin', 'main');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      await git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet');
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([dir]);
      expect(existsSync(dir)).toBeFalsy();
    });

    it('treats the absence of a foreground process as an idle block', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      writeTernLs({ work: [dir] });
      writeFileSync(path.join(tempTernDir(), 'process-1.json'), JSON.stringify({ child: null, foreground: null, group: null, pane: 1 }));
      const planned = await run(['--repo', repo.dir]);
      expect(planned.remove.worktrees).toStrictEqual([dir]);
    });

    it('keeps a worktree whose HEAD advances after planning', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      await git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'new work');
      const advanced = await git(dir, 'rev-parse', 'HEAD');
      await git(dir, 'reset', '--hard', 'origin/main');
      await gitShim(`case " $* " in *" -C ${dir} rev-parse HEAD "*) git -C '${repo.dir}' update-ref refs/heads/merged '${advanced.trim()}';; esac`);
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(existsSync(dir)).toBeTruthy();
      expect(result.warnings).toContainEqual(expect.stringContaining('HEAD changed after planning'));
    });

    it('keeps a branch whose tip advances after planning', async () => {
      const repo = await tmpRepo('app');
      await git(repo.dir, 'commit', '--quiet', '--allow-empty', '-m', 'new work');
      const advanced = await git(repo.dir, 'rev-parse', 'HEAD');
      await git(repo.dir, 'reset', '--hard', 'origin/main');
      await git(repo.dir, 'branch', 'merged');
      const marker = path.join(tempDir('race'), 'listed');
      await gitShim(
        `case " $* " in *" worktree list "*) if [ -e '${marker}' ]; then git -C '${repo.dir}' update-ref refs/heads/merged '${advanced.trim()}'; else touch '${marker}'; fi;; esac`,
      );
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: 'merged', kind: 'branch', reason: 'branch changed after planning' });
      expect(result.warnings).toContainEqual(expect.stringContaining('branch changed after planning'));
    });
  });

  describe('resource selection changes', () => {
    it('keeps candidates that become protected during resource selection', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      vi.mocked(planResources).mockImplementation(async context => {
        await Promise.resolve();
        const selected: ResourcePlan = {
          containers: [],
          keep: [],
          paths: [],
          processes: [],
          protectedWorktrees: context.removeWorktrees.includes(dir) ? [dir] : [],
          warnings: [],
        };
        return selected;
      });
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'busy or protected process' });
    });

    it('keeps worktrees protected by the initial resource snapshot', async () => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      vi.mocked(planResources).mockResolvedValue({
        containers: [],
        keep: [],
        paths: [],
        processes: [],
        protectedWorktrees: [dir],
        warnings: [],
      });
      const result = await run(['--repo', repo.dir]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'active or protected process' });
    });

    it.each(['root', 'nested'] as const)('keeps worktrees when a selected process in their %s cannot be stopped', async location => {
      const repo = await tmpRepo('app');
      const dir = path.join(tempDir('outside'), 'merged');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
      vi.mocked(planResources).mockResolvedValue({
        containers: [],
        keep: [],
        paths: [],
        processes: [{ command: 'worker', cwd: location === 'root' ? dir : path.join(dir, 'nested'), pid: 63_544 }],
        protectedWorktrees: [],
        warnings: [],
      });
      vi.mocked(applyResources).mockResolvedValue({ failedProcesses: [63_544] });
      const result = await run(['--repo', repo.dir, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.processes).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'process could not be safely stopped' });
      expect(existsSync(dir)).toBeTruthy();
    });
  });
});
