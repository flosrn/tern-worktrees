import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { git, gitShim, ignoreGlobally, managedPath, tempDir, tmpRepo, useOmp, useSandbox } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

const WITH_FILE = ['-c', 'protocol.file.allow=always'];

let repo: RepoFixture;
let mainSub: string;

/**
 * Gives the main checkout the submodule `lib/sub`, which holds the submodule `inner`, with an ignored `.env` in each. The branch
 * `feature/x` on `origin` records a newer commit of `lib/sub` than the main checkout has. Gives the commit of `lib/sub` in the main checkout.
 */
const addSubmodules = async (): Promise<string> => {
  const [sub, inner] = await Promise.all([tmpRepo('sub'), tmpRepo('inner')]);
  await git(sub.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', inner.dir, 'inner');
  await git(sub.dir, 'commit', '--quiet', '-m', 'add inner');
  await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', sub.dir, 'lib/sub');
  await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'update', '--init', '--recursive');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
  const cloned = await git(mainSub, 'rev-parse', 'HEAD');
  writeFileSync(path.join(mainSub, 'later.txt'), 'later\n');
  await git(mainSub, 'add', 'later.txt');
  await git(mainSub, 'commit', '--quiet', '-m', 'later');
  await git(repo.dir, 'commit', '--quiet', '-am', 'record later');
  await git(repo.dir, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/feature/x');
  await git(repo.dir, 'reset', '--quiet', '--hard', 'HEAD~1');
  await git(repo.dir, 'submodule', '--quiet', 'update', '--recursive');
  writeFileSync(path.join(mainSub, '.env'), 'BUILD=1\n');
  writeFileSync(path.join(mainSub, 'inner', '.env'), 'BUILD=2\n');
  return cloned;
};

describe('create command in omp clone mode with submodules', () => {
  beforeEach(async () => {
    useSandbox();
    repo = await tmpRepo('aoyama');
    mainSub = path.join(repo.dir, 'lib', 'sub');
    await ignoreGlobally('.env');
  });

  it('initializes from the main checkout without its remote and keeps independent objects', async () => {
    const sub = await tmpRepo('sub');
    await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', sub.dir, 'lib/sub');
    await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
    await git(repo.dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature/x');
    const recorded = await git(mainSub, 'rev-parse', 'HEAD');
    rmSync(sub.dir, { recursive: true });
    const result = await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
    expect(result).toMatchObject({ status: 'created', warnings: [] });
    const targetSub = path.join(managedPath('feature-x'), 'lib/sub');
    expect(readFileSync(path.join(targetSub, 'README.md'), 'utf-8')).toBe('test\n');
    await expect(git(targetSub, 'remote', 'get-url', 'origin')).resolves.toBe(`${sub.dir}\n`);
    const targetGit = await git(targetSub, 'rev-parse', '--absolute-git-dir');
    expect(existsSync(path.join(targetGit.trim(), 'objects/info/alternates'))).toBeFalsy();
    rmSync(path.join(repo.dir, '.git/modules'), { recursive: true });
    await expect(Promise.all([git(targetSub, 'show', 'HEAD:README.md'), git(targetSub, 'rev-parse', 'HEAD')])).resolves.toStrictEqual(['test\n', recorded]);
  });

  it.each([false, true])('initializes from a shallow main submodule after its remote disappears, with a later source tip %j', async later => {
    const sub = await tmpRepo('sub');
    await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', '--depth', '1', `file://${sub.origin}`, 'lib/sub');
    await git(repo.dir, 'config', '-f', '.gitmodules', 'submodule.lib/sub.shallow', 'true');
    await git(repo.dir, 'add', '.gitmodules', 'lib/sub');
    await git(repo.dir, 'commit', '--quiet', '-m', 'add shallow submodule');
    await git(repo.dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature/x');
    if (later) {
      writeFileSync(path.join(mainSub, 'later.txt'), 'later\n');
      await git(mainSub, 'add', 'later.txt');
      await git(mainSub, 'commit', '--quiet', '-m', 'later local tip');
    }
    await expect(git(mainSub, 'rev-parse', '--is-shallow-repository')).resolves.toBe('true\n');
    rmSync(sub.origin, { recursive: true });
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ warnings: [] });
    const targetSub = path.join(managedPath('feature-x'), 'lib/sub');
    const gitdir = await git(targetSub, 'rev-parse', '--absolute-git-dir');
    expect(existsSync(path.join(gitdir.trim(), 'objects/info/alternates'))).toBeFalsy();
    rmSync(path.join(repo.dir, '.git/modules'), { recursive: true });
    await expect(Promise.all([git(targetSub, 'show', 'HEAD:README.md'), git(targetSub, 'remote', 'get-url', 'origin')])).resolves.toStrictEqual([
      'test\n',
      `file://${sub.origin}\n`,
    ]);
  });

  it('warns when a shallow local SHA fetch fails and uses the original remote', async () => {
    const sub = await tmpRepo('sub');
    await git(repo.dir, 'config', '--global', 'protocol.file.allow', 'always');
    await git(repo.dir, 'submodule', '--quiet', 'add', '--depth', '1', `file://${sub.origin}`, 'lib/sub');
    await git(repo.dir, 'commit', '--quiet', '-m', 'add shallow submodule');
    await git(repo.dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature/x');
    writeFileSync(path.join(mainSub, 'later.txt'), 'later\n');
    await git(mainSub, 'add', 'later.txt');
    await git(mainSub, 'commit', '--quiet', '-m', 'later local tip');
    const targetSub = path.join(managedPath('feature-x'), 'lib/sub');
    await gitShim(`if [ "$2" = '${targetSub}' ] && [ "$5" = fetch ]; then echo 'local SHA fetch failed' >&2; exit 1; fi`);
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({
      warnings: ['local submodule reuse failed for lib/sub: local SHA fetch failed'],
    });
    await expect(Promise.all([git(targetSub, 'show', 'HEAD:README.md'), git(targetSub, 'remote', 'get-url', 'origin')])).resolves.toStrictEqual([
      'test\n',
      `file://${sub.origin}\n`,
    ]);
  });

  it('reuses a recorded commit even when it is no longer referenced in the main submodule', async () => {
    const sub = await tmpRepo('sub');
    await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', sub.dir, 'lib/sub');
    await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
    writeFileSync(path.join(mainSub, 'local.txt'), 'local-only\n');
    await git(mainSub, 'add', 'local.txt');
    await git(mainSub, 'commit', '--quiet', '-m', 'local commit');
    await git(repo.dir, 'commit', '--quiet', '-am', 'record local commit');
    await git(repo.dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature/x');
    await git(mainSub, 'repack', '-ad');
    await git(mainSub, 'reset', '--quiet', '--hard', 'HEAD~1');
    rmSync(sub.dir, { recursive: true });
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ warnings: [] });
    const targetSub = path.join(managedPath('feature-x'), 'lib/sub');
    rmSync(path.join(repo.dir, '.git/modules'), { recursive: true });
    await expect(git(targetSub, 'show', 'HEAD:local.txt')).resolves.toBe('local-only\n');
  });

  it('repairs the submodules that the clone copied: git works in them, at the recorded commits, with the cloned files kept', async () => {
    const base = tempDir('omp-wt');
    useOmp({ base, clone: true });
    const cloned = await addSubmodules();
    const target = path.join(base, 'aoyama', 'feature-x');
    const targetSub = path.join(target, 'lib', 'sub');
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'created', warnings: [] });
    const [recorded, gitDir] = await Promise.all([git(target, 'rev-parse', 'HEAD:lib/sub'), git(target, 'rev-parse', '--absolute-git-dir')]);
    expect(recorded).not.toBe(cloned);
    await expect(
      Promise.all([
        git(target, 'status', '--porcelain'),
        git(targetSub, 'status', '--porcelain'),
        git(path.join(targetSub, 'inner'), 'status', '--porcelain'),
        git(targetSub, 'rev-parse', 'HEAD'),
        git(targetSub, 'rev-parse', '--absolute-git-dir'),
        git(mainSub, 'rev-parse', 'HEAD'),
      ]),
    ).resolves.toStrictEqual(['', '', '', recorded, `${path.join(gitDir.trim(), 'modules', 'lib', 'sub')}\n`, cloned]);
    expect([readFileSync(path.join(targetSub, '.env'), 'utf-8'), readFileSync(path.join(targetSub, 'inner', '.env'), 'utf-8')]).toStrictEqual(['BUILD=1\n', 'BUILD=2\n']);
  });
});
