import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { FinishPlan } from '../src/finish-types.ts';
import { must } from '../src/proc.ts';
import { afterGitListing, git, gitShim, ignoreGlobally, managedPath, spawnCli, tempDir, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';

const fixture = async () => {
  const repo = await tmpRepo('runtime');
  const target = managedPath('delivered', 'runtime');
  await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'delivered', target);
  return { ...repo, target };
};

const plan = (repo: string, target: string): FinishPlan => {
  const output = spawnCli(['finish', 'plan', '--repo', repo, '--current', target, '--current-only']);
  expect(output.status).toBe(0);
  expect(output.stderr).toBe('');
  // SAFETY: the real CLI returned the successful FinishPlan JSON envelope.
  return JSON.parse(output.stdout) as FinishPlan;
};

describe('ignored-file safety through the real Bun CLI', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  it('keeps an invalid-byte directory and valid replacement-character sibling', async () => {
    const { dir, target } = await fixture();
    await gitShim(`if [ "$3" = ls-files ]; then printf 'local-\\377/\\0local-\\357\\277\\275/\\0'; exit 0; fi`);
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toHaveLength(1);
    expect(result.keep[0]).toMatchObject({ code: 'dirty_worktree', path: target });
    expect(result.keep[0].detail).toMatch(/path name.*UTF-8/u);
    expect(existsSync(target)).toBeTruthy();
  });

  it('reads a symbolic link and nested repository in a collapsed ignored directory', async () => {
    const { dir, target } = await fixture();
    await ignoreGlobally('local/');
    const nested = path.join(target, 'local', 'nested');
    mkdirSync(nested, { recursive: true });
    await git(nested, 'init', '--quiet');
    writeFileSync(path.join(nested, 'private.env'), 'local settings\n');
    writeFileSync(path.join(target, 'local', '00.tsbuildinfo'), 'generated\n');
    symlinkSync('missing', path.join(target, 'local', 'link'));
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
    expect(existsSync(path.join(nested, 'private.env'))).toBeTruthy();
  });

  it('keeps a directory that becomes unreadable after the initial Git listing', async () => {
    const { dir, target } = await fixture();
    await ignoreGlobally('local/');
    const secrets = path.join(target, 'local', 'secrets');
    mkdirSync(secrets, { recursive: true });
    writeFileSync(path.join(secrets, 'private.env'), 'local settings\n');
    writeFileSync(path.join(target, 'local', '00.tsbuildinfo'), 'generated\n');
    await gitShim(`if [ "$3" = ls-files ]; then chmod 000 '${secrets}'; printf 'local/\\0'; exit 0; fi`);
    try {
      const result = plan(dir, target);
      expect(result.candidates).toStrictEqual([]);
      expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
      expect(result.keep[0].detail).toMatch(/could not be read/u);
    } finally {
      chmodSync(secrets, 0o700);
    }
    expect(existsSync(path.join(secrets, 'private.env'))).toBeTruthy();
  });

  it('keeps a partial Git result even when the warning has exit status zero', async () => {
    const { dir, target } = await fixture();
    await gitShim(`if [ "$3" = ls-files ]; then printf 'local/00.tsbuildinfo\\0'; echo 'warning: could not open local/secrets/: Permission denied' >&2; exit 0; fi`);
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
    expect(result.keep[0].detail).toMatch(/Permission denied/u);
    expect(existsSync(target)).toBeTruthy();
  });

  it('keeps a collapsed directory replaced with a symbolic link after the real Git listing', async () => {
    const { dir, target } = await fixture();
    await ignoreGlobally('*');
    const local = path.join(target, 'local');
    const saved = path.join(target, 'saved-local');
    const empty = tempDir('empty-link-target');
    mkdirSync(local);
    writeFileSync(path.join(local, 'private.env'), 'local settings\n');
    const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
    const realGit = gitPath.trim();
    await gitShim(`if [ "$3" = ls-files ]; then
  '${realGit}' "$@"
  status=$?
  mv '${local}' '${saved}'
  ln -s '${empty}' '${local}'
  exit "$status"
fi`);
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
    expect(existsSync(path.join(saved, 'private.env'))).toBeTruthy();
  });

  it('keeps a listed ignored file replaced by a directory before inspection', async () => {
    const { dir, target } = await fixture();
    await ignoreGlobally('*');
    const file = path.join(target, 'local.tsbuildinfo');
    writeFileSync(file, 'generated\n');
    const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
    const realGit = gitPath.trim();
    await gitShim(`if [ "$3" = ls-files ]; then
  '${realGit}' "$@"
  status=$?
  mv '${file}' '${target}/saved.tsbuildinfo'
  mkdir '${file}'
  printf 'local settings\\n' > '${file}/private.env'
  exit "$status"
fi`);
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
    expect(existsSync(path.join(file, 'private.env'))).toBeTruthy();
  });

  it.each([1, 2])('keeps a collapsed directory replaced with an empty directory after real Git listing %i', async listing => {
    const { dir, target } = await fixture();
    await ignoreGlobally('*');
    const local = path.join(target, 'local');
    const saved = path.join(target, 'saved-local');
    mkdirSync(local);
    writeFileSync(path.join(local, 'private.env'), 'local settings\n');
    await afterGitListing(listing, `mv '${local}' '${saved}'; mkdir '${local}'`);
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
    expect(existsSync(path.join(saved, 'private.env'))).toBeTruthy();
  });

  it.each([1, 2])('keeps the parent of a listed ignored directory replaced with a symbolic link after real Git listing %i', async listing => {
    const { dir, target } = await fixture();
    mkdirSync(path.join(target, 'pkg', 'state'), { recursive: true });
    writeFileSync(path.join(target, 'pkg', 'tracked.txt'), 'tracked\n');
    await git(target, 'add', 'pkg/tracked.txt');
    await git(target, 'commit', '--quiet', '-m', 'pkg');
    writeFileSync(path.join(target, 'pkg', 'state', 'private.env'), 'local settings\n');
    await ignoreGlobally('*');
    const decoy = tempDir('decoy-pkg');
    mkdirSync(path.join(decoy, 'state'));
    writeFileSync(path.join(decoy, 'tracked.txt'), 'tracked\n');
    const pkg = path.join(target, 'pkg');
    const saved = path.join(target, 'saved-pkg');
    await afterGitListing(listing, `mv '${pkg}' '${saved}'; ln -s '${decoy}' '${pkg}'`);
    const result = plan(dir, target);
    expect(result.candidates).toStrictEqual([]);
    expect(result.keep).toMatchObject([{ code: 'dirty_worktree', path: target }]);
    expect(existsSync(path.join(saved, 'state', 'private.env'))).toBeTruthy();
  });

  it('does not refuse a clean sparse worktree for the advice Git prints while it expands the index', async () => {
    const repo = await tmpRepo('sparse');
    mkdirSync(path.join(repo.dir, 'kept'));
    mkdirSync(path.join(repo.dir, 'outside'));
    writeFileSync(path.join(repo.dir, 'kept', 'file.txt'), 'kept\n');
    writeFileSync(path.join(repo.dir, 'outside', 'file.txt'), 'outside\n');
    await git(repo.dir, 'add', 'kept', 'outside');
    await git(repo.dir, 'commit', '--quiet', '-m', 'sparse');
    const target = managedPath('delivered', 'sparse');
    await git(repo.dir, 'worktree', 'add', '--quiet', '-b', 'delivered', target);
    await git(target, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'kept');
    await ignoreGlobally('node_modules/');
    mkdirSync(path.join(target, 'outside', 'node_modules', 'package'), { recursive: true });
    writeFileSync(path.join(target, 'outside', 'node_modules', 'package', 'index.js'), 'installed\n');
    const result = plan(repo.dir, target);
    // The guard passed: the branch has no merge proof, so the plan keeps it only for that.
    expect(result.keep).toStrictEqual([{ code: 'not_merged', path: target }]);
  });
});
