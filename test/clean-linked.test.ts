import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/clean.ts';
import { ghCleanFixture, ghLog, git, gitShim, ignoreGlobally, logGitCalls, readLog, tempDir, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const issue = (number: number, state = 'CLOSED') => ({ __typename: 'Issue', issueState: state, number });
const pr = (number: number, state = 'MERGED') => ({ __typename: 'PullRequest', number, prState: state });

const linked = async (branch: string, basename = 'worker') => {
  const repo = await tmpRepo('app');
  const dir = path.join(tempDir('outside'), basename);
  await git(repo.dir, 'worktree', 'add', '--quiet', '-b', branch, dir, 'origin/main');
  writeFileSync(path.join(dir, 'unique.txt'), 'unmerged work\n');
  await git(dir, 'add', 'unique.txt');
  await git(dir, 'commit', '--quiet', '-m', 'unique work');
  await useGithubOrigin();
  return { dir, repo: repo.dir };
};

describe('closed linked worktree cleanup', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({ work: [] });
  });

  it.each(['feat/17-title', 'fix/17', 'pr-17'])('plans unmerged %s with additive recovery metadata and no writes', async branch => {
    const f = await linked(branch);
    ghCleanFixture({ n17: issue(17) });
    const log = await logGitCalls();
    const result = await run(['--repo', f.repo]);
    expect(result.remove).toMatchObject({ branches: [branch], worktrees: [f.dir] });
    expect(result.removalDetails).toStrictEqual([
      { id: f.dir, kind: 'worktree', reason: 'closed linked issue virtusize/aoyama#17', recovery: true },
      { id: branch, kind: 'branch', reason: 'closed linked issue virtusize/aoyama#17', recovery: true },
    ]);
    expect(existsSync(path.join(process.env.XDG_STATE_HOME ?? '', 'tern-wt'))).toBeFalsy();
    expect(readLog(log).some(line => /(?:bundle create|worktree remove|merge-tree)/u.test(line))).toBeFalsy();
    expect(ghLog().filter(line => line.startsWith('api graphql'))).toHaveLength(1);
  });

  it('reads the configured association and worktree basename even with an unrelated branch name', async () => {
    const f = await linked('custom', '19-custom');
    await git(f.repo, 'config', 'branch.custom.ternIssue', 'https://github.com/virtusize/aoyama/issues/17');
    ghCleanFixture({ n17: issue(17), n19: pr(19, 'CLOSED') });
    const result = await run(['--repo', f.repo]);
    expect(result.remove.worktrees).toStrictEqual([f.dir]);
    expect(result.removalDetails?.every(item => item.reason.includes('#17') && item.reason.includes('#19') && item.recovery)).toBeTruthy();
    const query = ghLog().find(line => line.startsWith('api graphql')) ?? '';
    expect(query).toContain('n17:issueOrPullRequest(number:17)');
    expect(query).toContain('n19:issueOrPullRequest(number:19)');
  });

  it('resolves explicit cross-repository settings in the same GraphQL operation', async () => {
    const f = await linked('custom');
    await git(f.repo, 'config', 'branch.custom.ternIssue', 'https://github.com/elsewhere/tracker/issues/29');
    ghCleanFixture({}, [{ data: { r0: { merged: { nodes: [] } }, r1: { n29: issue(29) } } }]);
    const result = await run(['--repo', f.repo]);
    expect(result.remove.branches).toStrictEqual(['custom']);
    expect(result.removalDetails?.[0]?.reason).toBe('closed linked issue elsewhere/tracker#29');
    expect(ghLog().filter(line => line.startsWith('api graphql'))).toHaveLength(1);
  });

  it.each(['OPEN', 'unknown'])('preserves unique work when any association is %s', async state => {
    const f = await linked('feat/17-feature', '19-worker');
    ghCleanFixture({ n17: issue(17), n19: state === 'unknown' ? null : pr(19, state) });
    const result = await run(['--repo', f.repo]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.remove.branches).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: 'feat/17-feature', kind: 'branch', reason: 'not merged' });
  });

  it('does not let an open linked item authorize dirty cleanup even for an integrated tip', async () => {
    const f = await linked('feat/17-feature');
    await git(f.dir, 'reset', '--hard', 'origin/main');
    writeFileSync(path.join(f.dir, 'draft.txt'), 'keep this draft\n');
    ghCleanFixture({ n17: issue(17, 'OPEN') });
    const result = await run(['--repo', f.repo]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(readFileSync(path.join(f.dir, 'draft.txt'), 'utf-8')).toBe('keep this draft\n');
  });

  it('allows tracked and untracked changes but still protects ignored hard-to-rebuild files', async () => {
    const f = await linked('feat/17-feature');
    ghCleanFixture({ n17: issue(17) });
    writeFileSync(path.join(f.dir, 'unique.txt'), 'changed tracked content\n');
    writeFileSync(path.join(f.dir, 'draft.txt'), 'untracked content\n');
    const permitted = await run(['--repo', f.repo]);
    expect(permitted.remove.worktrees).toStrictEqual([f.dir]);
    expect(permitted.removalDetails?.[0]?.recovery).toBeTruthy();
    await ignoreGlobally('.env.local');
    writeFileSync(path.join(f.dir, '.env.local'), 'TOKEN=keep\n');
    const protectedPlan = await run(['--repo', f.repo]);
    expect(protectedPlan.remove.worktrees).toStrictEqual([]);
    expect(protectedPlan.keep.find(item => item.id === f.dir)?.reason).toContain('!! .env.local');
  });

  it('lets closed basename evidence clean detached work while preserving its tip', async () => {
    const f = await linked('feature', '17-detached');
    await git(f.dir, 'switch', '--detach', '--quiet');
    ghCleanFixture({ n17: pr(17) });
    const result = await run(['--repo', f.repo]);
    expect(result.remove.worktrees).toStrictEqual([f.dir]);
    expect(result.removalDetails?.[0]).toMatchObject({ id: f.dir, reason: 'merged linked PR virtusize/aoyama#17', recovery: true });
  });

  it.each(['locked', 'caller', 'busy'] as const)('keeps closed linked worktrees when %s', async protection => {
    const f = await linked('feat/17-feature');
    ghCleanFixture({ n17: issue(17) });
    if (protection === 'locked') {
      await git(f.repo, 'worktree', 'lock', f.dir);
    } else if (protection === 'caller') {
      vi.spyOn(process, 'cwd').mockReturnValue(f.dir);
    } else {
      writeTernLs({ work: [f.dir] });
      writeFileSync(
        path.join(process.env.FAKE_TERN_DIR ?? '', 'process-1.json'),
        JSON.stringify({ child: null, foreground: { argv: ['omp'], cwd: f.dir, name: 'omp', pid: 63_500 }, group: 63_500, pane: 1 }),
      );
    }
    try {
      const result = await run(['--repo', f.repo]);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.remove.branches).toStrictEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps valid partial GitHub evidence when another linked number does not exist', async () => {
    const f = await linked('feat/17-feature');
    await git(f.repo, 'branch', 'feat/999-missing', 'feat/17-feature');
    ghCleanFixture({}, [{ data: { r0: { merged: { nodes: [] }, n17: issue(17), n999: null } }, errors: [{ message: 'Could not resolve number 999' }] }]);
    const result = await run(['--repo', f.repo]);
    expect(result.remove.branches).toContain('feat/17-feature');
    expect(result.keep).toContainEqual({ id: 'feat/999-missing', kind: 'branch', reason: 'not merged' });
    expect(result.warnings).toContain('merged PR check failed: Could not resolve number 999');
  });

  it('uses merged evidence on later pages without making per-branch GitHub calls', async () => {
    const f = await linked('worker');
    const output = await git(f.dir, 'rev-parse', 'HEAD');
    const head = output.trim();
    ghCleanFixture({}, [{ data: { r0: { merged: { nodes: [] } } } }, { data: { r0: { merged: { nodes: [{ headRefOid: head }] } } } }]);
    const log = await logGitCalls();
    const result = await run(['--repo', f.repo]);
    expect(result.remove.branches).toStrictEqual(['worker']);
    expect(readLog(log).filter(line => line.includes('merge-base --is-ancestor'))).toStrictEqual([]);
    expect(readLog(log).filter(line => line.includes('merge-tree'))).toStrictEqual([]);
    expect(ghLog()).toHaveLength(1);
  });

  it('does not require a linked branch to be checked out', async () => {
    const f = await linked('feat/17-feature');
    await git(f.dir, 'switch', '--detach', '--quiet', 'origin/main');
    ghCleanFixture({ n17: issue(17) });
    const result = await run(['--repo', f.repo]);
    expect(result.remove.branches).toStrictEqual(['feat/17-feature']);
    expect(result.removalDetails).toContainEqual({ id: 'feat/17-feature', kind: 'branch', reason: 'closed linked issue virtusize/aoyama#17', recovery: true });
  });

  it('keeps unknown links when GitHub returns no usable evidence', async () => {
    const f = await linked('feat/17-feature');
    ghCleanFixture({}, [{ data: { r0: null } }]);
    const result = await run(['--repo', f.repo]);
    expect(result.remove.branches).toStrictEqual([]);
    expect(result.warnings).toContain('merged PR check failed: repository inspection unavailable');
  });

  it('fails conservatively when branch associations cannot be read', async () => {
    const f = await linked('feat/17-feature');
    await gitShim('case " $* " in *" config --null --get-regexp "*) echo config-unavailable >&2; exit 2;; esac');
    const result = await run(['--repo', f.repo]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.warnings).toContain('merged PR check failed: config-unavailable');
  });
});
