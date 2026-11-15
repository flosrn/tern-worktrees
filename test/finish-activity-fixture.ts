import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vite-plus/test';
import type { ProcessIdentity } from '../src/clean-processes.ts';
import { run } from '../src/commands/finish.ts';
import type { FinishPlan, FinishState } from '../src/finish-types.ts';
import type { TernProcess } from '../src/tern.ts';
import { ghFixture, git, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin } from './helpers.ts';

// SAFETY: these commands return the public finish contracts.
/** Runs `finish plan` with the given arguments. */
export const planned = async (...args: string[]): Promise<FinishPlan> => (await run(['plan', ...args])) as FinishPlan;
// SAFETY: the execute command returns the public FinishState contract.
/** Runs `finish execute` for a saved plan. */
export const executed = async (id: string): Promise<FinishState> => (await run(['execute', id])) as FinishState;

/** Adds a worktree whose branch head is the merge commit of a merged pull request. */
export const addDelivered = async (dir: string, branch: string, number = 7): Promise<string> => {
  const target = managedPath(branch);
  await git(dir, 'worktree', 'add', '-b', branch, target);
  const output = await git(target, 'rev-parse', 'HEAD');
  const head = output.trim();
  ghFixture(
    [
      'pr',
      'list',
      '--repo',
      'virtusize/aoyama',
      '--head',
      branch,
      '--state',
      'merged',
      '--limit',
      '100',
      '--json',
      'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
    ],
    JSON.stringify([
      {
        headRefName: branch,
        headRefOid: head,
        isCrossRepository: false,
        mergeCommit: { oid: head },
        mergedAt: '2026-11-01T10:00:00Z',
        number,
        state: 'MERGED',
        url: `https://github.com/virtusize/aoyama/pull/${number}`,
      },
    ]),
  );
  ghFixture(['api', `repos/virtusize/aoyama/git/trees/${head}?recursive=1`], JSON.stringify({ sha: head, tree: [], truncated: false }));
  return target;
};

/** Makes a repository with one delivered worktree and logs its Git calls. */
export const delivered = async () => {
  const { dir } = await tmpRepo('aoyama');
  await useGithubOrigin();
  const target = await addDelivered(dir, 'delivered');
  const log = await logGitCalls();
  return { dir, log, target };
};

/** Builds a process identity whose parent is PID 1. */
export const identity = (pid: number, cwd: string, command = 'omp'): ProcessIdentity => ({ command, cwd, group: pid, parent: 1, pid, start: '100' });
/** Gives the fake `/proc` directory of a PID. */
export const processDirectory = (pid: number): string => path.join(process.env.TERN_WT_PROC_ROOT ?? '', String(pid));
/** Formats a fake `/proc/<pid>/stat` line. */
export const statLine = (entry: ProcessIdentity): string =>
  `${entry.pid} (worker) ${['S', String(entry.parent), String(entry.group), ...Array.from({ length: 16 }, () => '0'), entry.start].join(' ')}`;

/** Writes the fake `/proc` entry of a process. */
export const writeProcess = (entry: ProcessIdentity): void => {
  const directory = processDirectory(entry.pid);
  mkdirSync(directory, { recursive: true });
  symlinkSync(entry.cwd, path.join(directory, 'cwd'));
  writeFileSync(path.join(directory, 'stat'), statLine(entry));
  writeFileSync(path.join(directory, 'cmdline'), entry.command);
};

/** Makes the fake `ps` list these processes, after it runs the `before` shell text. */
export const sampleProcesses = (entries: ProcessIdentity[], before = ''): void => {
  const bin = tempDir('finish-activity-ps');
  const rows = entries.map(entry => `'${entry.pid} ${entry.parent} ${entry.group} ${entry.command}'`).join(' ');
  writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\n${before}\nprintf '%s\\n' ${rows}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
};

/** Converts a process identity into a Tern terminal process. */
export const terminalProcess = (entry: ProcessIdentity, name = 'omp'): TernProcess => ({ argv: entry.command.split(' '), cwd: entry.cwd, name, pid: entry.pid });
/** Writes the fake Tern process sample of a block. */
export const writeTerminal = (block: number, child: TernProcess | null, foreground: TernProcess | null): void => {
  writeFileSync(
    path.join(process.env.FAKE_TERN_DIR ?? '', `process-${block}.json`),
    JSON.stringify({ child, foreground, group: foreground?.pid ?? child?.pid ?? null, pane: block }),
  );
};

/** Arms a plan for the selected worktrees with a fake worker. */
export const arm = async (plan: FinishPlan, selected: string[]): Promise<void> => {
  const bin = tempDir('finish-activity-worker');
  writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$$" > worker.started\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  await expect(run(['arm', plan.id, '--choice', 'merged', ...selected.flatMap(target => ['--selected', target])])).resolves.toStrictEqual({
    id: plan.id,
    selected,
    status: 'armed',
  });
};

/** Asserts that the target and its branch stay and that no tab closes. */
export const expectPreserved = (target: string, log: string): void => {
  expect(existsSync(target)).toBeTruthy();
  expect(readLog(log).filter(line => /worktree remove|branch -[dD]|update-ref/u.test(line))).toStrictEqual([]);
  expect(ternLog().filter(line => line.startsWith('close '))).toStrictEqual([]);
};
