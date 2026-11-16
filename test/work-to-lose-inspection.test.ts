import fs, { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { git, gitShim, ignoreGlobally, tempDir, tmpRepo, useSandbox } from './helpers.ts';

const writeFiles = (dir: string, files: Record<string, string>): void => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
};

describe('work-to-lose inspection failures', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each(['recreating', 'removing'])('keeps work to lose when ignored names cannot be decoded without loss while %s', async operation => {
    const { dir } = await tmpRepo();
    await gitShim(`if [ "$3" = ls-files ]; then printf 'local-\\377/\\0local-\\357\\277\\275/\\0'; exit 0; fi`);
    const failure = guardWorkToLose(dir, operation === 'recreating' ? 'recreating' : { removing: tempDir('main') }, dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/path name.*UTF-8/u);
  });

  it.each(['recreating', 'removing'])('keeps work to lose when Git reports a partial ignored listing with a warning while %s', async operation => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/00.tsbuildinfo': 'generated\n', 'local/secrets/private.env': 'local settings\n' });
    await gitShim(`if [ "$3" = ls-files ]; then printf 'local/00.tsbuildinfo\\0'; echo 'warning: could not open local/secrets/: Permission denied' >&2; exit 0; fi`);
    const failure = guardWorkToLose(dir, operation === 'recreating' ? 'recreating' : { removing: tempDir('main') }, dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/Permission denied/u);
  });

  it('keeps work to lose when a directory becomes unreadable during ignored expansion', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/00.tsbuildinfo': 'generated\n', 'local/secrets/private.env': 'local settings\n' });
    const secrets = path.join(dir, 'local', 'secrets');
    await gitShim(`if [ "$3" = ls-files ]; then chmod 000 '${secrets}'; printf 'local/\\0'; exit 0; fi`);
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
      await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      chmodSync(secrets, 0o700);
    }
  });

  it('reads every ignored file without relying on a second Git expansion', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/00.tsbuildinfo': 'generated\n', 'local/secrets/private.env': 'local settings\n' });
    await gitShim(`if [ "$3" = ls-files ] && [ "$8" = -- ]; then printf 'local/00.tsbuildinfo\\0'; exit 0; fi`);
    await expect(guardWorkToLose(dir, 'recreating', dir)).resolves.toStrictEqual(['local/secrets/private.env']);
    await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).rejects.toMatchObject({
      code: 'dirty_worktree',
      extra: { files: ['!! local/secrets/private.env'], hardToRebuild: ['local/secrets/private.env'] },
    });
  });

  it('preserves a valid replacement character in an ignored directory name', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local-*/');
    writeFiles(dir, { 'local-�/private.env': 'local settings\n' });
    await expect(guardWorkToLose(dir, 'recreating', dir)).resolves.toStrictEqual(['local-�/private.env']);
    await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).rejects.toMatchObject({
      code: 'dirty_worktree',
      extra: { files: ['!! local-�/private.env'], hardToRebuild: ['local-�/private.env'] },
    });
  });

  it('keeps nested repositories and symbolic links as single ignored entries', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    const nested = path.join(dir, 'local', 'nested');
    mkdirSync(nested, { recursive: true });
    await git(nested, 'init', '--quiet');
    writeFileSync(path.join(nested, 'private.env'), 'local settings\n');
    symlinkSync('missing', path.join(dir, 'local', 'link'));
    await expect(guardWorkToLose(dir, 'recreating', dir)).resolves.toStrictEqual(['local/link', 'local/nested/']);
    await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).rejects.toMatchObject({
      code: 'dirty_worktree',
      extra: { files: ['!! local/link', '!! local/nested/'], hardToRebuild: ['local/link', 'local/nested/'] },
    });
  });

  it('refuses an undecodable child name found while reading an ignored directory', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/private.env': 'local settings\n' });
    const original = fs.readdirSync;
    // SAFETY: the double preserves each result type and replaces only raw Buffer names.
    const invalidNames = ((...args: Parameters<typeof fs.readdirSync>) => {
      const entries = original(...args);
      return entries.map(entry => (Buffer.isBuffer(entry) ? Buffer.from([0xff]) : entry));
    }) as typeof fs.readdirSync;
    const listing = vi.spyOn(fs, 'readdirSync').mockImplementation(invalidNames);
    syncBuiltinESMExports();
    try {
      const failure = guardWorkToLose(dir, 'recreating', dir);
      await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
      await expect(failure).rejects.toThrow(/path name.*UTF-8/u);
    } finally {
      listing.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each([
    { ignored: ['mixed/ignored.env', 'mixed/kept.txt'], name: 'tracked parent', rules: 'mixed/\n', tracked: true },
    { ignored: ['mixed/ignored.env', 'mixed/kept.txt'], name: 'tracked pattern', rules: 'mixed/*\n', tracked: true },
    { ignored: ['mixed/ignored.env'], name: 'tracked negation', rules: 'mixed/*\n!mixed/kept.txt\n', tracked: true },
    { ignored: ['mixed/ignored.env', 'mixed/tracked.txt'], name: 'untracked negation', rules: 'mixed/*\n!mixed/kept.txt\n', tracked: false },
    { ignored: ['mixed/ignored.env'], name: 'untracked partial', rules: '*.env\n', tracked: false },
    { ignored: [], name: 'untracked nested negation', rules: 'mixed/ignored/\n!mixed/kept.txt\n', tracked: false },
  ])('preserves ignored paths for $name directory rules', async ({ ignored, rules, tracked }) => {
    const { dir } = await tmpRepo();
    writeFiles(dir, { 'mixed/tracked.txt': 'tracked\n' });
    if (tracked) {
      await git(dir, 'add', 'mixed/tracked.txt');
    }
    writeFileSync(path.join(dir, '.gitignore'), rules);
    await git(dir, 'add', '.gitignore');
    await git(dir, 'commit', '--quiet', '-m', 'track ignore rules');
    writeFiles(dir, { 'mixed/ignored.env': 'local\n', 'mixed/kept.txt': 'untracked\n' });
    const failure = guardWorkToLose(dir, { removing: tempDir('main') }, dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree', extra: { hardToRebuild: ignored } });
  });

  it('reports the failed ignored listing status when Git has no diagnostic', async () => {
    const { dir } = await tmpRepo();
    await gitShim(`if [ "$3" = ls-files ]; then exit 7; fi`);
    const failure = guardWorkToLose(dir, 'recreating', dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/inspection exited 7/u);
  });
});
