import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { executeFinish } from '../src/finish-execute.ts';
import { writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { ghFixture, git, gitShim, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

const response = (head: string, changes: { number?: number; url?: string; mergeCommit?: string } = {}): void => {
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
        mergeCommit: { oid: changes.mergeCommit ?? head },
        mergedAt: '2026-11-01T10:00:00Z',
        number: changes.number ?? 7,
        state: 'MERGED',
        url: changes.url ?? 'https://github.com/virtusize/aoyama/pull/7',
      },
    ]),
  );
};

const approval = async () => {
  const { dir } = await tmpRepo('aoyama');
  const target = managedPath('delivered');
  await git(dir, 'worktree', 'add', '-b', 'delivered', target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  await useGithubOrigin();
  response(head);
  writeTernLs({ aoyama: [dir, target] });
  fs.writeFileSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'config.json'), JSON.stringify({ teardown: 'worktree' }));
  const mainStat = fs.lstatSync(dir);
  const targetStat = fs.lstatSync(target);
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
  return { head, state, target };
};

const expectPreserved = async (state: StoredFinish, target: string): Promise<void> => {
  const log = await logGitCalls();
  const result = await executeFinish(state.id);
  expect({ errors: result.errors, keep: result.keep.map(item => item.path), removed: result.removed, status: result.status }).toStrictEqual({
    errors: [],
    keep: [target],
    removed: [],
    status: 'completed',
  });
  await expect(run(['status', state.id])).resolves.toStrictEqual(result);
  expect({
    closes: ternLog().filter(line => line.startsWith('close ')),
    removals: readLog(log).filter(line => line.includes('worktree remove')),
    targetExists: fs.existsSync(target),
  }).toStrictEqual({
    closes: [],
    removals: [],
    targetExists: true,
  });
};

