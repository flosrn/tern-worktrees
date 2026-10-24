import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { git, ignoreGlobally, logGitCalls, managedPath, readLog, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let sandbox: Sandbox;
let repo: RepoFixture;

const setTeardown = (teardown: string): void => {
  writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ teardown }));
};

describe('remove command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('with submodules', () => {
    const subWorktree = async (): Promise<string> => {
      const sub = await tmpRepo('sub');
      await git(repo.dir, 'switch', '--quiet', '-c', 'feature/s');
      await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', sub.dir, 'sub');
      await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
      await git(repo.dir, 'push', '--quiet', 'origin', 'feature/s');
      await git(repo.dir, 'switch', '--quiet', 'main');
      await git(repo.dir, 'branch', '--quiet', '-D', 'feature/s');
      const dir = managedPath('feature-s');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/s', dir, 'origin/feature/s');
      await git(dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init');
      return dir;
    };

    it('removes, without --force, ignored files inside a submodule that are easy to rebuild', async () => {
      await ignoreGlobally('node_modules');
      const dir = await subWorktree();
      mkdirSync(path.join(dir, 'sub', 'node_modules'));
      writeFileSync(path.join(dir, 'sub', 'node_modules', 'x.js'), 'x\n');
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/s', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('removes a copy of an ignored file of the submodule in the main checkout', async () => {
      await ignoreGlobally('.env.local');
      const dir = await subWorktree();
      mkdirSync(path.join(repo.dir, 'sub'), { recursive: true });
      writeFileSync(path.join(repo.dir, 'sub', '.env.local'), 'SECRET=1\n');
      writeFileSync(path.join(dir, 'sub', '.env.local'), 'SECRET=2\n');
      await expect(run([dir])).rejects.toMatchObject({ code: 'dirty_worktree', extra: { files: ['!! sub/.env.local'] } });
      writeFileSync(path.join(dir, 'sub', '.env.local'), 'SECRET=1\n');
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/s', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
      expect(readFileSync(path.join(repo.dir, 'sub', '.env.local'), 'utf-8')).toBe('SECRET=1\n');
    });

    it('removes a clean worktree without --force', async () => {
      const dir = await subWorktree();
      await expect(run([dir])).resolves.toMatchObject({ branch: 'feature/s', removed: dir });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('removes a merged worktree whose submodule release tag is not on a remote branch', async () => {
      const dir = await subWorktree();
      const sub = path.join(dir, 'sub');
      await git(sub, 'commit', '--quiet', '--allow-empty', '-m', 'release');
      await git(sub, 'tag', 'v1');
      await git(sub, 'push', '--quiet', 'origin', 'refs/tags/v1');
      await git(dir, 'commit', '--quiet', '-am', 'pin release');
      await git(repo.dir, 'merge', '--quiet', 'feature/s');
      await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
      await git(repo.dir, 'push', '--quiet', 'origin', 'main');
      const log = await logGitCalls();
      await expect(run([dir])).resolves.toMatchObject({ branchDeleted: true, removed: dir });
      expect(existsSync(dir)).toBeFalsy();
      expect(
        readLog(log)
          .filter(call => call.startsWith(`-C ${sub} `))
          .join('\n'),
      ).not.toMatch(/ls-remote|fetch/u);
    });

    it('keeps a worktree whose submodule holds a commit that no remote has', async () => {
      setTeardown('worktree');
      const dir = await subWorktree();
      const sub = path.join(dir, 'sub');
      await git(sub, 'switch', '--quiet', '-c', 'local-work');
      await git(sub, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      await git(sub, 'tag', 'local-only');
      await git(sub, 'switch', '--quiet', '--detach', 'local-only');
      const commit = await git(sub, 'rev-parse', '--short', 'HEAD');
      await git(dir, 'commit', '--quiet', '-am', 'bump sub');
      const log = await logGitCalls();
      await expect(run([dir])).rejects.toMatchObject({
        code: 'dirty_worktree',
        extra: { existing: dir, files: [`sub: unpushed ${commit.trim()}`] },
        message: `${dir} has work that removing it would lose`,
      });
      expect(readLog(log).join('\n')).not.toMatch(/remove --force/u);
      await expect(git(sub, 'rev-parse', '--short', 'local-work')).resolves.toBe(commit);
    });

    it('reports git refusing the forced removal of a clean worktree', async () => {
      const dir = await subWorktree();
      const sub = path.join(dir, 'sub');
      chmodSync(sub, 0o555);
      try {
        const failure = run([dir]);
        await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
        await expect(failure).rejects.toThrow(/failed to delete/u);
      } finally {
        chmodSync(sub, 0o755);
      }
    });
  });
});
