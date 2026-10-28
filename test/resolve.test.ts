import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/resolve.ts';
import { cliJson, contract, git, logGitCalls, readLog, tempDir, tmpRepo, useSandbox } from './helpers.ts';

describe('resolve command', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(run, () => {
    it('resolves a repo dir, a worktree dir and a plain dir', async () => {
      const repo = await tmpRepo('aoyama');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'git@github.com:virtusize/aoyama.git');
      const worktree = path.join(tempDir('wt'), 'feature-x');
      await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature/x', worktree);
      const local = await tmpRepo('local');
      const plain = tempDir('plain');
      await expect(run([repo.dir, worktree, plain, local.dir, repo.dir])).resolves.toStrictEqual({
        repos: [
          { dir: repo.dir, name: 'aoyama', origin: 'virtusize/aoyama', owner: 'virtusize', root: repo.dir },
          { dir: worktree, name: 'aoyama', origin: 'virtusize/aoyama', owner: 'virtusize', root: repo.dir },
          { dir: plain, name: null, origin: null, owner: null, root: null },
          { dir: local.dir, name: 'local', origin: null, owner: null, root: local.dir },
          { dir: repo.dir, name: 'aoyama', origin: 'virtusize/aoyama', owner: 'virtusize', root: repo.dir },
        ],
      });
    });

    it('returns a lowercase origin identity without changing the displayed owner', async () => {
      const repo = await tmpRepo('app');
      await git(repo.dir, 'remote', 'set-url', 'origin', 'https://github.com/Acme/App.git');
      await expect(run([repo.dir])).resolves.toMatchObject({ repos: [{ origin: 'acme/app', owner: 'Acme' }] });
    });

    it('resolves a tilde directory without changing the lookup key', async () => {
      const repo = await tmpRepo('app');
      vi.stubEnv('HOME', path.dirname(repo.dir));
      await expect(cliJson(['resolve', '~/app'])).resolves.toMatchObject({ repos: [{ dir: '~/app', root: repo.dir }] });
    });

    it('accepts a bare home directory and a home-relative repo option', async () => {
      const repo = await tmpRepo('app');
      vi.stubEnv('HOME', repo.dir);
      await expect(cliJson(['resolve', '~'])).resolves.toMatchObject({ repos: [{ dir: '~', root: repo.dir }] });
      await expect(cliJson(['branches', '--repo=~', '--offline'])).resolves.toMatchObject({ repo: repo.dir });
    });

    it('expands paths for prepare, env, remove and clean', async () => {
      const repo = await tmpRepo('app');
      vi.stubEnv('HOME', path.dirname(repo.dir));
      await expect(cliJson(['prepare', '~/app', '--no-setup'])).resolves.toMatchObject({ path: repo.dir });
      await expect(cliJson(['env', '~/app'])).resolves.toMatchObject({ env: {} });
      await expect(cliJson(['remove', '~/app', '--keep-tab'])).resolves.toMatchObject({ error: { code: 'not_managed' } });
      await expect(cliJson(['clean', '--repo', '~/app'])).resolves.toMatchObject({ repo: repo.dir });
    });

    it('answers resolve through the CLI main function with the contract fixture', async () => {
      const repo = await tmpRepo('app');
      await expect(cliJson(['resolve', repo.dir])).resolves.toStrictEqual(contract('resolve', { repo: repo.dir }));
    });

    it('runs git once per distinct dir', async () => {
      const log = await logGitCalls();
      const plain = tempDir('plain');
      await run([plain, plain, plain]);
      expect(readLog(log)).toHaveLength(1);
    });

    it('gives an empty list without dirs', async () => {
      await expect(run([])).resolves.toStrictEqual({ repos: [] });
    });

    it('rejects options', async () => {
      await expect(run(['--nope'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    });
  });
});
