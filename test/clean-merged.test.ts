import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/clean.ts';
import { ghFixture, git, gitShim, readLog, tempDir, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const mergedQuery = ['pr', 'list', '--repo', 'virtusize/aoyama', '--state', 'merged', '--limit', '10000', '--json', 'headRefName,headRefOid,number'];

const commitFile = async (dir: string, file: string, content: string): Promise<void> => {
  writeFileSync(path.join(dir, file), content);
  await git(dir, 'add', file);
  await git(dir, 'commit', '--quiet', '-m', file);
};

describe('clean integration proofs', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({ work: [] });
  });

  it('queries merged PRs once and removes workers integrated through a differently named PR', async () => {
    const repo = await tmpRepo('app');
    const worker = path.join(tempDir('workers'), 'worker');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'worker', worker, 'origin/main');
    await commitFile(worker, 'worker.txt', 'integrated worker\n');
    await git(repo.dir, 'branch', 'second-worker', 'worker');
    await git(worker, 'switch', '--quiet', '-c', 'integration');
    await commitFile(worker, 'integration.txt', 'integration work\n');
    const tip = (await git(worker, 'rev-parse', 'HEAD')).trim();
    await git(worker, 'switch', '--quiet', 'worker');
    await useGithubOrigin();
    ghFixture(mergedQuery, JSON.stringify([{ headRefName: 'integration', headRefOid: tip, number: 17 }]));
    const result = await run(['--repo', repo.dir, '--apply']);
    expect(result.remove.branches).toStrictEqual(['integration', 'second-worker', 'worker']);
    expect(result.remove.worktrees).toStrictEqual([worker]);
    const log = process.env.FAKE_GH_LOG;
    expect(log).toBeDefined();
    expect(existsSync(worker)).toBeFalsy();
    expect(readLog(log ?? '').filter(line => line.startsWith('pr list'))).toStrictEqual([mergedQuery.join(' ')]);
  });

  it('removes an unpushed multi-commit worker squashed into default while preserving new work', async () => {
    const repo = await tmpRepo('app');
    const worker = path.join(tempDir('workers'), 'worker');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'worker', worker, 'origin/main');
    await commitFile(worker, 'one.txt', 'one\n');
    await commitFile(worker, 'two.txt', 'two\n');
    await git(repo.dir, 'merge', '--quiet', '--squash', 'worker');
    await git(repo.dir, 'commit', '--quiet', '-m', 'squash workers');
    await git(repo.dir, 'push', '--quiet', 'origin', 'main');
    await commitFile(repo.dir, 'later.txt', 'later default work\n');
    await git(repo.dir, 'push', '--quiet', 'origin', 'main');
    const integrated = await run(['--repo', repo.dir]);
    expect(integrated.remove.worktrees).toStrictEqual([worker]);
    expect(integrated.remove.branches).toStrictEqual(['worker']);
    await commitFile(worker, 'unique.txt', 'not integrated\n');
    const unique = await run(['--repo', repo.dir]);
    expect(unique.remove.branches).toStrictEqual([]);
    expect(unique.remove.worktrees).toStrictEqual([]);
    expect(unique.keep).toContainEqual({ id: 'worker', kind: 'branch', reason: 'not merged' });
  });

  it('preserves a branch when merging conflicts even if stdout names the default tree', async () => {
    const repo = await tmpRepo('app');
    const worker = path.join(tempDir('workers'), 'worker');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'worker', worker, 'origin/main');
    await commitFile(worker, 'README.md', 'worker version\n');
    await commitFile(repo.dir, 'README.md', 'default version\n');
    await git(repo.dir, 'push', '--quiet', 'origin', 'main');
    const tree = (await git(repo.dir, 'rev-parse', 'origin/main^{tree}')).trim();
    await gitShim(`case " $* " in *" merge-tree --write-tree "*) printf '%s\\n' '${tree}'; exit 1;; esac`);
    const result = await run(['--repo', repo.dir]);
    expect(result.remove.branches).toStrictEqual([]);
    expect(result.remove.worktrees).toStrictEqual([]);
    expect(result.keep).toContainEqual({ id: 'worker', kind: 'branch', reason: 'not merged' });
  });
});
