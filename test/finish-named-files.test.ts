import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { readFinish } from '../src/finish-store.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { arm, delivered, executed, expectPreserved, planned } from './finish-activity-fixture.ts';
import { afterGitListing, gitShim, ignoreGlobally, useSandbox, writeTernLs } from './helpers.ts';

const numbered = (count: number): string[] => Array.from({ length: count }, (_, index) => `${String(index).padStart(2, '0')}.env`);

describe('files named in finish causes', () => {
  beforeEach(async () => {
    useSandbox();
    writeTernLs({});
    await ignoreGlobally('*.env');
  });

  it.each([
    { changes: ['a.txt', 'b.txt'], ignored: ['one.env', 'two.env'], shown: ['?? a.txt', '?? b.txt', '!! one.env', '!! two.env'] },
    { changes: ['a.txt'], ignored: numbered(12), shown: [...numbered(10).map(file => `!! ${file}`), 'and 3 more'] },
  ])('plan names the files that keep a worktree with $changes.length changes and $ignored.length hard-to-rebuild files', async ({ changes, ignored, shown }) => {
    const { dir, target } = await delivered();
    for (const file of [...changes, ...ignored]) {
      writeFileSync(path.join(target, file), 'local work\n');
    }
    const plan = await planned('--repo', dir, '--current', target);
    const kept = [{ code: 'dirty_worktree', detail: `${target} has work that removing it would lose: ${shown.join(', ')}`, path: target }];
    expect(plan.keep.filter(item => item.path === target)).toStrictEqual(kept);
    expect(readFinish(plan.id).keep.filter(item => item.path === target)).toStrictEqual(kept);
  });

  it('plan keeps a worktree with the code of an invalid rebuildable declaration in the main checkout', async () => {
    const { dir, target } = await delivered();
    const file = path.join(dir, '.tern', 'worktree.json');
    mkdirSync(path.dirname(file));
    writeFileSync(file, JSON.stringify({ rebuildable: '..' }));
    const plan = await planned('--repo', dir, '--current', target);
    expect(plan.keep.filter(item => item.path === target)).toStrictEqual([
      { code: 'worktree_config_invalid', detail: `${file}: rebuildable: expected an array of strings`, path: target },
    ]);
  });

  it('plan keeps the message alone for an inspection refusal that names no files', async () => {
    const { dir, target } = await delivered();
    await gitShim(`if [ "$3" = ls-files ]; then printf 'local-\\377/\\0'; exit 0; fi`);
    let refusal = '';
    try {
      await guardWorkToLose(target, { removing: dir }, dir);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toMatch(/UTF-8/u);
    const plan = await planned('--repo', dir, '--current', target);
    expect(plan.keep.filter(item => item.path === target)).toStrictEqual([{ code: 'dirty_worktree', detail: refusal, path: target }]);
  });

  it('execute names the hard-to-rebuild file a target gained after approval', async () => {
    const { dir, log, target } = await delivered();
    const plan = await planned('--repo', dir, '--owned', target);
    await arm(plan, [target]);
    writeFileSync(path.join(target, 'later.env'), 'SECRET=1\n');
    const result = await executed(plan.id);
    expect({ errors: result.errors, keep: result.keep.filter(item => item.path === target), removed: result.removed }).toStrictEqual({
      errors: [],
      keep: [{ code: 'dirty_worktree', detail: `${target} has work that removing it would lose: !! later.env`, path: target }],
      removed: [],
    });
    expectPreserved(target, log);
  });

  it('execute keeps the message of a plain error alone', async () => {
    const { dir, target } = await delivered();
    const plan = await planned('--repo', dir, '--owned', target);
    await arm(plan, [target]);
    rmSync(target, { force: true, recursive: true });
    const result = await executed(plan.id);
    expect(result.keep.filter(item => item.path === target)).toStrictEqual([
      { code: 'inspection_failed', detail: `ENOENT: no such file or directory, lstat '${target}'`, path: target },
    ]);
  });

  it('execute names the hard-to-rebuild file that stops the removal after revalidation', async () => {
    const { dir, log, target } = await delivered();
    const plan = await planned('--repo', dir, '--owned', target);
    await arm(plan, [target]);
    // The revalidation lists the ignored files twice. The file is written after that, before the removal lists them.
    await afterGitListing(2, `echo SECRET=1 > '${path.join(target, 'late.env')}'`);
    const result = await executed(plan.id);
    expect({ errors: result.errors, keep: result.keep.filter(item => item.path === target), removed: result.removed }).toStrictEqual({
      errors: [{ code: 'dirty_worktree', detail: `${target} has work that removing it would lose: !! late.env`, path: target }],
      keep: [],
      removed: [],
    });
    expectPreserved(target, log);
  });
});
