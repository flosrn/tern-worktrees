import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import type { FinishPlan } from '../src/finish-types.ts';
import {
  ghFixture,
  ghLog,
  git,
  gitShim,
  ignoreGlobally,
  logGitCalls,
  managedPath,
  readLog,
  tempDir,
  tmpRepo,
  useGithubOrigin,
  useSandbox,
  writeTernLs,
  writeTernLsRaw,
} from './helpers.ts';

// SAFETY: the plan command returns the public FinishPlan contract.
const planned = async (...args: string[]): Promise<FinishPlan> => (await run(['plan', ...args])) as FinishPlan;

const fixture = async () => {
  const repo = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(repo.dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  await useGithubOrigin();
  ghFixture(
    [
      'pr',
      'list',
      '--repo',
      'virtusize/aoyama',
      '--head',
      'delivered',
      '--state',
      'merged',
      '--limit',
      '100',
      '--json',
      'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
    ],
    JSON.stringify([
      {
        headRefName: 'delivered',
        headRefOid: head,
        isCrossRepository: false,
        mergeCommit: { oid: head },
        mergedAt: '2026-11-01T10:00:00Z',
        number: 7,
        state: 'MERGED',
        url: 'https://github.com/virtusize/aoyama/pull/7',
      },
    ]),
  );
  ghFixture(['api', `repos/virtusize/aoyama/git/trees/${head}?recursive=1`], JSON.stringify({ sha: head, tree: [], truncated: false }));
  return { ...repo, head, target };
};

describe('finish planning conditions', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  it('does not prompt for other merged targets when no current or owned target exists', async () => {
    const { dir, target } = await fixture();
    const plan = await planned('--repo', dir);
    expect(plan.current).toBeNull();
    expect(plan.ready).toBeFalsy();
    expect(plan.candidates.map(candidate => candidate.path)).toStrictEqual([target]);
  });

  it('refuses a current subdirectory or another repository checkout', async () => {
    const { dir, target } = await fixture();
    mkdirSync(path.join(target, 'inside'));
    await expect(planned('--repo', dir, '--current', path.join(target, 'inside'))).rejects.toThrow('must be a checkout');
    const another = await tmpRepo('other');
    await expect(planned('--repo', dir, '--current', another.dir)).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('records unmanaged owned paths and never selects them', async () => {
    const { dir } = await fixture();
    const unmanaged = tempDir('finish-unmanaged');
    const result = await planned('--repo', dir, '--owned', unmanaged);
    expect(result.keep.filter(item => item.path === unmanaged)).toStrictEqual([{ code: 'not_managed', path: unmanaged }]);
    expect(result.ready).toBeFalsy();
  });

  it.each(['main', 'unmanaged'] as const)('explicitly retains an owned %s even when another managed worktree exists', async kind => {
    const { dir, target } = await fixture();
    const owned = kind === 'main' ? dir : tempDir('finish-owned-unmanaged');
    const result = await planned('--repo', dir, '--current', target, '--owned', owned);
    expect(result.candidates.map(candidate => candidate.path)).toStrictEqual([target]);
    expect(result.ready).toBeTruthy();
    expect(result.keep).toContainEqual({ code: 'not_managed', path: owned });
  });

  it('keeps a locked target before asking GitHub for approval', async () => {
    const { dir, target } = await fixture();
    await git(dir, 'worktree', 'lock', target);
    const result = await planned('--repo', dir, '--current', target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toContainEqual({ code: 'not_managed', path: target });
  });

  it('keeps unmanaged linked worktrees of the same repository', async () => {
    const { dir } = await fixture();
    const unmanaged = path.join(tempDir('finish-linked'), 'other');
    await git(dir, 'worktree', 'add', '-b', 'other', unmanaged);
    const result = await planned('--repo', dir, '--owned', unmanaged);
    expect(result.candidates.some(candidate => candidate.path === unmanaged)).toBeFalsy();
    expect(result.keep.filter(item => item.path === unmanaged)).toHaveLength(2);
  });

  it('rejects a detached managed worktree before consulting GitHub', async () => {
    const { dir, target } = await fixture();
    await git(target, 'checkout', '--detach');
    const log = await logGitCalls();
    const result = await planned('--repo', dir);
    expect({ candidates: result.candidates, githubCalls: ghLog(), ready: result.ready }).toStrictEqual({ candidates: [], githubCalls: [], ready: false });
    expect(result.keep).toContainEqual({ code: 'not_managed', path: target });
    expect(readLog(log).filter(line => line.startsWith(`-C ${target} `))).toStrictEqual([]);
  });

  it('rejects a clean unmanaged linked worktree before consulting GitHub for it', async () => {
    const { dir } = await tmpRepo('aoyama');
    const unmanaged = path.join(tempDir('finish-linked-clean'), 'delivered');
    await git(dir, 'worktree', 'add', '-b', 'delivered', unmanaged);
    await useGithubOrigin();
    const result = await planned('--repo', dir, '--current', unmanaged, '--owned', unmanaged);
    expect({ candidates: result.candidates, githubCalls: ghLog(), ready: result.ready }).toStrictEqual({ candidates: [], githubCalls: [], ready: false });
    expect(result.keep.filter(item => item.path === unmanaged)).toHaveLength(2);
    expect(result.keep.filter(item => item.path === unmanaged).every(item => item.code === 'not_managed')).toBeTruthy();
  });

  it('rejects a registered managed path replaced by a regular file before any checkout inspection', async () => {
    const { dir, head, target } = await fixture();
    const original = `${target}-original`;
    renameSync(target, original);
    writeFileSync(target, 'not a checkout directory');
    const listing = path.join(tempDir('finish-file-listing'), 'worktrees');
    writeFileSync(listing, `worktree ${dir}\0HEAD ${head}\0branch refs/heads/main\0\0worktree ${target}\0HEAD ${head}\0branch refs/heads/delivered\0\0`);
    const log = await logGitCalls();
    await gitShim(`case "$*" in *'worktree list --porcelain -z') cat '${listing}'; exit 0;; esac`);
    const result = await planned('--repo', dir);
    expect({ candidates: result.candidates, ready: result.ready }).toStrictEqual({ candidates: [], ready: false });
    expect(result.keep).toContainEqual({ code: 'path_identity_changed', path: target });
    expect({ githubCalls: ghLog(), targetGitCalls: readLog(log).filter(line => line.startsWith(`-C ${target} `)) }).toStrictEqual({ githubCalls: [], targetGitCalls: [] });
    expect(readFileSync(target, 'utf-8')).toBe('not a checkout directory');
    expect(existsSync(original)).toBeTruthy();
  });

  it.each([true, false])('plans ignored hard-to-rebuild files only when their main-checkout copy has the same bytes: identical=%s', async identical => {
    const { dir, target } = await fixture();
    await ignoreGlobally('.env');
    writeFileSync(path.join(dir, '.env'), 'DELIVERY_KEY=preserved\n');
    writeFileSync(path.join(target, '.env'), identical ? 'DELIVERY_KEY=preserved\n' : 'DELIVERY_KEY=unique\n');
    const result = await planned('--repo', dir, '--current', target);
    expect({ candidates: result.candidates.map(candidate => candidate.path), ready: result.ready }).toStrictEqual({ candidates: identical ? [target] : [], ready: identical });
    expect(result.keep.some(item => item.path === target)).toBe(!identical);
    expect(readFileSync(path.join(target, '.env'), 'utf-8')).toBe(identical ? 'DELIVERY_KEY=preserved\n' : 'DELIVERY_KEY=unique\n');
  });
});

describe('finish owned registration boundaries', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  it.each(['owned', 'current and owned'] as const)('explicitly retains an unlisted %s path even when another managed entry exists', async kind => {
    const { dir, head, target } = await fixture();
    const unlisted = managedPath('unlisted');
    await git(dir, 'worktree', 'add', '-b', 'unlisted', unlisted);
    const listing = path.join(tempDir('finish-unlisted-worktree'), 'worktrees');
    writeFileSync(listing, `worktree ${dir}\0HEAD ${head}\0branch refs/heads/main\0\0worktree ${target}\0HEAD ${head}\0branch refs/heads/delivered\0\0`);
    const log = await logGitCalls();
    await gitShim(`case "$*" in *'worktree list --porcelain -z') cat '${listing}'; exit 0;; esac`);
    const current = kind === 'current and owned' ? unlisted : target;
    const result = await planned('--repo', dir, '--current', current, '--owned', unlisted, '--owned', target);
    expect({ candidates: result.candidates.map(candidate => candidate.path), current: result.current, ready: result.ready }).toStrictEqual({
      candidates: [target],
      current,
      ready: true,
    });
    expect(result.keep.filter(item => item.path === unlisted)).toStrictEqual([{ code: 'not_managed', path: unlisted }]);
    expect({ removals: readLog(log).filter(line => /worktree remove|branch -[dD]|update-ref/u.test(line)), unlistedExists: existsSync(unlisted) }).toStrictEqual({
      removals: [],
      unlistedExists: true,
    });
  });

  it('explicitly retains an owned main checkout even when its path has the managed worktree shape', async () => {
    const { dir: original, target } = await fixture();
    const main = managedPath('aoyama');
    renameSync(original, main);
    await git(main, 'worktree', 'repair', target);
    const log = await logGitCalls();
    const result = await planned('--repo', main, '--current', target, '--owned', main, '--owned', target);
    expect({ candidates: result.candidates.map(candidate => candidate.path), ready: result.ready, repo: result.repo }).toStrictEqual({
      candidates: [target],
      ready: true,
      repo: main,
    });
    expect(result.keep).toContainEqual({ code: 'not_managed', path: main });
    expect({
      mainExists: existsSync(main),
      removals: readLog(log).filter(line => /worktree remove|branch -[dD]|update-ref/u.test(line)),
      targetExists: existsSync(target),
    }).toStrictEqual({ mainExists: true, removals: [], targetExists: true });
  });
});

describe('finish readiness and command conditions', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  it('requires post-merge success for every current or owned candidate, not just one', async () => {
    const { dir, head, target } = await fixture();
    const pending = managedPath('pending-delivery');
    await git(dir, 'worktree', 'add', '-b', 'pending-delivery', pending);
    const merge = 'd'.repeat(40);
    ghFixture(
      [
        'pr',
        'list',
        '--repo',
        'virtusize/aoyama',
        '--head',
        'pending-delivery',
        '--state',
        'merged',
        '--limit',
        '100',
        '--json',
        'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
      ],
      JSON.stringify([
        {
          headRefName: 'pending-delivery',
          headRefOid: head,
          isCrossRepository: false,
          mergeCommit: { oid: merge },
          mergedAt: '2026-11-01T10:00:00Z',
          number: 8,
          state: 'MERGED',
          url: 'https://github.com/virtusize/aoyama/pull/8',
        },
      ]),
    );
    ghFixture(
      ['api', `repos/virtusize/aoyama/git/trees/${merge}?recursive=1`],
      JSON.stringify({ sha: merge, tree: [{ mode: '100644', path: '.github/workflows/delivery.yml', sha: 'e'.repeat(40), type: 'blob' }], truncated: false }),
    );
    ghFixture(
      ['api', 'repos/virtusize/aoyama/actions/workflows?per_page=100&page=1'],
      JSON.stringify({ total_count: 1, workflows: [{ id: 1, name: 'Delivery', path: '.github/workflows/delivery.yml', state: 'active' }] }),
    );
    ghFixture(
      ['api', `repos/virtusize/aoyama/contents/.github/workflows/delivery.yml?ref=${merge}`],
      JSON.stringify({
        content: Buffer.from('on: push\njobs:\n  delivery:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo delivered\n').toString('base64'),
        encoding: 'base64',
        path: '.github/workflows/delivery.yml',
        type: 'file',
      }),
    );
    ghFixture(['api', 'repos/virtusize/aoyama/pulls/8'], JSON.stringify({ base: { ref: 'main' } }));
    ghFixture(['api', `repos/virtusize/aoyama/actions/runs?head_sha=${merge}&per_page=100&page=1`], JSON.stringify({ total_count: 0, workflow_runs: [] }));
    const result = await planned('--repo', dir, '--current', target, '--owned', pending);
    expect(result.candidates.map(candidate => candidate.path).toSorted()).toStrictEqual([pending, target].toSorted());
    expect(result.ready).toBeFalsy();
    expect(result.warnings).toHaveLength(1);
    expect(ghLog()).toContain(`api repos/virtusize/aoyama/git/trees/${head}?recursive=1`);
    expect(ghLog()).toContain(`api repos/virtusize/aoyama/actions/runs?head_sha=${merge}&per_page=100&page=1`);
  });

  it('keeps targets when Tern returns malformed JSON structure', async () => {
    const { dir, target } = await fixture();
    writeTernLsRaw('{"sessions":[{"tabs":null}]}');
    const result = await planned('--repo', dir, '--current', target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toContainEqual(expect.objectContaining({ code: 'tern_failed', path: target }));
  });

  it('keeps a target when Tern inspection fails', async () => {
    const { dir, target } = await fixture();
    vi.stubEnv('FAKE_TERN_FAIL', 'ls');
    const result = await planned('--repo', dir, '--current', target);
    expect(result.ready).toBeFalsy();
    expect(result.keep).toContainEqual({ code: 'tern_failed', detail: 'fake tern: ls failed', path: target });
  });

  it('does not claim workflow success when the merge commit cannot be examined', async () => {
    const { dir, target, head } = await fixture();
    ghFixture(['api', `repos/virtusize/aoyama/git/trees/${head}?recursive=1`], '{}');
    const result = await planned('--repo', dir, '--current', target);
    expect(result.ready).toBeFalsy();
    expect(result.warnings).toContain('Post-merge workflows are pending, failed, or their success cannot be proven.');
  });

  it('keeps targets when merged PR response is invalid or unavailable', async () => {
    const { dir, target } = await fixture();
    ghFixture(
      [
        'pr',
        'list',
        '--repo',
        'virtusize/aoyama',
        '--head',
        'delivered',
        '--state',
        'merged',
        '--limit',
        '100',
        '--json',
        'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
      ],
      '{}',
    );
    const result = await planned('--repo', dir, '--current', target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toContainEqual(expect.objectContaining({ code: 'gh_failed', path: target }));
  });

  it('keeps all candidates without a GitHub origin', async () => {
    const { dir } = await tmpRepo('aoyama');
    const target = managedPath('local-only');
    await git(dir, 'worktree', 'add', '-b', 'local-only', target);
    const result = await planned('--repo', dir, '--current', target);
    expect(result.ready).toBeFalsy();
    expect(result.candidates).toStrictEqual([]);
    expect(ghLog()).toStrictEqual([]);
  });

  it('does not inspect an undefined process when the caller PID is omitted', async () => {
    const { dir, target } = await fixture();
    const undefinedProcess = path.join(process.env.TERN_WT_PROC_ROOT ?? '', 'undefined');
    mkdirSync(undefinedProcess);
    const result = await planned('--repo', dir, '--current', target);
    expect({ candidates: result.candidates.map(candidate => candidate.path), ready: result.ready }).toStrictEqual({ candidates: [target], ready: true });
    const status = await run(['status', result.id]);
    expect(status).toMatchObject({ id: result.id, status: 'planned' });
  });

  it('validates command arguments before plan storage or teardown', async () => {
    await expect(run(['plan'])).rejects.toThrow('needs --repo');
    await expect(run(['plan', '--repo', 'none', '--pid', '0'])).rejects.toThrow('positive numeric');
    await expect(run(['arm', 'id', '--choice', 'invented'])).rejects.toThrow('current|merged|none');
    await expect(run(['--nope'])).rejects.toThrow('--nope');
    await expect(run(['status'])).rejects.toThrow('finish needs');
  });

  it('rejects unknown commands even when one positional argument is present', async () => {
    await expect(run(['other', 'id'])).rejects.toThrow('finish needs');
    await expect(run(['notices', '--unknown'])).rejects.toThrow('--unknown');
  });
});
