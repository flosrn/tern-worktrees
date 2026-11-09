import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { finishDirectory, readFinish, writeFinish } from '../src/finish-store.ts';
import type { FinishPlan } from '../src/finish-types.ts';
import { ghFixture, git, logGitCalls, managedPath, readLog, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const planned = async () => {
  const { dir } = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(dir, 'worktree', 'add', '-b', 'delivered', target);
  const headOutput = await git(target, 'rev-parse', 'HEAD');
  const head = headOutput.trim();
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
  // SAFETY: The public plan action returns the FinishPlan contract.
  const plan = (await run(['plan', '--repo', dir, '--current', dir, '--owned', target])) as FinishPlan;
  return { dir, plan, target };
};

const rejectedCommands: [string, (id: string, repo: string) => string[]][] = [
  ['plan positional', (_id, repo) => ['plan', 'extra', '--repo', repo]],
  ['plan repository absent', () => ['plan']],
  ['arm id absent', () => ['arm', '--choice', 'none']],
  ['arm extra id', (id: string) => ['arm', id, 'extra', '--choice', 'none']],
  ['arm unknown choice', (id: string) => ['arm', id, '--choice', 'other']],
  ['notices positional', (id: string) => ['notices', id]],
  ['action absent', () => []],
  ['status id absent', () => ['status']],
  ['status extra id', (id: string) => ['status', id, 'extra']],
  ['unknown action', (id: string) => ['unknown', id]],
];

describe('finish command boundary', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  test.each(rejectedCommands)('rejects %s with a public error before any durable or teardown effect', async (_label, args) => {
    const { dir, plan, target } = await planned();
    const stateFile = path.join(finishDirectory(plan.id), 'state.json');
    const before = readFileSync(stateFile, 'utf-8');
    const plans = readdirSync(finishDirectory());
    const log = await logGitCalls();
    await expect(run(args(plan.id, dir))).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      plans: readdirSync(finishDirectory()),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      state: readFileSync(stateFile, 'utf-8'),
      targetExists: existsSync(target),
      workerLogged: existsSync(path.join(finishDirectory(plan.id), 'worker.log')),
      workerStarted: existsSync(path.join(finishDirectory(plan.id), 'worker.started')),
    }).toStrictEqual({ closes: [], plans, removals: [], state: before, targetExists: true, workerLogged: false, workerStarted: false });
  });

  test.each([
    ['--pid', ' 7'],
    ['--pid', '7 '],
    ['--block', ' 7'],
    ['--block', '7 '],
  ])('rejects surrounding whitespace in %s=%s before creating a plan', async (flag, value) => {
    const { dir } = await tmpRepo('aoyama');
    const log = await logGitCalls();
    await expect(run(['plan', '--repo', dir, flag, value])).rejects.toMatchObject({ code: 'bad_args', name: 'CliError' });
    expect(readdirSync(finishDirectory())).toStrictEqual([]);
    expect(readLog(log)).toStrictEqual([]);
    expect(ternLog()).toStrictEqual([]);
  });

  test('returns the complete armed status without running an executable approved selection', async () => {
    const { plan, target } = await planned();
    expect({ candidates: plan.candidates.map(candidate => candidate.path), ready: plan.ready }).toStrictEqual({ candidates: [target], ready: true });
    writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown: 'worktree' }));
    const state = readFinish(plan.id);
    state.status = 'armed';
    state.selected = [target];
    writeFinish(state);
    const stateFile = path.join(finishDirectory(plan.id), 'state.json');
    const before = readFileSync(stateFile, 'utf-8');
    const log = await logGitCalls();
    await expect(run(['status', plan.id])).resolves.toStrictEqual({ ...plan, errors: [], removed: [], selected: [target], status: 'armed' });
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      locked: existsSync(path.join(finishDirectory(plan.id), 'executor.lock')),
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      state: readFileSync(stateFile, 'utf-8'),
      targetExists: existsSync(target),
      workerStarted: existsSync(path.join(finishDirectory(plan.id), 'worker.started')),
    }).toStrictEqual({ closes: [], locked: false, removals: [], state: before, targetExists: true, workerStarted: false });
  });

  test('keeps an omitted caller block null and never invents an active-block exemption', async () => {
    const { plan, target } = await planned();
    expect(readFinish(plan.id).caller.block).toBeNull();
    writeTernLs({ aoyama: [target] });
    const foreground = { argv: ['omp'], cwd: target, name: 'omp', pid: 90_001 };
    writeFileSync(path.join(process.env.FAKE_TERN_DIR ?? '', 'process-1.json'), JSON.stringify({ child: null, foreground, group: foreground.pid, pane: 1 }));
    // SAFETY: The public plan action returns the FinishPlan contract.
    const blocked = (await run(['plan', '--repo', plan.repo, '--current', target])) as FinishPlan;
    expect({
      block: readFinish(blocked.id).caller.block,
      candidates: blocked.candidates,
      closes: ternLog().filter(line => line.startsWith('close ')),
      keep: blocked.keep.filter(item => item.path === target).map(item => ({ code: item.code, path: item.path })),
      targetExists: existsSync(target),
    }).toStrictEqual({ block: null, candidates: [], closes: [], keep: [{ code: 'active_process', path: target }], targetExists: true });
    await expect(run(['status', blocked.id])).resolves.toMatchObject({ id: blocked.id, selected: [], status: 'planned' });
  });
});
