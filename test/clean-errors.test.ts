import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/clean.ts';
import { listPullRequests } from '../src/github.ts';
import { CliError } from '../src/proc.ts';
import { guardBusyTabs, isCleanMerged } from '../src/teardown.ts';
import { close, ls } from '../src/tern.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { git, gitShim, logGitCalls, readLog, tempDir, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

vi.mock(import('../src/github.ts'), { spy: true });
vi.mock(import('../src/teardown.ts'), { spy: true });
vi.mock(import('../src/tern.ts'), { spy: true });
vi.mock(import('../src/work-to-lose.ts'), { spy: true });

describe('inspection failures at command boundaries', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({ work: [] });
  });

  afterEach(() => {
    vi.mocked(listPullRequests).mockReset();
    vi.mocked(guardBusyTabs).mockReset();
    vi.mocked(isCleanMerged).mockReset();
    vi.mocked(close).mockReset();
    vi.mocked(ls).mockReset();
    vi.mocked(guardWorkToLose).mockReset();
  });

  it.each([new Error('query unavailable'), 'query unavailable'])('reports a thrown merged PR query failure: %s', async failure => {
    const repo = await tmpRepo('app');
    await git(repo.dir, 'branch', 'integrated');
    await useGithubOrigin();
    vi.mocked(listPullRequests).mockRejectedValueOnce(failure);
    const result = await run(['--repo', repo.dir]);
    expect(result.warnings).toContain('merged PR check failed: query unavailable');
    expect(result.remove.branches).toStrictEqual(['integrated']);
  });

  it('preserves unmerged work when the default tree cannot be read', async () => {
    const repo = await tmpRepo('app');
    const dir = path.join(tempDir('outside'), 'feature');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'feature', dir, 'origin/main');
    writeFileSync(path.join(dir, 'feature.txt'), 'unique work\n');
    await git(dir, 'add', 'feature.txt');
    await git(dir, 'commit', '--quiet', '-m', 'unique work');
    await gitShim('case " $* " in *" rev-parse origin/main^{tree} "*) exit 1;; *" merge-tree "*) echo unexpected-merge-tree >&2; exit 0;; esac');
    const log = await logGitCalls();
    const result = await run(['--repo', repo.dir]);
    expect(result.remove.branches).toStrictEqual([]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: 'feature', kind: 'branch', reason: 'not merged' });
    expect(readLog(log).some(line => line.includes('merge-tree'))).toBeFalsy();
  });

  it.each([new Error('process unavailable'), new CliError('tern_failed', 'process unavailable')])('keeps worktrees on unexpected busy inspection failure: %s', async failure => {
    const repo = await tmpRepo('app');
    const dir = path.join(tempDir('outside'), 'merged');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
    vi.mocked(guardBusyTabs).mockRejectedValueOnce(failure);
    const result = await run(['--repo', repo.dir]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'worktree inspection failed: process unavailable' });
  });

  it.each([
    new Error('status unavailable'),
    Object.assign(new Error('status unavailable'), { code: 'dirty_worktree', extra: { files: ['untrusted-metadata'] } }),
    'status unavailable',
    new CliError('dirty_worktree', 'status unavailable', { files: 'unexpected file payload' }),
    new CliError('dirty_worktree', 'status unavailable', {
      files: [{ block: 1, process: { argv: ['worker'], cwd: '/work', name: 'worker', pid: 63_545 }, session: 1, tab: 1 }],
    }),
  ])('keeps worktrees when work inspection fails: %s', async failure => {
    const repo = await tmpRepo('app');
    const dir = path.join(tempDir('outside'), 'merged');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
    vi.mocked(guardWorkToLose).mockRejectedValueOnce(failure);
    const result = await run(['--repo', repo.dir]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'worktree inspection failed: status unavailable' });
  });

  it('reports non-Error branch and Tern inspection failures', async () => {
    const repo = await tmpRepo('app');
    await git(repo.dir, 'branch', 'merged');
    vi.mocked(isCleanMerged).mockRejectedValueOnce('ancestry unavailable');
    vi.mocked(ls).mockRejectedValue('daemon unavailable');
    const result = await run(['--repo', repo.dir]);
    expect(result.keep).toContainEqual({ id: 'merged', kind: 'branch', reason: 'branch inspection failed: ancestry unavailable' });
    expect(result.warnings).toContain('Tern inspection failed: daemon unavailable');
  });

  it('reports a non-Error close failure after removing the worktree', async () => {
    const repo = await tmpRepo('app');
    const dir = path.join(tempDir('outside'), 'merged');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
    writeTernLs({ work: [dir] });
    vi.mocked(close).mockRejectedValueOnce('daemon unavailable');
    const result = await run(['--repo', repo.dir, '--apply']);
    expect(result.remove.worktrees).toStrictEqual([dir]);
    expect(result.warnings).toContain('block 1 not closed: daemon unavailable');
  });

  it('preserves a worktree when final work inspection rejects a non-Error', async () => {
    const repo = await tmpRepo('app');
    const dir = path.join(tempDir('outside'), 'merged');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
    vi.mocked(guardWorkToLose).mockResolvedValueOnce([]).mockRejectedValueOnce('status unavailable');
    const result = await run(['--repo', repo.dir, '--apply']);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: 'removal failed: status unavailable' });
    expect(existsSync(dir)).toBeTruthy();
  });

  it('requires a repository argument', async () => {
    await expect(run([])).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('rejects a repository path that does not exist', async () => {
    await expect(run(['--repo', path.join(tempDir('outside'), 'missing')])).rejects.toMatchObject({ code: 'not_a_repo' });
  });

  it('passes prunable worktrees to resource inspection without deleting their branch', async () => {
    const repo = await tmpRepo('app');
    const dir = path.join(tempDir('outside'), 'missing');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'missing', dir, 'origin/main');
    rmSync(dir, { recursive: true });
    const result = await run(['--repo', repo.dir]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.remove.branches).toStrictEqual([]);
    expect(result.keep.find(item => item.id === dir && item.kind === 'worktree')?.reason).toContain('inspection failed');
  });
});
