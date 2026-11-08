import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { git, managedPath, tempDir, tmpRepo, useSandbox } from './helpers.ts';

describe('worktree ports', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('creates and persists a deterministic even base port', async () => {
    const repo = await tmpRepo('aoyama');
    const result = await run(['--repo', repo.dir, '--branch', 'feature/x', '--new', '--no-tab']);
    expect(result).toMatchObject({ port: 5610, setup: { line: 'eval "$(tern-wt env . --shell)"', typed: false } });
    await expect(git(repo.dir, 'config', '--get', 'branch.feature/x.ternWtPort')).resolves.toBe('5610\n');
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ port: 5610, setup: null, status: 'reused' });
  });

  it('derives the same port for older linked worktrees in JSON and shell without writing config', async () => {
    const repo = await tmpRepo('aoyama');
    const linked = path.join(tempDir('linked'), 'old');
    await git(repo.dir, 'worktree', 'add', '-b', 'feature/x', linked);
    const json = await main(['env', linked]);
    expect(JSON.parse(json.stdout)).toStrictEqual({ env: { TERN_WT_PORT: '5610' } });
    await expect(main(['env', linked, '--shell'])).resolves.toMatchObject({ code: 0, stdout: "export TERN_WT_PORT='5610'\n" });
    await expect(git(repo.dir, 'config', '--get-regexp', '^branch\\..*\\.ternWtPort$')).rejects.toMatchObject({ code: 'git_failed' });
  });

  it('exports the linked worktree port to prepare and heavy commands', async () => {
    const repo = await tmpRepo('aoyama');
    const linked = path.join(tempDir('linked'), 'prepared');
    await git(repo.dir, 'worktree', 'add', '-b', 'feature/x', linked);
    mkdirSync(path.join(linked, '.tern'));
    writeFileSync(path.join(linked, '.tern/worktree.json'), JSON.stringify({ env: { WORD: 'ready' }, setup: ['printf "%s:%s" "$WORD" "$TERN_WT_PORT" > port'] }));
    await expect(main(['prepare', linked])).resolves.toMatchObject({ code: 0 });
    expect(readFileSync(path.join(linked, 'port'), 'utf-8')).toBe('ready:5610');
    const output = path.join(linked, 'heavy-port');
    await expect(main(['heavy', '--repo', linked, '--', 'sh', '-c', `printf '%s' "$TERN_WT_PORT" > '${output}'`])).resolves.toMatchObject({ code: 0 });
    expect(readFileSync(output, 'utf-8')).toBe('5610');
  });

  it('rejects repository declarations of the reserved port before running setup', async () => {
    const repo = await tmpRepo('aoyama');
    mkdirSync(path.join(repo.dir, '.tern'));
    writeFileSync(path.join(repo.dir, '.tern/worktree.json'), JSON.stringify({ env: { TERN_WT_PORT: '3000' }, setup: ['touch unexpected'] }));
    const result = await main(['prepare', repo.dir]);
    expect(JSON.parse(result.stdout)).toStrictEqual({
      error: { code: 'worktree_config_invalid', message: `${repo.dir}/.tern/worktree.json: env.TERN_WT_PORT: reserved for the worktree base port` },
    });
    expect(existsSync(path.join(repo.dir, 'unexpected'))).toBeFalsy();
  });

  it('lists base ports and leaves main and detached checkouts without one', async () => {
    const repo = await tmpRepo('aoyama');
    await run(['--repo', repo.dir, '--branch', 'feature/x', '--new', '--no-tab']);
    const detached = path.join(managedPath('feature-x'), '..', 'detached');
    await git(repo.dir, 'worktree', 'add', '--detach', detached);
    const listed = await main(['list', '--repo', repo.dir]);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      worktrees: [
        { branch: null, port: null },
        { branch: 'feature/x', port: 5610 },
      ],
    });
    await expect(main(['env', detached])).resolves.toMatchObject({ stdout: '{"env":{}}\n' });
    await expect(main(['env', repo.dir])).resolves.toMatchObject({ stdout: '{"env":{}}\n' });
    await expect(run(['--repo', repo.dir, '--branch', 'main', '--no-tab'])).resolves.toMatchObject({ owner: 'main', port: null });
  });

  it('allocates distinct deterministic ports to colliding older worktrees', async () => {
    const repo = await tmpRepo('aoyama');
    const base = tempDir('collision');
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    await git(repo.dir, 'worktree', 'add', '-b', 'feature/10', first);
    await git(repo.dir, 'worktree', 'add', '-b', 'feature/50', second);
    await expect(main(['env', first])).resolves.toMatchObject({ stdout: '{"env":{"TERN_WT_PORT":"5646"}}\n' });
    await expect(main(['env', second])).resolves.toMatchObject({ stdout: '{"env":{"TERN_WT_PORT":"5648"}}\n' });
    await expect(run(['--repo', repo.dir, '--branch', 'feature/50', '--relocate', '--no-tab'])).resolves.toMatchObject({ port: 5648, status: 'relocated' });
    await expect(git(repo.dir, 'config', '--get', 'branch.feature/50.ternWtPort')).resolves.toBe('5648\n');
  });

  it('reallocates a stale saved port when another live worktree has claimed it', async () => {
    const repo = await tmpRepo('aoyama');
    const original = await run(['--repo', repo.dir, '--branch', 'feature/10', '--new', '--no-tab']);
    await git(repo.dir, 'worktree', 'remove', managedPath('feature-10'));
    const stalePort = await git(repo.dir, 'config', '--get', 'branch.feature/10.ternWtPort');
    const replacement = await run(['--repo', repo.dir, '--branch', 'feature/50', '--new', '--no-tab']);
    expect([original, stalePort, replacement]).toMatchObject([{ port: 5646 }, '5646\n', { port: 5646 }]);

    await expect(run(['--repo', repo.dir, '--branch', 'feature/10', '--no-tab'])).resolves.toMatchObject({ port: 5648 });
    await expect(
      Promise.all([git(repo.dir, 'config', '--get', 'branch.feature/10.ternWtPort'), main(['env', managedPath('feature-10')]), main(['env', managedPath('feature-50')])]),
    ).resolves.toMatchObject(['5648\n', { stdout: '{"env":{"TERN_WT_PORT":"5648"}}\n' }, { stdout: '{"env":{"TERN_WT_PORT":"5646"}}\n' }]);
    const listed = await main(['list', '--repo', repo.dir]);
    // SAFETY: list returns JSON worktrees with branch and port fields.
    const listing = JSON.parse(listed.stdout) as { worktrees: { branch: string | null; port: number | null }[] };
    expect(
      Object.fromEntries(listing.worktrees.filter(({ branch }) => branch === 'feature/10' || branch === 'feature/50').map(({ branch, port }) => [branch, port])),
    ).toStrictEqual({
      'feature/10': 5648,
      'feature/50': 5646,
    });
  });

  it('reserves an older unsaved worktree port before creating an alphabetically earlier branch', async () => {
    const repo = await tmpRepo('aoyama');
    const linked = managedPath('feature-50');
    await git(repo.dir, 'worktree', 'add', '-b', 'feature/50', linked);
    await expect(git(repo.dir, 'config', '--get', 'branch.feature/50.ternWtPort')).rejects.toMatchObject({ code: 'git_failed' });
    await expect(main(['env', linked])).resolves.toMatchObject({ stdout: '{"env":{"TERN_WT_PORT":"5646"}}\n' });

    await expect(run(['--repo', repo.dir, '--branch', 'feature/10', '--new', '--no-tab'])).resolves.toMatchObject({ port: 5648 });
    await expect(
      Promise.all([git(repo.dir, 'config', '--get', 'branch.feature/50.ternWtPort'), main(['env', linked]), main(['env', managedPath('feature-10')])]),
    ).resolves.toMatchObject(['5646\n', { stdout: '{"env":{"TERN_WT_PORT":"5646"}}\n' }, { stdout: '{"env":{"TERN_WT_PORT":"5648"}}\n' }]);
    const listed = await main(['list', '--repo', repo.dir]);
    // SAFETY: list returns JSON worktrees with branch and port fields.
    const listing = JSON.parse(listed.stdout) as { worktrees: { branch: string | null; port: number | null }[] };
    expect(
      Object.fromEntries(listing.worktrees.filter(({ branch }) => branch === 'feature/10' || branch === 'feature/50').map(({ branch, port }) => [branch, port])),
    ).toStrictEqual({
      'feature/10': 5648,
      'feature/50': 5646,
    });
  });

  it('wraps past 5998, skips saved ports and keeps the assigned port after relocation', async () => {
    const repo = await tmpRepo('aoyama');
    await git(repo.dir, 'worktree', 'add', '-b', 'occupied', path.join(tempDir('occupied'), 'wt'));
    await git(repo.dir, 'config', 'branch.occupied.ternWtPort', '5998');
    await git(repo.dir, 'worktree', 'add', '-b', 'next', path.join(tempDir('occupied'), 'next'));
    await git(repo.dir, 'config', 'branch.next.ternWtPort', '4000');
    const result = await run(['--repo', repo.dir, '--branch', 'feature/12', '--new', '--no-tab']);
    expect(result).toMatchObject({ port: 4002 });
    await git(repo.dir, 'config', 'branch.feature/12.ternWtPort', '4998');
    await expect(run(['--repo', repo.dir, '--branch', 'feature/12', '--no-tab'])).resolves.toMatchObject({ port: 4998 });
    const twin = await tmpRepo('aoyama');
    await expect(run(['--repo', twin.dir, '--branch', 'feature/x', '--new', '--no-tab'])).resolves.toMatchObject({ port: 5610 });
  });

  it('ignores prunable, main and detached worktrees when allocating a port', async () => {
    const repo = await tmpRepo('aoyama');
    const gone = path.join(tempDir('gone'), 'wt');
    await git(repo.dir, 'worktree', 'add', '-b', 'gone', gone);
    await git(repo.dir, 'config', 'branch.gone.ternWtPort', '5610');
    await git(repo.dir, 'config', 'branch.main.ternWtPort', '5610');
    await git(repo.dir, 'worktree', 'add', '--detach', path.join(tempDir('detached'), 'wt'));
    rmSync(gone, { recursive: true });
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--new', '--no-tab'])).resolves.toMatchObject({ port: 5610 });
  });
});
