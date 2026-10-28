import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { guardCleanRecovery, recoverCleanTarget } from '../src/clean-recovery.ts';
import { run } from '../src/commands/clean.ts';
import { must } from '../src/proc.ts';
import { ghCleanFixture, git, gitShim, logGitCalls, readLog, tempDir, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const recovery = async () => {
  const repo = await tmpRepo('app');
  const dir = path.join(tempDir('outside'), '17-work');
  await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feat/17-work', dir, 'origin/main');
  writeFileSync(path.join(dir, 'local.txt'), 'local commit\n');
  await git(dir, 'add', 'local.txt');
  await git(dir, 'commit', '--quiet', '-m', 'local work');
  const output = await git(dir, 'rev-parse', 'HEAD');
  return { branch: 'feat/17-work', dir, head: output.trim(), repo: repo.dir };
};

const useClosed = async () => {
  await useGithubOrigin();
  ghCleanFixture({ n17: { __typename: 'Issue', issueState: 'CLOSED', number: 17 } });
};

describe('clean recovery', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({ work: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('durable recovery copies', () => {
    it('saves binary diffs, untracked bytes, tip and local-only commits with private permissions', async () => {
      const f = await recovery();
      writeFileSync(path.join(f.dir, 'local.txt'), Buffer.from([0, 1, 2, 255]));
      writeFileSync(path.join(f.dir, '-draft file.txt'), 'untracked contents\n');
      symlinkSync('local.txt', path.join(f.dir, 'draft-link'));
      const destination = await recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir });
      expect(destination).toContain(path.join(process.env.XDG_STATE_HOME ?? '', 'tern-wt', 'recovery'));
      expect(readFileSync(path.join(destination, 'changes.patch'), 'utf-8')).toContain('GIT binary patch');
      expect(JSON.parse(readFileSync(path.join(destination, 'manifest.json'), 'utf-8'))).toMatchObject({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir });
      const extracted = tempDir('extracted');
      await must(['tar', '-xf', path.join(destination, 'untracked.tar'), '-C', extracted], 'git_failed');
      expect(readFileSync(path.join(extracted, '-draft file.txt'), 'utf-8')).toBe('untracked contents\n');
      await expect(git(f.repo, 'bundle', 'list-heads', path.join(destination, 'commits.bundle'))).resolves.toContain(f.head);
    });

    it('rejects changes made after a successful recovery', async () => {
      const f = await recovery();
      writeFileSync(path.join(f.dir, 'draft.txt'), 'before recovery\n');
      const destination = await recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir });
      await expect(guardCleanRecovery(f.dir, destination)).resolves.toBeUndefined();
      writeFileSync(path.join(f.dir, 'draft.txt'), 'changed after recovery\n');
      await expect(guardCleanRecovery(f.dir, destination)).rejects.toThrow('worktree changed after recovery');
    });

    it('saves branch-only history without copying the main checkout working files', async () => {
      const f = await recovery();
      const destination = await recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: null });
      expect(readdirSync(destination).toSorted()).toStrictEqual(['commits.bundle', 'manifest.json']);
      await expect(git(f.repo, 'bundle', 'list-heads', path.join(destination, 'commits.bundle'))).resolves.toContain(`refs/heads/${f.branch}`);
    });

    it('omits an empty bundle when a remote already holds the entire tip', async () => {
      const f = await recovery();
      await git(f.dir, 'push', '--quiet', 'origin', 'HEAD');
      const destination = await recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir });
      expect(existsSync(path.join(destination, 'commits.bundle'))).toBeFalsy();
      expect(existsSync(path.join(destination, 'untracked.tar'))).toBeTruthy();
    });

    it('uses the home state fallback when XDG_STATE_HOME is empty', async () => {
      const f = await recovery();
      const home = tempDir('home');
      vi.stubEnv('HOME', home);
      vi.stubEnv('XDG_STATE_HOME', '');
      const destination = await recoverCleanTarget({ branch: null, head: f.head, repo: f.repo, worktree: f.dir });
      expect(destination.startsWith(path.join(home, '.local', 'state', 'tern-wt', 'recovery'))).toBeTruthy();
    });

    it('refuses recovery before copying if the tip differs from the planned head', async () => {
      const f = await recovery();
      const log = await logGitCalls();
      await expect(recoverCleanTarget({ branch: f.branch, head: '1'.repeat(40), repo: f.repo, worktree: f.dir })).rejects.toThrow('HEAD changed before recovery');
      expect(readLog(log).some(line => /(?:diff --binary|bundle create)/u.test(line))).toBeFalsy();
    });

    it('refuses to use a backup whose work changed during copying', async () => {
      const f = await recovery();
      await gitShim(`case " $* " in *" diff --binary "*" --output="*) printf 'changed during copy\n' > '${f.dir}/local.txt';; esac`);
      await expect(recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir })).rejects.toThrow('worktree changed during recovery');
    });
  });

  describe('guarded recovery application', () => {
    it('preserves worktree, branch and resources if a recovery step fails', async () => {
      const f = await recovery();
      await useClosed();
      writeFileSync(path.join(f.dir, 'draft.txt'), 'untracked work\n');
      await gitShim('case " $* " in *" bundle create "*) echo recovery-refused >&2; exit 1;; esac');
      const log = await logGitCalls();
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
      expect(existsSync(f.dir)).toBeTruthy();
      expect(readLog(log).filter(line => /(?:worktree remove|branch -D)/u.test(line))).toStrictEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('recovery failed: recovery-refused'));
    });

    it('completes every recovery before the first destructive command and reports recovery paths', async () => {
      const f = await recovery();
      await useClosed();
      writeFileSync(path.join(f.dir, 'local.txt'), 'tracked draft\n');
      writeFileSync(path.join(f.dir, 'draft.txt'), 'untracked draft\n');
      const log = await logGitCalls();
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([f.dir]);
      expect(result.remove.branches).toStrictEqual([f.branch]);
      expect(result.removalDetails?.every(detail => detail.recovery && detail.recoveryPath !== undefined)).toBeTruthy();
      const calls = readLog(log);
      const firstRemoval = calls.findIndex(line => line.includes('worktree remove'));
      expect(calls.findLastIndex(line => line.includes('bundle create'))).toBeLessThan(firstRemoval);
      expect(calls[firstRemoval]).toContain('--force');
      for (const detail of result.removalDetails ?? []) {
        expect(existsSync(path.join(detail.recoveryPath ?? '', 'manifest.json'))).toBeTruthy();
      }
    });

    it('does not force delete work added after a successful recovery', async () => {
      const f = await recovery();
      await useClosed();
      const marker = path.join(tempDir('race'), 'worktree-recovered');
      await gitShim(`case " $* " in
      *" bundle create "*" HEAD "*) touch '${marker}';;
      *" bundle create "*" refs/heads/feat/17-work "*) if [ -e '${marker}' ]; then printf 'new untracked work\n' > '${f.dir}/late.txt'; fi;;
    esac`);
      const log = await logGitCalls();
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(existsSync(path.join(f.dir, 'late.txt'))).toBeTruthy();
      expect(readLog(log).filter(line => line.includes('worktree remove'))).toStrictEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('worktree changed after recovery'));
    });

    it('does not remove a branch when its standalone recovery fails', async () => {
      const f = await recovery();
      await git(f.dir, 'switch', '--detach', '--quiet', 'origin/main');
      await useClosed();
      await gitShim('case " $* " in *" bundle create "*" refs/heads/feat/17-work "*) echo cannot-save-branch >&2; exit 1;; esac');
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.branches).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: f.branch, kind: 'branch', reason: 'recovery failed: cannot-save-branch' });
    });

    it('saves initialized submodule changes and local-only history alongside the root recovery', async () => {
      const repo = await tmpRepo('app');
      const sub = await tmpRepo('sub');
      await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', sub.origin, 'sub');
      await git(repo.dir, 'commit', '--quiet', '-am', 'add submodule');
      await git(repo.dir, 'push', '--quiet', 'origin', 'main');
      const dir = path.join(tempDir('outside'), '17-sub');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feat/17-sub', dir, 'origin/main');
      await git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet');
      const subDir = path.join(dir, 'sub');
      writeFileSync(path.join(subDir, 'local.txt'), 'submodule local commit\n');
      await git(subDir, 'add', 'local.txt');
      await git(subDir, 'commit', '--quiet', '-m', 'local submodule');
      writeFileSync(path.join(subDir, 'draft.txt'), 'submodule untracked\n');
      const output = await git(dir, 'rev-parse', 'HEAD');
      const destination = await recoverCleanTarget({ branch: 'feat/17-sub', head: output.trim(), repo: repo.dir, worktree: dir });
      expect(existsSync(path.join(destination, 'submodules', '0', 'commits.bundle'))).toBeTruthy();
      expect(existsSync(path.join(destination, 'submodules', '0', 'untracked.tar'))).toBeTruthy();
      const extracted = tempDir('sub-extracted');
      await must(['tar', '-xf', path.join(destination, 'submodules', '0', 'untracked.tar'), '-C', extracted], 'git_failed');
      expect(readFileSync(path.join(extracted, 'draft.txt'), 'utf-8')).toBe('submodule untracked\n');
      // SAFETY: recoverCleanTarget writes this manifest with one entry for each initialized submodule.
      const manifest = JSON.parse(readFileSync(path.join(destination, 'manifest.json'), 'utf-8')) as { submodules: { head: string; path: string }[] };
      const subHead = await git(subDir, 'rev-parse', 'HEAD');
      expect(manifest.submodules).toStrictEqual([{ head: subHead.trim(), path: 'sub' }]);
    });
  });

  describe('recovery failure protection', () => {
    it('keeps a worktree if the state directory cannot be created', async () => {
      const f = await recovery();
      await useClosed();
      const file = path.join(tempDir('state'), 'not-a-directory');
      writeFileSync(file, 'file');
      vi.stubEnv('XDG_STATE_HOME', file);
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(existsSync(f.dir)).toBeTruthy();
    });

    it('refuses a recovery destination inside the worktree it protects', async () => {
      const f = await recovery();
      vi.stubEnv('XDG_STATE_HOME', path.join(f.dir, 'state'));
      await expect(recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir })).rejects.toThrow(
        'recovery directory must be outside the removed worktree',
      );
    });

    it('rejects a non-regular untracked file rather than hanging or losing it', async () => {
      const f = await recovery();
      await must(['mkfifo', path.join(f.dir, 'draft-pipe')], 'git_failed');
      await gitShim('case " $* " in *" ls-files --others --exclude-standard -z "*) printf "draft-pipe\\0"; exit 0;; esac');
      await expect(recoverCleanTarget({ branch: f.branch, head: f.head, repo: f.repo, worktree: f.dir })).rejects.toThrow('cannot recover non-regular file');
    });

    it('supports recovery of the repository HEAD without a branch or worktree target', async () => {
      const f = await recovery();
      const output = await git(f.repo, 'rev-parse', 'HEAD');
      const destination = await recoverCleanTarget({ branch: null, head: output.trim(), repo: f.repo, worktree: null });
      expect(path.basename(destination)).toMatch(/^app-/u);
      expect(existsSync(path.join(destination, 'manifest.json'))).toBeTruthy();
    });

    it('keeps a worktree if it becomes locked after planning', async () => {
      const f = await recovery();
      await useClosed();
      await gitShim(`case " $* " in *" -C ${f.dir} rev-parse HEAD "*) git -C '${f.repo}' worktree lock '${f.dir}';; esac`);
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('worktree became locked, active or unavailable'));
    });

    it('retains associated worktrees when branch recovery fails after worktree recovery succeeds', async () => {
      const f = await recovery();
      await useClosed();
      await gitShim('case " $* " in *" bundle create "*" refs/heads/feat/17-work "*) echo branch-save-failed >&2; exit 1;; esac');
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: f.dir, kind: 'worktree', reason: 'branch recovery failed' });
    });

    it('retains detached worktrees when recovery fails without an associated branch', async () => {
      const f = await recovery();
      await git(f.dir, 'switch', '--detach', '--quiet');
      await useClosed();
      await gitShim('case " $* " in *" bundle create "*" HEAD "*) echo detached-save-failed >&2; exit 1;; esac');
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: f.dir, kind: 'worktree', reason: 'recovery failed: detached-save-failed' });
    });

    it('does not force new dirty work that was not part of the selected recovery plan', async () => {
      const f = await recovery();
      await git(f.dir, 'reset', '--hard', 'origin/main');
      await useClosed();
      ghCleanFixture({ n17: { __typename: 'Issue', issueState: 'OPEN', number: 17 } });
      await gitShim(`case " $* " in *" -C ${f.dir} rev-parse HEAD "*) printf 'late draft\\n' > '${f.dir}/late.txt';; esac`);
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(existsSync(path.join(f.dir, 'late.txt'))).toBeTruthy();
    });

    it('rechecks recovered content before the submodule force fallback', async () => {
      const f = await recovery();
      await useClosed();
      await gitShim(
        'case " $* " in *" worktree remove "*) case " $* " in *" --force "*) ;; *) echo "working trees containing submodules cannot be moved or removed" >&2; exit 1;; esac;; esac',
      );
      const result = await run(['--repo', f.repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([f.dir]);
      expect(result.removalDetails?.find(detail => detail.id === f.dir)?.recoveryPath).toBeDefined();
    });
  });
});
