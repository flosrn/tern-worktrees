import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import type { FinishPlan } from '../src/finish-types.ts';
import { ghFixture, git, managedPath, tempDir, tmpRepo, useGithubOrigin, useSandbox, writeTernLs } from './helpers.ts';

describe('finish process attribution', () => {
  beforeEach(() => {
    useSandbox();
    writeTernLs({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])('protects only the target attributed to an uncertain process: located=%s', async located => {
    const { dir } = await tmpRepo('aoyama');
    const target = managedPath('delivered');
    await git(dir, 'worktree', 'add', '-b', 'delivered', target);
    const output = await git(target, 'rev-parse', 'HEAD');
    const head = output.trim();
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
    const bin = tempDir('finish-darwin');
    const date = new Date().toUTCString().replace(',', '').replace(' GMT', '');
    const uid = process.getuid?.() ?? 0;
    writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' '${process.pid} 1 ${process.pid} ${uid} ${date} bun finish plan' '990001 1 990001 ${uid} ${date} unrelated'\n`, {
      mode: 0o755,
    });
    const stranger = located ? `p990001\\0fcwd\\0n${target}\\0` : '';
    writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\nprintf 'p${process.pid}\\0fcwd\\0n${target}\\0${stranger}'\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('TERN_WT_PROC_ROOT', '');
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    // SAFETY: The public plan command returns the FinishPlan contract.
    const plan = (await run(['plan', '--repo', dir, '--current', target])) as FinishPlan;
    expect(plan.ready).toBe(!located);
    expect(plan.candidates.map(candidate => candidate.path)).toStrictEqual(located ? [] : [target]);
  });
});