// Each fixture changes only one identity field: no dirty file or second failed guard can preserve the target for it.
describe('finish revalidates every approved identity independently', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  test('reports path_identity_changed when only the approved filesystem identity changes', async () => {
    const { state, target } = await approval();
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const stat = original(file, options);
      if (file === target && stat !== undefined) {
        Object.defineProperty(stat, 'ino', { value: Number(stat.ino) + 1 });
      }
      return stat;
    });
    syncBuiltinESMExports();
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: [{ code: 'path_identity_changed', path: target }],
      removed: [],
      status: 'completed',
    });
    await expect(run(['status', state.id])).resolves.toStrictEqual(result);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      destructiveGit: readLog(log).filter(line => line.includes('worktree remove') || line.includes('branch -d') || line.includes('branch -D')),
      targetExists: fs.existsSync(target),
    }).toStrictEqual({ closes: [], destructiveGit: [], targetExists: true });
  });

  test('reports registration_changed when only the approved Git entry is missing', async () => {
    const { head, state, target } = await approval();
    const listing = path.join(tempDir('finish-missing-registration'), 'worktrees');
    fs.writeFileSync(listing, `worktree ${state.repo}\0HEAD ${head}\0branch refs/heads/main\0\0`);
    await gitShim(`if [ "$2" = '${state.repo}' ] && [ "$3 $4 $5 $6" = 'worktree list --porcelain -z' ]; then cat '${listing}'; exit 0; fi`);
    const log = await logGitCalls();
    const result = await executeFinish(state.id);
    expect({ errors: result.errors, keep: result.keep, removed: result.removed, status: result.status }).toStrictEqual({
      errors: [],
      keep: [{ code: 'registration_changed', path: target }],
      removed: [],
      status: 'completed',
    });
    await expect(run(['status', state.id])).resolves.toStrictEqual(result);
    expect({
      closes: ternLog().filter(line => line.startsWith('close ')),
      destructiveGit: readLog(log).filter(line => line.includes('worktree remove') || line.includes('branch -d') || line.includes('branch -D')),
      targetExists: fs.existsSync(target),
    }).toStrictEqual({ closes: [], destructiveGit: [], targetExists: true });
  });

  test.each(['repo', 'target'] as const)('preserves a clean target when only the %s device changes', async directory => {
    const { state, target } = await approval();
    const changed = directory === 'repo' ? state.repo : target;
    const original = fs.lstatSync;
    let inspected = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const stat = original(file, options);
      if (file === changed && stat !== undefined) {
        inspected = true;
        Object.defineProperty(stat, 'dev', { value: Number(stat.dev) + 1 });
      }
      return stat;
    });
    syncBuiltinESMExports();
    await expectPreserved(state, target);
    expect(inspected).toBeTruthy();
  });

  test.each(['repo', 'target'] as const)('preserves a clean target when only the %s inode changes', async directory => {
    const { state, target } = await approval();
    const changed = directory === 'repo' ? state.repo : target;
    const original = fs.lstatSync;
    let inspected = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const stat = original(file, options);
      if (file === changed && stat !== undefined) {
        inspected = true;
        Object.defineProperty(stat, 'ino', { value: Number(stat.ino) + 1 });
      }
      return stat;
    });
    syncBuiltinESMExports();
    await expectPreserved(state, target);
    expect(inspected).toBeTruthy();
  });

  test.each(['not a directory', 'symbolic link'] as const)('preserves a target reported as %s even with its saved dev and ino', async kind => {
    const { state, target } = await approval();
    expect.assertions(3);
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const stat = original(file, options);
      if (file === target && stat !== undefined) {
        Object.defineProperty(stat, kind === 'not a directory' ? 'isDirectory' : 'isSymbolicLink', { value: () => kind === 'symbolic link' });
      }
      return stat;
    });
    syncBuiltinESMExports();
    await expectPreserved(state, target);
  });

  test('preserves a target whose path resolves elsewhere even with the approved directory identity', async () => {
    const { state, target } = await approval();
    const inspected = path.join(tempDir('finish-canonical-inspection'), 'inspected');
    await gitShim(`if [ "$2" = '${target}' ] && [ "$3 $4 $5 $6" = 'rev-parse --path-format=absolute --git-common-dir --show-toplevel' ]; then : >'${inspected}'; fi`);
    const original = fs.realpathSync;
    let changed = false;
    vi.spyOn(fs, 'realpathSync').mockImplementation((file, options) => {
      if (file === target && !fs.existsSync(inspected)) {
        changed = true;
        return `${target}-resolved-elsewhere`;
      }
      return original(file, options);
    });
    syncBuiltinESMExports();
    await expectPreserved(state, target);
    expect(changed).toBeTruthy();
  });

  test('preserves a renamed branch with the exact approved HEAD and filesystem identity', async () => {
    const { head, state, target } = await approval();
    await git(target, 'branch', '-m', 'renamed-after-approval');
    const output = await git(target, 'rev-parse', 'HEAD');
    expect(output.trim()).toBe(head);
    await expectPreserved(state, target);
  });

  test.each(['number', 'url', 'mergeCommit'] as const)('preserves a target when only the approved pull request %s changes', async field => {
    const { head, state, target } = await approval();
    expect.assertions(3);
    if (field === 'number') {
      response(head, { number: 8 });
    } else if (field === 'url') {
      response(head, { url: 'https://github.com/virtusize/aoyama/pull/8' });
    } else {
      response(head, { mergeCommit: 'f'.repeat(40) });
    }
    await expectPreserved(state, target);
  });

  test.each(['inside', 'other main', 'missing entry', 'main entry'] as const)('preserves a target whose Git registration reports %s', async change => {
    const { head, state, target } = await approval();
    expect.assertions(3);
    const listing = path.join(tempDir('finish-registration'), 'worktrees');
    const record = (directory: string, branch: string): string => `worktree ${directory}\0HEAD ${head}\0branch refs/heads/${branch}\0\0`;
    fs.writeFileSync(listing, change === 'missing entry' ? record(state.repo, 'main') : `${record(target, 'delivered')}${record(state.repo, 'main')}`);
    if (change === 'inside' || change === 'other main') {
      const main = change === 'other main' ? tempDir('different-main') : state.repo;
      const top = change === 'inside' ? state.repo : target;
      const inspected = path.join(tempDir('finish-checkout'), 'inspected');
      await gitShim(
        `if [ "$2" = '${target}' ] && [ "$3 $4 $5 $6" = 'rev-parse --path-format=absolute --git-common-dir --show-toplevel' ] && [ ! -e '${inspected}' ]; then : >'${inspected}'; printf '%s\\n' '${main}/.git' '${top}'; exit 0; fi`,
      );
    } else {
      await gitShim(`if [ "$2" = '${state.repo}' ] && [ "$3 $4 $5 $6" = 'worktree list --porcelain -z' ]; then cat '${listing}'; exit 0; fi`);
    }
    await expectPreserved(state, target);
  });
});
