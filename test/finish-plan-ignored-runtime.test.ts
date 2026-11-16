import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { FinishPlan } from '../src/finish-types.ts';
import { git, gitShim, ignoreGlobally, managedPath, spawnCli, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';

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

  it('reads a symbolic link and nested repository without a second Git expansion', async () => {
    const { dir, target } = await fixture();
    await ignoreGlobally('local/');
    const nested = path.join(target, 'local', 'nested');
    mkdirSync(nested, { recursive: true });
    await git(nested, 'init', '--quiet');
    writeFileSync(path.join(nested, 'private.env'), 'local settings\n');
    writeFileSync(path.join(target, 'local', '00.tsbuildinfo'), 'generated\n');
    symlinkSync('missing', path.join(target, 'local', 'link'));
    await gitShim(`if [ "$3" = ls-files ] && [ "$8" = -- ]; then printf 'local/00.tsbuildinfo\\0'; exit 0; fi`);
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
});
