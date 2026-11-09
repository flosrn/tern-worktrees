import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { executeFinish } from '../src/finish-execute.ts';
import { writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { git, gitShim, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const approval = async () => {
  const { dir } = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  const mainStat = lstatSync(dir);
  const targetStat = lstatSync(target);
  const state: StoredFinish = {
    caller: { block: null, identity: null, pid: null, session: null },
    candidates: [
      {
        branch: 'delivered',
        head,
        path: target,
        pr: { headRefOid: head, mergeCommit: head, mergedAt: '2026-11-01T10:00:00Z', number: 7, url: 'https://github.com/virtusize/aoyama/pull/7' },
      },
    ],
    current: null,
    errors: [],
    excluded: [],
    id: randomBytes(24).toString('hex'),
    identities: { [dir]: { dev: mainStat.dev, ino: mainStat.ino }, [target]: { dev: targetStat.dev, ino: targetStat.ino } },
    inFlight: null,
    keep: [],
    notified: false,
    owned: [target],
    ready: true,
    removed: [],
    repo: dir,
    selected: [target],
    status: 'armed',
    version: 2,
    warnings: [],
  };
  writeFinish(state);
  return { state, target };
};

describe('finish execution approved scope', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  test('preserves a target whose managed owner changed after approval', async () => {
    const { state, target } = await approval();
    await useGithubOrigin();
    vi.stubEnv('TERN_WT_HOME', tempDir('finish-changed-owner'));
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      keep: result.keep,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      status: result.status,
      targetExists: existsSync(target),
    }).toStrictEqual({
      closes: [],
      errors: [],
      keep: [{ code: 'registration_changed', path: target }],
      removals: [],
      removed: [],
      status: 'completed',
      targetExists: true,
    });
  });

  test('preserves a target when its origin no longer permits a GitHub merge proof', async () => {
    const { state, target } = await approval();
    await gitShim('if [ "$3 $4 $5" = "remote get-url origin" ]; then echo "https://gitlab.com/virtusize/aoyama.git"; exit 0; fi');
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      keep: result.keep,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      status: result.status,
      targetExists: existsSync(target),
    }).toStrictEqual({
      closes: [],
      errors: [],
      keep: [{ code: 'not_merged', path: target }],
      removals: [],
      removed: [],
      status: 'completed',
      targetExists: true,
    });
  });

  test('does not execute a saved candidate absent from the approved selection', async () => {
    const { state, target } = await approval();
    state.selected = [];
    writeFinish(state);
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      errors: result.errors,
      keep: result.keep,
      removals: readLog(log).filter(line => line.includes('worktree remove')),
      removed: result.removed,
      selected: result.selected,
      status: result.status,
      targetExists: existsSync(target),
    }).toStrictEqual({ closes: [], errors: [], keep: [], removals: [], removed: [], selected: [], status: 'completed', targetExists: true });
  });
});
