import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanLinks, cleanReachability } from '../src/clean-linked.ts';
import { applyResources, planResources } from '../src/clean-resources.ts';
import { run } from '../src/commands/clean.ts';
import { run as runProcess } from '../src/proc.ts';
import { ls, processOf } from '../src/tern.ts';
import { resourceFixture } from './clean-resource-fixture.ts';
import { ghCleanFixture, git, gitShim, logGitCalls, readLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

vi.mock(import('../src/proc.ts'), { spy: true });
vi.mock(import('../src/tern.ts'), { spy: true });

describe('clean shared inspection contracts', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset();
    vi.mocked(ls).mockReset();
    vi.mocked(processOf).mockReset();
    useSandbox();
    writeTernLs({ work: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses one branch-tip batch and constant graph walks for many branches', async () => {
    const repo = await tmpRepo('app');
    for (let index = 1; index <= 30; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await git(repo.dir, 'branch', `branch-${index}`);
    }
    const log = await logGitCalls();
    const result = await run(['--repo', repo.dir]);
    expect(result.remove.branches).toHaveLength(30);
    const calls = readLog(log);
    expect(calls.filter(line => line.includes('for-each-ref'))).toHaveLength(1);
    expect(calls.filter(line => line.includes('rev-list'))).toHaveLength(2);
    expect(calls.filter(line => /(?:rev-parse refs\/heads|merge-base --is-ancestor|merge-tree)/u.test(line))).toStrictEqual([]);
  });

  it('never treats missing default history or a failed graph walk as an ancestry proof', async () => {
    const repo = await tmpRepo('app');
    const output = await git(repo.dir, 'rev-parse', 'HEAD');
    const heads = new Map([['main', output.trim()]]);
    const missing = await cleanReachability(repo.dir, 'missing', heads, [], []);
    expect(missing.proven).toStrictEqual(new Set());
    await gitShim('case " $* " in *" rev-list --ignore-missing "*) exit 1;; esac');
    const failed = await cleanReachability(repo.dir, 'main', heads, [], []);
    expect(failed.proven).toStrictEqual(new Set());
  });

  it('never queries GitHub without a GitHub origin', async () => {
    await expect(cleanLinks('/unused', null, [], [], [])).resolves.toStrictEqual({ branches: new Map(), mergedHeads: [], worktrees: new Map() });
  });

  it('deduplicates inferred and configured associations, ignoring invalid settings and malformed merged heads', async () => {
    const repo = await tmpRepo('app');
    await git(repo.dir, 'branch', 'feat/17-title');
    await git(repo.dir, 'branch', 'custom');
    await git(repo.dir, 'config', 'branch.feat/17-title.ternIssue', '#17');
    await git(repo.dir, 'config', 'branch.custom.ternIssue', 'not-an-issue');
    await git(repo.dir, 'config', 'branch.stale.ternIssue', '#19');
    await useGithubOrigin();
    ghCleanFixture({ merged: { nodes: [{ headRefOid: 'not-a-sha' }] }, n17: { __typename: 'Issue', issueState: 'CLOSED', number: 17 } });
    const warnings: string[] = [];
    const result = await cleanLinks(repo.dir, { name: 'aoyama', owner: 'virtusize' }, ['feat/17-title', 'custom'], [], warnings);
    expect(result.branches.get('feat/17-title')).toBe('closed linked issue virtusize/aoyama#17');
    expect(result.branches.has('custom')).toBeFalsy();
    expect(result.mergedHeads).toStrictEqual([]);
    expect(warnings).toStrictEqual([]);
  });

  it.each([{ pages: [] }, { pages: [{ data: {} }] }])('fails closed on empty or missing GitHub evidence: %j', async ({ pages }) => {
    const repo = await tmpRepo('app');
    await useGithubOrigin();
    ghCleanFixture({}, pages);
    const warnings: string[] = [];
    const result = await cleanLinks(repo.dir, { name: 'aoyama', owner: 'virtusize' }, ['feat/17'], [], warnings);
    expect(result.branches.size).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not keep terminal authorization if an issue reopens during pagination', async () => {
    const repo = await tmpRepo('app');
    await useGithubOrigin();
    ghCleanFixture({}, [
      { data: { r0: { n17: { __typename: 'Issue', issueState: 'CLOSED', number: 17 } } } },
      { data: { r0: { n17: { __typename: 'Issue', issueState: 'CLOSED', number: 17 } } } },
      { data: { r0: { n17: { __typename: 'Issue', issueState: 'OPEN', number: 17 } } } },
    ]);
    const result = await cleanLinks(repo.dir, { name: 'aoyama', owner: 'virtusize' }, ['feat/17'], [], []);
    expect(result.branches.size).toBe(0);
  });

  it('does not authorize removal from a linked node without its selected state', async () => {
    const repo = await tmpRepo('app');
    await useGithubOrigin();
    ghCleanFixture({ n17: { __typename: 'Issue', number: 17 } });
    const result = await cleanLinks(repo.dir, { name: 'aoyama', owner: 'virtusize' }, ['feat/17'], [], []);
    expect(result.branches.size).toBe(0);
    expect(result.worktrees.size).toBe(0);
  });

  it('reselects resources without repeating process, Docker or Tern sampling', async () => {
    // SAFETY: the prototype supplies the full Process interface while only platform changes.
    const host = Object.create(process) as NodeJS.Process;
    Object.defineProperty(host, 'platform', { value: 'linux' });
    vi.stubGlobal('process', host);
    const f = resourceFixture();
    f.entry(920_001);
    f.block('/repo/remove');
    const first = await planResources({ ...f.ctx, removeWorktrees: [] });
    const sampledCalls = f.state.calls.length;
    const second = await planResources(f.ctx, first);
    expect(f.state.calls).toHaveLength(sampledCalls);
    expect(ls).toHaveBeenCalledOnce();
    expect(processOf).toHaveBeenCalledOnce();
    expect(second.processes.map(item => item.pid)).toStrictEqual([920_001]);
    await applyResources(second, second.warnings);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
