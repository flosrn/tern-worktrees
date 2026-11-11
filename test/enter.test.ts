import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run as create } from '../src/commands/create.ts';
import { run } from '../src/commands/enter.ts';
import { enterRequestFile, requestEnter } from '../src/enter.ts';
import { must } from '../src/proc.ts';
import { managedPath, tempDir, ternLog, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

const OMP = path.join(import.meta.dirname, 'fixtures', 'bin', 'omp');
const SESSION = '01a1c956-a9e5-72d7-b9a1-e0e3732c4db9';
let repo: RepoFixture;
let worktree: string;
let session: string;

const splitLine = (block: number, env: string[] = []): string =>
  `split ${block} right --json --cwd ${worktree} -- env ${[...env, OMP].join(' ')} --fork ${session} -- This session is a fork of the session that ran in ${repo.dir}. That session moved the work into the worktree ${worktree} and ended. Continue the task here: run commands and edit files in this worktree, not in the main checkout.`;

const recorded = (): string => readFileSync(enterRequestFile(SESSION), 'utf-8');

const setup = async (): Promise<void> => {
  useSandbox();
  repo = await tmpRepo('aoyama');
  await repo.pushBranch('feature/x');
  await create(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
  worktree = realpathSync(managedPath('feature-x'));
  session = path.join(tempDir('sessions'), 'session.jsonl');
  writeFileSync(session, '{}\n');
  vi.stubEnv('TERN_WT_OMP', OMP);
  vi.stubEnv('PI_SESSION_ID', SESSION);
  vi.stubEnv('TERN_PANE', '7');
};

describe('enter <worktree>', () => {
  beforeEach(setup);

  it('records the worktree for the calling omp session and touches no tab', async () => {
    await expect(run([worktree])).resolves.toStrictEqual({ path: worktree, repo: repo.dir, session: SESSION });
    expect(recorded()).toBe(`${JSON.stringify({ path: worktree })}\n`);
    expect(ternLog()).toStrictEqual([]);
  });

  it.each([[[]], [['a', 'b']], [['a', '--fork', 'f']]])('refuses the arguments %j', async args => {
    await expect(run(args)).rejects.toMatchObject({ code: 'bad_args', message: 'enter requires one worktree path' });
  });

  it('refuses the main checkout and a folder in a worktree', async () => {
    await expect(run([repo.dir])).rejects.toMatchObject({ code: 'bad_args', message: `${repo.dir} is not the top folder of a linked worktree` });
    const inside = path.join(worktree, 'src');
    mkdirSync(inside);
    await expect(run([inside])).rejects.toMatchObject({ code: 'bad_args', message: `${inside} is not the top folder of a linked worktree` });
    expect(existsSync(enterRequestFile(SESSION))).toBeFalsy();
  });

  it.each([
    ['PI_SESSION_ID', '--enter and enter need an omp session: PI_SESSION_ID is not set'],
    ['TERN_PANE', '--enter and enter need a Tern pane: TERN_PANE is not set'],
  ])('needs %s', async (name, message) => {
    vi.stubEnv(name, '');
    await expect(run([worktree])).rejects.toMatchObject({ code: 'bad_args', message });
  });

  it('refuses a session id that is not a file name', async () => {
    vi.stubEnv('PI_SESSION_ID', '../x');
    await expect(run([worktree])).rejects.toMatchObject({ code: 'bad_args', message: 'invalid omp session id ../x' });
  });
});

describe('enter --session <id> --fork <session file>', () => {
  beforeEach(setup);

  it('forks the session beside the tab that shows the worktree and consumes the request', async () => {
    requestEnter(SESSION, worktree);
    writeTernLs({ work: [repo.dir, path.join(worktree, 'src')] });
    await expect(run(['--session', SESSION, '--fork', session])).resolves.toStrictEqual({
      agent: 43,
      path: worktree,
      repo: repo.dir,
      tab: { block: 2, opened: false, session: 'work' },
    });
    expect(ternLog()).toStrictEqual(['ls --json', 'focus 2 --json', splitLine(2), 'focus 43 --json']);
    expect(existsSync(enterRequestFile(SESSION))).toBeFalsy();
  });

  it('opens the tab of the worktree first and passes the omp profile to the fork', async () => {
    requestEnter(SESSION, worktree);
    writeTernLs({ work: [repo.dir] });
    vi.stubEnv('OMP_PROFILE', 'work');
    vi.stubEnv('PI_CODING_AGENT_DIR', '/agents/work');
    await expect(run(['--session', SESSION, '--fork', session])).resolves.toMatchObject({ agent: 43, tab: { block: 42, opened: true, session: 'work' } });
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
    requestEnter(SESSION, worktree);
    writeTernLs({});
    await run(['--session', SESSION, '--fork', session]);
    expect(ternLog()[2]).toBe('rename 42 feature-x --json');
  });

  it('fails without a request', async () => {
    await expect(run(['--session', SESSION, '--fork', session])).rejects.toMatchObject({ code: 'bad_args', message: `omp session ${SESSION} has no worktree to enter` });
  });

  it('refuses a request that is not valid JSON and consumes it', async () => {
    requestEnter(SESSION, worktree);
    writeFileSync(enterRequestFile(SESSION), '{');
    await expect(run(['--session', SESSION, '--fork', session])).rejects.toMatchObject({ code: 'bad_args', message: `invalid enter request in ${enterRequestFile(SESSION)}` });
    expect(existsSync(enterRequestFile(SESSION))).toBeFalsy();
  });

  it.each(['[]', '{"path":1}', '{}'])('refuses the request %s', async text => {
    requestEnter(SESSION, worktree);
    writeFileSync(enterRequestFile(SESSION), text);
    await expect(run(['--session', SESSION, '--fork', session])).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('refuses a worktree that went away since the request', async () => {
    requestEnter(SESSION, repo.dir);
    await expect(run(['--session', SESSION, '--fork', session])).rejects.toMatchObject({ code: 'bad_args', message: `${repo.dir} is not the top folder of a linked worktree` });
  });

  it.each([[[]], [['--fork', '']], [['--fork', 'missing.jsonl']]])('consumes the request and refuses the session file %j before Tern runs', async fork => {
    requestEnter(SESSION, worktree);
    await expect(run(['--session', SESSION, ...fork])).rejects.toMatchObject({ code: 'bad_args', message: `${fork.at(1) ?? ''} is not a session file` });
    expect(ternLog()).toStrictEqual([]);
    expect(existsSync(enterRequestFile(SESSION))).toBeFalsy();
  });

  it('needs omp', async () => {
    requestEnter(SESSION, worktree);
    vi.stubEnv('TERN_WT_OMP', path.join(tempDir('no-omp'), 'omp'));
    await expect(run(['--session', SESSION, '--fork', session])).rejects.toMatchObject({ code: 'omp_failed', message: 'omp is not on PATH' });
    expect(ternLog()).toStrictEqual([]);
  });

  it('reports a failed split', async () => {
    requestEnter(SESSION, worktree);
    writeTernLs({});
    vi.stubEnv('FAKE_TERN_FAIL', 'split');
    await expect(run(['--session', SESSION, '--fork', session])).rejects.toMatchObject({ code: 'tern_failed', message: 'fake tern: split failed' });
  });
});

describe('create --enter', () => {
  beforeEach(setup);

  it('records the worktree that it creates or reuses', async () => {
    writeTernLs({ work: [repo.dir, worktree] });
    await expect(create(['--repo', repo.dir, '--branch', 'feature/x', '--enter'])).resolves.toMatchObject({ enter: true, path: managedPath('feature-x'), status: 'reused' });
    expect(recorded()).toBe(`${JSON.stringify({ path: worktree })}\n`);
  });

  it('refuses to run outside an omp session before it makes the worktree', async () => {
    vi.stubEnv('PI_SESSION_ID', '');
    await expect(create(['--repo', repo.dir, '--branch', 'feature/y', '--new', '--enter'])).rejects.toMatchObject({ code: 'bad_args' });
    expect(existsSync(managedPath('feature-y'))).toBeFalsy();
  });

  it('skips the main checkout with a warning', async () => {
    const result = await create(['--repo', repo.dir, '--branch', 'main', '--no-tab', '--enter']);
    expect(result).toMatchObject({ owner: 'main' });
    expect(result.warnings).toContain('enter skipped: the branch is checked out in the main checkout');
    expect(result).not.toHaveProperty('enter');
    expect(existsSync(enterRequestFile(SESSION))).toBeFalsy();
  });
});
