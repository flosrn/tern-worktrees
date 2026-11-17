import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/clean.ts';
import { CliError } from '../src/proc.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { git, ignoreGlobally, tempDir, tmpRepo, useSandbox, writeTernLs } from './helpers.ts';

const INVALID_SEGMENTS = 'rebuildable: expected path segments without "/", other than "." and ".."';

const writeFiles = (dir: string, files: Record<string, string>): void => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
};

const rejection = async (promise: Promise<unknown>): Promise<CliError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error('the promise resolved');
};

/** A repository with a submodule `outer` that holds a submodule `inner`, each pushed to its origin. */
const nestedSubmodules = async (): Promise<string> => {
  const inner = await tmpRepo('inner');
  const outer = await tmpRepo('outer');
  await git(outer.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', inner.dir, 'inner');
  await git(outer.dir, 'commit', '--quiet', '-m', 'add inner');
  await git(outer.dir, 'push', '--quiet', 'origin', 'main');
  const repo = await tmpRepo();
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', outer.origin, 'outer');
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init', '--recursive');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add outer');
  return repo.dir;
};

/** A linked worktree of a new repository, and its main checkout whose `.tern/worktree.json` declares `rebuildable`. */
const declaring = async (rebuildable: string[]): Promise<{ dir: string; main: string }> => {
  await ignoreGlobally('server.log', '.demo', '.env');
  const { dir: main } = await tmpRepo();
  const dir = tempDir('feature');
  await git(main, 'worktree', 'add', '--quiet', '--detach', dir);
  writeFiles(main, { '.tern/worktree.json': JSON.stringify({ rebuildable }) });
  return { dir, main };
};

/** An app repository with a merged linked worktree, and the path of the main checkout's `.tern/worktree.json`. */
const mergedWorktree = async (): Promise<{ dir: string; file: string; repo: string }> => {
  const { dir: repo } = await tmpRepo('app');
  const dir = path.join(tempDir('outside'), 'merged');
  await git(repo, 'worktree', 'add', '--quiet', '-b', 'merged', dir, 'origin/main');
  const file = path.join(repo, '.tern', 'worktree.json');
  mkdirSync(path.dirname(file));
  return { dir, file, repo };
};

describe('declared rebuildable segments', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(guardWorkToLose, () => {
    it('does not stop teardown on, or carry, a file under a segment the main checkout declares', async () => {
      const { dir, main } = await declaring(['server.log', '.demo']);
      writeFiles(dir, { '.demo/state.json': '{}\n', '.env': 'SECRET=1\n', 'server.log': 'started\n' });
      const error = await rejection(guardWorkToLose(dir, { removing: main }, main));
      expect({ code: error.code, hardToRebuild: error.extra.hardToRebuild }).toStrictEqual({ code: 'dirty_worktree', hardToRebuild: ['.env'] });
      await expect(guardWorkToLose(dir, 'recreating', main)).resolves.toStrictEqual(['.env']);
      rmSync(path.join(dir, '.env'));
      await expect(guardWorkToLose(dir, { removing: main }, main)).resolves.toStrictEqual([]);
    });

    it('does not read a directory under a declared segment', async () => {
      const { dir, main } = await declaring(['.demo']);
      writeFiles(dir, { '.demo/state.json': '{}\n' });
      chmodSync(path.join(dir, '.demo'), 0o000);
      try {
        await expect(guardWorkToLose(dir, { removing: main }, main)).resolves.toStrictEqual([]);
      } finally {
        chmodSync(path.join(dir, '.demo'), 0o755);
      }
    });

    it('ignores a declaration that only the worktree under inspection holds', async () => {
      const { dir, main } = await declaring([]);
      writeFiles(dir, { '.tern/worktree.json': JSON.stringify({ rebuildable: ['server.log'] }) });
      await git(dir, 'add', '.tern');
      await git(dir, 'commit', '--quiet', '-m', 'declare server.log');
      writeFiles(dir, { 'server.log': 'started\n' });
      const error = await rejection(guardWorkToLose(dir, { removing: main }, main));
      expect({ code: error.code, hardToRebuild: error.extra.hardToRebuild }).toStrictEqual({ code: 'dirty_worktree', hardToRebuild: ['server.log'] });
    });

    it('applies a declared segment inside submodules at each depth, without reading a declared directory', async () => {
      const main = await nestedSubmodules();
      await ignoreGlobally('server.log', '.demo');
      const dir = tempDir('feature');
      await git(main, 'worktree', 'add', '--quiet', '--detach', dir);
      await git(dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init', '--recursive');
      writeFiles(main, { '.tern/worktree.json': JSON.stringify({ rebuildable: ['server.log', '.demo'] }) });
      writeFiles(dir, { 'outer/.demo/state.json': '{}\n', 'outer/inner/server.log': 'started\n' });
      chmodSync(path.join(dir, 'outer', '.demo'), 0o000);
      try {
        await expect(guardWorkToLose(dir, { removing: main }, main)).resolves.toStrictEqual([]);
        await expect(guardWorkToLose(dir, 'recreating', main)).resolves.toStrictEqual([]);
      } finally {
        chmodSync(path.join(dir, 'outer', '.demo'), 0o755);
      }
    });

    it('stops both operations when the main checkout declaration is invalid', async () => {
      const { dir, main } = await declaring(['logs/server.log']);
      for (const operation of ['recreating', { removing: main }] as const) {
        // eslint-disable-next-line no-await-in-loop -- Each operation runs on the same worktree in turn.
        const error = await rejection(guardWorkToLose(dir, operation, main));
        expect({ code: error.code, message: error.message }).toStrictEqual({
          code: 'worktree_config_invalid',
          message: `${path.join(main, '.tern', 'worktree.json')}: ${INVALID_SEGMENTS}`,
        });
      }
    });
  });

  describe('clean', () => {
    beforeEach(() => {
      writeTernLs({ work: [] });
    });

    it('removes a merged worktree whose ignored files are all under segments the main checkout declares', async () => {
      const { dir, file, repo } = await mergedWorktree();
      await ignoreGlobally('next-env.d.ts', 'test-results/', 'parlant.log');
      writeFileSync(file, JSON.stringify({ rebuildable: ['next-env.d.ts', 'test-results', 'parlant.log'] }));
      writeFiles(dir, { 'next-env.d.ts': '/// <reference types="next" />\n', 'parlant.log': 'started\n', 'test-results/run/trace.zip': 'trace\n' });
      const result = await run(['--repo', repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([dir]);
      expect(existsSync(dir)).toBeFalsy();
    });

    it('keeps a merged worktree when the main checkout declares an invalid rebuildable list', async () => {
      const { dir, file, repo } = await mergedWorktree();
      writeFileSync(file, JSON.stringify({ rebuildable: ['.'] }));
      const result = await run(['--repo', repo, '--apply']);
      expect(result.remove.worktrees).toStrictEqual([]);
      expect(result.keep).toContainEqual({ id: dir, kind: 'worktree', reason: `worktree inspection failed: ${file}: ${INVALID_SEGMENTS}` });
      expect(existsSync(dir)).toBeTruthy();
    });
  });
});
