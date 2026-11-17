import { chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { filesUnder, gitRun } from '../src/git.ts';
import { must } from '../src/proc.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { git, gitShim, ignoreGlobally, rejection, tempDir, tmpRepo, useSandbox, writeFiles } from './helpers.ts';

/** A main checkout with the submodule at `sub`, and a linked worktree where it is not initialized. */
const uninitializedSubmodule = async (sub = 'vendor'): Promise<{ checkout: string; main: string }> => {
  const vendor = await tmpRepo('vendor');
  const repo = await tmpRepo();
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', vendor.origin, sub);
  await git(repo.dir, 'commit', '--quiet', '-m', 'add vendor');
  const checkout = tempDir('feature');
  await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', checkout);
  return { checkout, main: repo.dir };
};

/** A main checkout with the submodule `outer`, which holds the submodule `inner`, and a linked worktree where only `outer` is initialized. */
const uninitializedNestedSubmodule = async (): Promise<{ checkout: string; main: string }> => {
  const inner = await tmpRepo('inner');
  const outer = await tmpRepo('outer');
  await git(outer.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', inner.dir, 'inner');
  await git(outer.dir, 'commit', '--quiet', '-m', 'add inner');
  await git(outer.dir, 'push', '--quiet', 'origin', 'main');
  const repo = await tmpRepo();
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', outer.origin, 'outer');
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init', '--recursive');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add outer');
  const checkout = tempDir('feature');
  await git(repo.dir, 'worktree', 'add', '--quiet', '--detach', checkout);
  await git(checkout, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init', 'outer');
  return { checkout, main: repo.dir };
};

describe('work to lose in submodule paths that are not initialized', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('keeps the worktree when a gitlink path cannot be decoded without loss', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    await gitShim(`if [ "$3 $5" = 'ls-files --stage' ]; then printf '160000 0000000000000000000000000000000000000000 0\\tvendor-\\377\\0'; exit 0; fi`);
    await Promise.all(
      (['recreating', { removing: main }] as const).map(async operation => {
        const failure = guardWorkToLose(checkout, operation, main);
        await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
        await expect(failure).rejects.toThrow(/path name.*UTF-8/u);
      }),
    );
  });

  it('reads gitlinks when a tracked file that is not a submodule has a name that is not UTF-8', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    // APFS refuses the name, so the sparse checkout of the worktree does not hold it.
    await must(['sh', '-c', `blob=$(echo hi | git hash-object -w --stdin) && git update-index --add --cacheinfo "100644,$blob,docs/caf$(printf '\\351').txt"`], 'git_failed', {
      cwd: main,
    });
    await git(main, 'commit', '--quiet', '-m', 'latin-1 name');
    await git(checkout, 'sparse-checkout', 'set', '--no-cone', '/*', '!/docs/');
    await git(checkout, 'checkout', '--quiet', '--detach', 'main');
    await expect(guardWorkToLose(checkout, 'recreating', main)).resolves.toStrictEqual([]);
    await expect(guardWorkToLose(checkout, { removing: main }, main)).resolves.toStrictEqual([]);
    writeFiles(checkout, { 'vendor/notes.md': 'notes\n' });
    const error = await rejection(guardWorkToLose(checkout, { removing: main }, main));
    expect(error.extra).toStrictEqual({ changes: [], existing: checkout, files: ['!! vendor/notes.md'], hardToRebuild: ['vendor/notes.md'] });
  });

  it('stops teardown on each file in a submodule path that is not initialized', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    writeFiles(checkout, { 'vendor/draft/x.txt': 'draft\n', 'vendor/notes.md': 'notes\n' });
    const error = await rejection(guardWorkToLose(checkout, { removing: main }, main));
    expect([error.code, error.message]).toStrictEqual(['dirty_worktree', `${checkout} has work that removing it would lose`]);
    const hardToRebuild = ['vendor/draft/x.txt', 'vendor/notes.md'];
    expect(error.extra).toStrictEqual({ changes: [], existing: checkout, files: hardToRebuild.map(file => `!! ${file}`), hardToRebuild });
  });

  it('lists each file of a directory that holds .git in a submodule path that is not initialized, so a copy in the main checkout counts', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    writeFiles(main, { 'vendor/pocket/notes.md': 'notes\n' });
    writeFiles(checkout, { 'vendor/pocket/.git': 'gitdir: elsewhere\n', 'vendor/pocket/notes.md': 'notes\n' });
    const error = await rejection(guardWorkToLose(checkout, { removing: main }, main));
    expect(error.extra).toStrictEqual({ changes: [], existing: checkout, files: ['!! vendor/pocket/.git'], hardToRebuild: ['vendor/pocket/.git'] });
  });

  it('stops relocate on each file in a submodule path that is not initialized, and carries none', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    await ignoreGlobally('.env');
    writeFiles(checkout, { '.env': 'SECRET=1\n', 'vendor/draft/x.txt': 'draft\n', 'vendor/notes.md': 'notes\n' });
    const error = await rejection(guardWorkToLose(checkout, 'recreating', main));
    expect([error.code, error.message]).toStrictEqual(['dirty_worktree', `${checkout} has work that recreating it would lose`]);
    const hardToRebuild = ['vendor/draft/x.txt', 'vendor/notes.md'];
    expect(error.extra).toStrictEqual({ changes: [], existing: checkout, files: hardToRebuild.map(file => `!! ${file}`), hardToRebuild });
  });

  it('stops teardown on a file in a submodule path that is not initialized inside an initialized submodule', async () => {
    const { checkout, main } = await uninitializedNestedSubmodule();
    writeFiles(checkout, { 'outer/inner/notes.md': 'notes\n' });
    const error = await rejection(guardWorkToLose(checkout, { removing: main }, main));
    expect(error.extra).toStrictEqual({ changes: [], existing: checkout, files: ['!! outer/inner/notes.md'], hardToRebuild: ['outer/inner/notes.md'] });
  });

  it('stops neither operation on an empty submodule path that is not initialized, and only on the deletion when it is missing', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    await expect(guardWorkToLose(checkout, 'recreating', main)).resolves.toStrictEqual([]);
    await expect(guardWorkToLose(checkout, { removing: main }, main)).resolves.toStrictEqual([]);
    rmSync(path.join(checkout, 'vendor'), { recursive: true });
    const deleted = { changes: [' D vendor'], existing: checkout, files: [' D vendor'], hardToRebuild: [] };
    await expect(rejection(guardWorkToLose(checkout, 'recreating', main))).resolves.toMatchObject({ code: 'dirty_worktree', extra: deleted });
    await expect(rejection(guardWorkToLose(checkout, { removing: main }, main))).resolves.toMatchObject({ code: 'dirty_worktree', extra: deleted });
  });

  it('gives the status of a submodule path whose parent became a file, as for a missing path', async () => {
    const { checkout, main } = await uninitializedSubmodule('lib/vendor');
    rmSync(path.join(checkout, 'lib'), { recursive: true });
    writeFiles(checkout, { lib: 'f\n' });
    const lost = { changes: [' D lib/vendor', '?? lib'], existing: checkout, files: [' D lib/vendor', '?? lib'], hardToRebuild: [] };
    await expect(rejection(guardWorkToLose(checkout, 'recreating', main))).resolves.toMatchObject({ code: 'dirty_worktree', extra: lost });
    await expect(rejection(guardWorkToLose(checkout, { removing: main }, main))).resolves.toMatchObject({ code: 'dirty_worktree', extra: lost });
  });

  it('refuses with only the worktree when a submodule path that is not initialized cannot be examined', async () => {
    const { checkout } = await uninitializedSubmodule('lib/vendor');
    chmodSync(path.join(checkout, 'lib'), 0o000);
    try {
      expect(() => filesUnder(checkout, 'lib/vendor')).toThrow(expect.objectContaining({ code: 'dirty_worktree', extra: { existing: checkout } }));
      expect(() => filesUnder(checkout, 'lib/vendor')).toThrow(/could not be read: .*EACCES/u);
    } finally {
      chmodSync(path.join(checkout, 'lib'), 0o755);
    }
  });

  it('does not stop teardown on a file in a submodule path that is not initialized with the same bytes as the file in the main checkout', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    writeFiles(main, { 'vendor/notes.md': 'notes\n' });
    writeFiles(checkout, { 'vendor/notes.md': 'notes\n' });
    await expect(guardWorkToLose(checkout, { removing: main }, main)).resolves.toStrictEqual([]);
  });

  it('refuses with only the worktree when a submodule path that is not initialized cannot be read', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    writeFiles(checkout, { 'vendor/draft/x.txt': 'draft\n' });
    chmodSync(path.join(checkout, 'vendor', 'draft'), 0o000);
    try {
      const error = await rejection(guardWorkToLose(checkout, { removing: main }, main));
      expect([error.code, error.extra]).toStrictEqual(['dirty_worktree', { existing: checkout }]);
      expect(error.message).toMatch(/could not be read: .*EACCES/u);
    } finally {
      chmodSync(path.join(checkout, 'vendor', 'draft'), 0o755);
    }
  });

  it('lists each file once when a submodule path that is not initialized has a merge conflict', async () => {
    const { checkout, main } = await uninitializedSubmodule();
    const vendor = path.join(main, 'vendor');
    await git(vendor, 'commit', '--quiet', '--allow-empty', '-m', 'theirs');
    const theirs = await git(vendor, 'rev-parse', 'HEAD');
    await git(vendor, 'switch', '--quiet', '--detach', 'HEAD~1');
    await git(vendor, 'commit', '--quiet', '--allow-empty', '-m', 'ours');
    await git(main, 'commit', '--quiet', '-am', 'pin ours');
    await git(checkout, 'update-index', '--cacheinfo', `160000,${theirs.trim()},vendor`);
    await git(checkout, 'commit', '--quiet', '-m', 'pin theirs');
    await gitRun(checkout, 'merge', '--quiet', 'main');
    writeFiles(checkout, { 'vendor/notes.md': 'notes\n' });
    const error = await rejection(guardWorkToLose(checkout, { removing: main }, main));
    expect(error.extra).toStrictEqual({ changes: ['UU vendor'], existing: checkout, files: ['UU vendor', '!! vendor/notes.md'], hardToRebuild: ['vendor/notes.md'] });
  });
});
