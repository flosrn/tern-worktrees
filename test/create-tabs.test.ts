import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { managedPath, tempDir, ternLog, tmpRepo, useSandbox, writeTernLs, writeTernLsRaw } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

const ACTIVATE = 'eval "$(tern-wt env . --shell)"';
const WAIT = 'wait 42 --until prompt --timeout 30';
let repo: RepoFixture;

describe('create command tabs', () => {
  beforeEach(async () => {
    useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
  });
  describe('tabs', () => {
    it('opens a tab in the session of the repo and activates its environment at the prompt', async () => {
      writeTernLs({ other: [tempDir('plain')], work: [repo.dir] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        port: 5610,
        setup: { line: ACTIVATE, typed: true },
        tab: { block: 42, opened: true, session: 'work' },
        warnings: [],
      });
      expect(ternLog()).toStrictEqual(['ls --json', `new tab work --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json', WAIT, `run 42 ${ACTIVATE}`]);
    });

    it('opens a session named after the repo and activates the worktree environment at the prompt', async () => {
      writeTernLs({});
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        port: 5610,
        setup: { line: ACTIVATE, typed: true },
        tab: { block: 42, opened: true, session: 'aoyama' },
      });
      expect(ternLog()).toStrictEqual(['ls --json', `new session aoyama --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json', WAIT, `run 42 ${ACTIVATE}`]);
    });

    it('focuses the tab that already shows the worktree', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      writeTernLs({ work: [repo.dir, path.join(managedPath('feature-x'), 'src')] });
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        port: 5610,
        setup: null,
        status: 'reused',
        tab: { block: 2, opened: false, session: 'work' },
      });
      expect(ternLog()).toStrictEqual(['ls --json', 'focus 2 --json']);
    });

    it('keeps the worktree when Tern fails', async () => {
      writeTernLs({});
      vi.stubEnv('FAKE_TERN_FAIL', 'new');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        port: 5610,
        setup: { line: ACTIVATE, typed: false },
        status: 'created',
        tab: null,
        warnings: ['tab not opened: fake tern: new failed'],
      });
      expect(existsSync(managedPath('feature-x'))).toBeTruthy();
    });

    it('passes on other errors', async () => {
      writeTernLsRaw('{');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).rejects.toBeInstanceOf(SyntaxError);
    });
  });
});
