import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/remove.ts';
import { cliJson, git, logGitCalls, managedPath, readLog, ternLog, tmpRepo, useSandbox, writeTernListing, writeTernLs, writeTernLsRaw } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

let repo: RepoFixture;
let sandbox: Sandbox;

const shell = { argv: ['/bin/zsh', '-l'], cwd: '/tmp', name: 'zsh', pid: 61_321 };
const busyProcess = { argv: ['omp'], cwd: '/tmp', name: '18.12.6', pid: 63_542 };

const writeProcess = (block: number, foreground: typeof shell | null, child: typeof shell | null = shell): void => {
  writeFileSync(path.join(sandbox.ternDir, `process-${block}.json`), JSON.stringify({ child, foreground, group: foreground?.pid ?? child?.pid ?? null, pane: block }));
};

const addFeature = async (): Promise<string> => {
  const dir = managedPath('feature-x');
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', dir, 'origin/feature/x');
  return dir;
};

describe('remove command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    writeTernLs({ work: [] });
  });

  describe('busy processes', () => {
    it('refuses a busy block before deleting the worktree or closing any block', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir, path.join(dir, 'src')] });
      writeProcess(2, busyProcess);
      const log = await logGitCalls();
      await expect(cliJson(['remove', dir])).resolves.toMatchObject({
        error: { blocks: [{ block: 2, process: busyProcess, session: 1, tab: 2 }], code: 'busy_tabs' },
      });
      expect(existsSync(dir)).toBeTruthy();
      await expect(git(repo.dir, 'rev-parse', '--verify', 'refs/heads/feature/x')).resolves.toMatch(/\S/u);
      expect(readLog(log).join('\n')).not.toMatch(/worktree remove|branch -D/u);
      const calls = ternLog();
      expect({ listing: calls[0], processes: calls.slice(1).toSorted() }).toStrictEqual({ listing: 'ls --json', processes: ['process 1 --json', 'process 2 --json'] });
    });

    it('identifies the named tab in its busy refusal message', async () => {
      const dir = await addFeature();
      writeTernListing({ sessions: [{ id: 1, name: 'work', tabs: [{ blocks: [{ cwd: dir, id: 1, title: 'omp' }], id: 2, name: 'feature tab' }] }] });
      writeProcess(1, busyProcess);
      const result = await cliJson(['remove', dir]);
      expect(result).toMatchObject({ error: { code: 'busy_tabs' } });
      expect(result).toHaveProperty('error.message', expect.stringContaining('feature tab'));
      expect(existsSync(dir)).toBeTruthy();
    });

    it('inspects every candidate block and reports all busy panes across sessions', async () => {
      const dir = await addFeature();
      writeTernListing({
        sessions: [
          {
            id: 10,
            name: 'work',
            tabs: [
              {
                blocks: [
                  { cwd: dir, id: 1, title: 'sh' },
                  { cwd: path.join(dir, 'src'), id: 2, title: 'sh' },
                ],
                id: 20,
                name: 'worktree',
              },
            ],
          },
          {
            id: 11,
            name: 'other',
            tabs: [
              {
                blocks: [
                  { cwd: dir, id: 3, title: 'sh' },
                  { cwd: repo.dir, id: 4, title: 'sh' },
                ],
                id: 21,
                name: 'worktree',
              },
            ],
          },
        ],
      });
      const command = { ...busyProcess, argv: ['omp', '--model', 'gpt-5'] };
      writeProcess(1, command);
      writeProcess(3, { ...busyProcess, pid: 63_543 });
      await expect(cliJson(['remove', dir])).resolves.toMatchObject({
        error: {
          blocks: [
            { block: 1, process: command, session: 10, tab: 20 },
            { block: 3, process: { ...busyProcess, pid: 63_543 }, session: 11, tab: 21 },
          ],
          code: 'busy_tabs',
          message: 'Foreground processes in blocks: 1 in tab "worktree" (omp --model gpt-5), 3 in tab "worktree" (omp); use --close-busy-tabs to close them after the user agrees',
        },
      });
      expect(existsSync(dir)).toBeTruthy();
      expect(ternLog()[0]).toBe('ls --json');
      expect(ternLog().slice(1).toSorted()).toStrictEqual(['process 1 --json', 'process 2 --json', 'process 3 --json']);
    });

    it('does not let --force discard work in a busy tab', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeProcess(1, busyProcess);
      writeFileSync(path.join(dir, 'draft.txt'), 'unfinished work\n');
      const log = await logGitCalls();
      await expect(cliJson(['remove', dir, '--force'])).resolves.toMatchObject({ error: { code: 'busy_tabs' } });
      expect(existsSync(path.join(dir, 'draft.txt'))).toBeTruthy();
      expect(readLog(log).join('\n')).not.toMatch(/worktree remove|branch -D/u);
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json']);
    });

    it('removes the worktree and closes busy blocks with --close-busy-tabs', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir, path.join(dir, 'src')] });
      writeProcess(1, busyProcess);
      vi.stubEnv('FAKE_TERN_FAIL', 'process');
      vi.stubEnv('FAKE_TERN_GONE_BEFORE_CLOSE', dir);
      await expect(cliJson(['remove', dir, '--close-busy-tabs'])).resolves.toMatchObject({ closedBlocks: [1, 2], removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
      expect(ternLog()[0]).toBe('ls --json');
      expect(ternLog().slice(1).toSorted()).toStrictEqual(['close 1 --json', 'close 2 --json']);
    });

    it('does not let --close-busy-tabs bypass the work-to-lose guard', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeProcess(1, busyProcess);
      writeFileSync(path.join(dir, 'draft.txt'), 'unfinished work\n');
      await expect(cliJson(['remove', dir, '--close-busy-tabs'])).resolves.toMatchObject({ error: { code: 'dirty_worktree' } });
      expect(existsSync(path.join(dir, 'draft.txt'))).toBeTruthy();
      expect(ternLog()).toStrictEqual(['ls --json']);
    });

    it('keeps the worktree and branch when process inspection fails', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_FAIL', 'process');
      const log = await logGitCalls();
      await expect(cliJson(['remove', dir])).resolves.toMatchObject({ error: { code: 'tern_failed', message: /Cannot inspect block 1/u } });
      expect(existsSync(dir)).toBeTruthy();
      await expect(git(repo.dir, 'rev-parse', '--verify', 'refs/heads/feature/x')).resolves.toMatch(/\S/u);
      expect(readLog(log).join('\n')).not.toMatch(/worktree remove|branch -D/u);
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json']);
    });

    it.each([
      { body: '{', detail: /SyntaxError/u, name: 'invalid JSON' },
      { body: '1', detail: /process snapshot.*object/iu, name: 'a scalar snapshot' },
      { body: 'null', detail: /process snapshot.*object/iu, name: 'a null snapshot' },
      { body: '[]', detail: /process snapshot.*object/iu, name: 'an array snapshot' },
      { body: '{}', detail: /invalid.*snapshot/iu, name: 'an empty snapshot' },
      { body: JSON.stringify({ child: shell, foreground: busyProcess, group: 63_542 }), detail: /invalid.*snapshot/iu, name: 'a snapshot without pane' },
      { body: JSON.stringify({ child: shell, foreground: busyProcess, group: 63_542, pane: '1' }), detail: /invalid.*snapshot/iu, name: 'a snapshot with string pane' },
      { body: JSON.stringify({ child: shell, foreground: busyProcess, pane: 1 }), detail: /invalid.*snapshot/iu, name: 'a snapshot without group' },
      { body: JSON.stringify({ child: shell, foreground: busyProcess, group: '63542', pane: 1 }), detail: /invalid.*snapshot/iu, name: 'a snapshot with string group' },
      { body: JSON.stringify({ foreground: busyProcess, group: 63_542, pane: 1 }), detail: /invalid.*snapshot/iu, name: 'a snapshot without child' },
      { body: JSON.stringify({ child: shell, group: 63_542, pane: 1 }), detail: /invalid.*snapshot/iu, name: 'a snapshot without foreground' },
      { body: JSON.stringify({ child: shell, foreground: 1, group: 63_542, pane: 1 }), detail: /process.*object/iu, name: 'a scalar foreground' },
      { body: JSON.stringify({ child: 1, foreground: busyProcess, group: 63_542, pane: 1 }), detail: /process.*object/iu, name: 'a scalar child' },
      { body: JSON.stringify({ child: shell, foreground: [], group: 63_542, pane: 1 }), detail: /process.*object/iu, name: 'an array foreground' },
      ...[
        { body: JSON.stringify({ child: shell, foreground: { argv: ['omp'], cwd: '/tmp', pid: 63_542 }, group: 63_542, pane: 1 }), name: 'a foreground without name' },
        { body: JSON.stringify({ child: shell, foreground: { ...busyProcess, name: 1 }, group: 63_542, pane: 1 }), name: 'a foreground with numeric name' },
        { body: JSON.stringify({ child: shell, foreground: { ...busyProcess, argv: 'omp' }, group: 63_542, pane: 1 }), name: 'a foreground with scalar argv' },
        { body: JSON.stringify({ child: shell, foreground: { ...busyProcess, argv: [1] }, group: 63_542, pane: 1 }), name: 'a foreground with non-string argument' },
        { body: JSON.stringify({ child: shell, foreground: { argv: ['omp'], name: 'omp', pid: 63_542 }, group: 63_542, pane: 1 }), name: 'a foreground without cwd' },
        { body: JSON.stringify({ child: shell, foreground: { ...busyProcess, cwd: 1 }, group: 63_542, pane: 1 }), name: 'a foreground with numeric cwd' },
        { body: JSON.stringify({ child: shell, foreground: { cwd: '/tmp', name: 'omp', pid: 63_542 }, group: 63_542, pane: 1 }), name: 'a foreground process without argv' },
        { body: JSON.stringify({ child: { argv: [], cwd: '/tmp', name: 'zsh' }, foreground: busyProcess, group: 63_542, pane: 1 }), name: 'a child without pid' },
        { body: JSON.stringify({ child: shell, foreground: { argv: ['omp'], cwd: '/tmp', name: 'omp' }, group: 63_542, pane: 1 }), name: 'a foreground without pid' },
        {
          body: JSON.stringify({ child: { argv: [], cwd: '/tmp', name: 'zsh' }, foreground: { argv: ['omp'], cwd: '/tmp', name: 'omp' }, group: 63_542, pane: 1 }),
          name: 'both processes without pid',
        },
        { body: JSON.stringify({ child: shell, foreground: { ...busyProcess, pid: '63542' }, group: 63_542, pane: 1 }), name: 'a foreground with string pid' },
        { body: JSON.stringify({ child: { argv: shell.argv, cwd: '/tmp', pid: shell.pid }, foreground: shell, group: shell.pid, pane: 1 }), name: 'a child without name' },
      ].map(entry => ({ ...entry, detail: /invalid.*process\s*$/iu })),
    ])('reports tern_failed without deleting anything for $name', async ({ body, detail }) => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeFileSync(path.join(sandbox.ternDir, 'process-1.json'), body);
      const log = await logGitCalls();
      const result = await cliJson(['remove', dir]);
      expect(result).toMatchObject({ error: { code: 'tern_failed' } });
      expect(result).toHaveProperty('error.message', expect.stringMatching(new RegExp(`Cannot inspect block 1:.*${detail.source}`, detail.flags)));
      await expect(git(repo.dir, 'rev-parse', '--verify', 'refs/heads/feature/x')).resolves.toMatch(/\S/u);
      expect(readLog(log).join('\n')).not.toMatch(/worktree remove|branch -D/u);
      expect({ calls: ternLog(), worktreeExists: existsSync(dir) }).toStrictEqual({ calls: ['ls --json', 'process 1 --json'], worktreeExists: true });
    });

    it('accepts null process directories and a null process group', async () => {
      const dir = await addFeature();
      const child = { ...shell, cwd: null };
      writeTernLs({ work: [dir] });
      writeFileSync(path.join(sandbox.ternDir, 'process-1.json'), JSON.stringify({ child, foreground: child, group: null, pane: 1 }));
      await expect(cliJson(['remove', dir])).resolves.toMatchObject({ closedBlocks: [1], removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
    });

    it.each([
      { child: shell, foreground: null, name: 'no foreground process' },
      { child: busyProcess, foreground: null, name: 'a non-shell child without a foreground process' },
      { child: shell, foreground: shell, name: 'the child shell' },
      ...['sh', 'bash', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell', 'cmd.exe'].map(name => ({
        child: { ...shell, name },
        foreground: { ...shell, name },
        name: `the child ${name} shell`,
      })),
    ])('removes a worktree whose tab has $name', async ({ child, foreground }) => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeProcess(1, foreground, child);
      await expect(cliJson(['remove', dir])).resolves.toMatchObject({ closedBlocks: [1], removed: dir, warnings: [] });
      expect(existsSync(dir)).toBeFalsy();
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json', 'close 1 --json']);
    });

    it.each([
      { child: shell, foreground: { ...shell, pid: 63_542 }, name: 'a nested shell' },
      { child: busyProcess, foreground: busyProcess, name: 'a program replacing the shell' },
      { child: null, foreground: shell, name: 'a shell without a terminal child' },
    ])('refuses a tab running $name', async ({ child, foreground }) => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeProcess(1, foreground, child);
      await expect(cliJson(['remove', dir])).resolves.toMatchObject({ error: { blocks: [{ block: 1, process: foreground }], code: 'busy_tabs' } });
      expect(existsSync(dir)).toBeTruthy();
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json']);
    });

    it('reports the process name when its argv and terminal child are unavailable', async () => {
      const dir = await addFeature();
      const foreground = { ...busyProcess, argv: [], cwd: dir, name: 'omp' };
      writeTernLs({ work: [dir] });
      writeProcess(1, foreground, null);
      const result = await cliJson(['remove', dir]);
      expect(result).toMatchObject({
        error: {
          blocks: [{ block: 1, process: foreground, session: 1, tab: 1 }],
          code: 'busy_tabs',
        },
      });
      expect(result).toHaveProperty('error.message', expect.stringContaining('omp'));
      expect(existsSync(dir)).toBeTruthy();
      expect(ternLog()).toStrictEqual(['ls --json', 'process 1 --json']);
    });
  });

  describe('tab lifecycle', () => {
    it('leaves the tabs alone under --keep-tab', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      writeProcess(1, busyProcess);
      vi.stubEnv('FAKE_TERN_FAIL', 'process');
      await expect(run([dir, '--keep-tab'])).resolves.toMatchObject({ closedBlocks: [], warnings: [] });
      expect(ternLog()).toStrictEqual([]);
      expect(existsSync(dir)).toBeFalsy();
    });

    it('removes the worktree when Tern cannot list the blocks', async () => {
      const dir = await addFeature();
      vi.stubEnv('FAKE_TERN_FAIL', 'ls');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['tabs not closed: fake tern: ls failed'] });
      expect(existsSync(dir)).toBeFalsy();
    });

    it('warns for each block that Tern cannot close', async () => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_FAIL', 'close');
      await expect(run([dir])).resolves.toMatchObject({ closedBlocks: [], warnings: ['block 1 not closed: fake tern: close failed'] });
    });

    it('passes on other errors before it removes anything', async () => {
      const dir = await addFeature();
      writeTernLsRaw('{');
      await expect(run([dir])).rejects.toBeInstanceOf(SyntaxError);
      expect(existsSync(dir)).toBeTruthy();
    });

    it.each<{ flags: string[] }>([{ flags: [] }, { flags: ['--force'] }])('closes each tab after the worktree is gone, with $flags', async ({ flags }) => {
      const dir = await addFeature();
      writeTernLs({ work: [dir] });
      vi.stubEnv('FAKE_TERN_GONE_BEFORE_CLOSE', dir);
      await expect(run([dir, ...flags])).resolves.toMatchObject({ closedBlocks: [1], warnings: [] });
    });
  });
});
