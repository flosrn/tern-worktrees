import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run as create } from '../src/commands/create.ts';
import { run } from '../src/commands/enter.ts';
import { must } from '../src/proc.ts';
import { managedPath, tempDir, ternLog, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

const OMP = path.join(import.meta.dirname, 'fixtures', 'bin', 'omp');
let repo: RepoFixture;
let worktree: string;
let session: string;

const splitLine = (block: number, env: string[] = []): string =>
  `split ${block} right --json --cwd ${worktree} -- env ${[...env, OMP].join(' ')} --fork ${session} -- This session is a fork of the session that ran in ${repo.dir}. That session moved the work into the worktree ${worktree} and ended. Continue the task here: run commands and edit files in this worktree, not in the main checkout.`;

describe('enter command', () => {
  beforeEach(async () => {
    useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    await create(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
    worktree = realpathSync(managedPath('feature-x'));
    session = path.join(tempDir('sessions'), 'session.jsonl');
    writeFileSync(session, '{}\n');
    vi.stubEnv('TERN_WT_OMP', OMP);
  });

  it('forks the session beside the tab that shows the worktree', async () => {
    writeTernLs({ work: [repo.dir, path.join(worktree, 'src')] });
    await expect(run([worktree, '--fork', session])).resolves.toStrictEqual({ agent: 43, path: worktree, repo: repo.dir, tab: { block: 2, opened: false, session: 'work' } });
    expect(ternLog()).toStrictEqual(['ls --json', 'focus 2 --json', splitLine(2), 'focus 43 --json']);
  });

  it('opens the tab of the worktree first and passes the omp profile to the fork', async () => {
    writeTernLs({ work: [repo.dir] });
    vi.stubEnv('OMP_PROFILE', 'work');
    vi.stubEnv('PI_CODING_AGENT_DIR', '/agents/work');
    await expect(run([worktree, '--fork', session])).resolves.toMatchObject({ agent: 43, tab: { block: 42, opened: true, session: 'work' } });
    expect(ternLog()).toStrictEqual([
      'ls --json',
      `new tab work --cwd ${worktree} --json`,
      'rename 42 feature/x --json',
      splitLine(42, ['OMP_PROFILE=work', 'PI_CODING_AGENT_DIR=/agents/work']),
      'focus 43 --json',
    ]);
  });

  it('names the tab of a detached worktree after its folder', async () => {
    await must(['git', '-C', worktree, 'checkout', '--quiet', '--detach'], 'git_failed');
    writeTernLs({});
    await run([worktree, '--fork', session]);
    expect(ternLog()[2]).toBe('rename 42 feature-x --json');
  });

  it.each([[[]], [['dir']]])('refuses the arguments %j', async args => {
    await expect(run(args)).rejects.toMatchObject({ code: 'bad_args', message: 'enter requires one worktree path and --fork <session file>' });
  });

  it('refuses the main checkout and a folder inside a worktree', async () => {
    await expect(run([repo.dir, '--fork', session])).rejects.toMatchObject({ code: 'bad_args', message: `${repo.dir} is not the top folder of a linked worktree` });
    const inside = path.join(worktree, 'src');
    mkdirSync(inside);
    await expect(run([inside, '--fork', session])).rejects.toMatchObject({ code: 'bad_args', message: `${inside} is not the top folder of a linked worktree` });
  });

  it('refuses a folder that is not in a repository', async () => {
    await expect(run([tempDir('plain'), '--fork', session])).rejects.toMatchObject({ code: 'not_a_repo' });
  });

  it('refuses a missing session file before Tern runs', async () => {
    const missing = path.join(worktree, 'none.jsonl');
    await expect(run([worktree, '--fork', missing])).rejects.toMatchObject({ code: 'bad_args', message: `${missing} is not a session file` });
    expect(ternLog()).toStrictEqual([]);
  });

  it('needs omp', async () => {
    vi.stubEnv('TERN_WT_OMP', path.join(tempDir('no-omp'), 'omp'));
    await expect(run([worktree, '--fork', session])).rejects.toMatchObject({ code: 'omp_failed', message: 'omp is not on PATH' });
    expect(ternLog()).toStrictEqual([]);
  });

  it('reports a failed split', async () => {
    writeTernLs({});
    vi.stubEnv('FAKE_TERN_FAIL', 'split');
    await expect(run([worktree, '--fork', session])).rejects.toMatchObject({ code: 'tern_failed', message: 'fake tern: split failed' });
  });
});
