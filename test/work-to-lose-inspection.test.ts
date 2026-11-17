import { once } from 'node:events';
import fs, { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { guardWorkToLose } from '../src/work-to-lose.ts';
import { must } from '../src/proc.ts';
import { afterGitListing, git, gitShim, ignoreGlobally, tempDir, tmpRepo, useSandbox, writeFiles } from './helpers.ts';

describe('work-to-lose inspection failures', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each(['recreating', 'removing'])('keeps work to lose when ignored names cannot be decoded without loss while %s', async operation => {
    const { dir } = await tmpRepo();
    await gitShim(`if [ "$3 $5" = 'ls-files --others' ]; then printf 'local-\\377/\\0local-\\357\\277\\275/\\0'; exit 0; fi`);
    const failure = guardWorkToLose(dir, operation === 'recreating' ? 'recreating' : { removing: tempDir('main') }, dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/path name.*UTF-8/u);
  });

  it.each(['recreating', 'removing'])('keeps work to lose when Git reports a partial ignored listing with a warning while %s', async operation => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/00.tsbuildinfo': 'generated\n', 'local/secrets/private.env': 'local settings\n' });
    await gitShim(`if [ "$3 $5" = 'ls-files --others' ]; then printf 'local/00.tsbuildinfo\\0'; echo 'warning: could not open local/secrets/: Permission denied' >&2; exit 0; fi`);
    const failure = guardWorkToLose(dir, operation === 'recreating' ? 'recreating' : { removing: tempDir('main') }, dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/Permission denied/u);
  });

  it('keeps work to lose when a directory becomes unreadable during ignored expansion', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/00.tsbuildinfo': 'generated\n', 'local/secrets/private.env': 'local settings\n' });
    const secrets = path.join(dir, 'local', 'secrets');
    await gitShim(`if [ "$3 $5" = 'ls-files --others' ]; then chmod 000 '${secrets}'; printf 'local/\\0'; exit 0; fi`);
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
      await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      chmodSync(secrets, 0o700);
    }
  });

  it('reads every ignored file of a collapsed ignored directory', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/00.tsbuildinfo': 'generated\n', 'local/secrets/private.env': 'local settings\n' });
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

  it('reports once an ignored file whose stored name is decomposed', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('*.env');
    const decomposed = 're\u0301sume\u0301.env';
    writeFiles(dir, { [`conf/${decomposed}`]: 'local settings\n' });
    const carried = await guardWorkToLose(dir, 'recreating', dir);
    expect(carried.map(file => file.normalize('NFC'))).toStrictEqual(['conf/r\u00E9sum\u00E9.env']);
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
    await gitShim(`if [ "$3 $5" = 'ls-files --others' ]; then exit 7; fi`);
    const failure = guardWorkToLose(dir, 'recreating', dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/inspection exited 7/u);
  });

  it('ignores FIFO and socket entries without carrying or opening them', async () => {
    vi.stubEnv('TMPDIR', '/tmp');
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    const local = path.join(dir, 'local');
    mkdirSync(local);
    await must(['mkfifo', path.join(local, 'pipe')], 'git_failed');
    const server = createServer();
    server.listen(path.join(local, 'socket'));
    await once(server, 'listening');
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).resolves.toStrictEqual([]);
      await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).resolves.toStrictEqual([]);
    } finally {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }, 5000);
});

describe('directory identity races', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each(['recreating', 'removing'])('refuses ignored files that change between the two inspections while %s', async operation => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('*');
    writeFiles(dir, { 'local/private.env': 'local settings\n' });
    const local = path.join(dir, 'local');
    await afterGitListing(2, `mv '${local}' '${path.join(dir, 'saved-local')}'; mkdir '${local}'`);
    const failure = guardWorkToLose(dir, operation === 'recreating' ? 'recreating' : { removing: tempDir('main') }, dir);
    await expect(failure).rejects.toThrow(/changed while its ignored files were inspected/u);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toHaveProperty('extra', { existing: dir });
  });

  it.each(['local', 'local/nested'])('refuses a directory replaced during direct reading at %s', async relative => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { [`${relative}/private.env`]: 'local settings\n' });
    const changed = path.join(dir, relative);
    const saved = path.join(dir, 'saved');
    const empty = tempDir('empty-directory');
    const original = fs.readdirSync;
    let replaced = false;
    const listing = vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
      if (file === changed && !replaced) {
        replaced = true;
        renameSync(changed, saved);
        symlinkSync(empty, changed);
      }
      return original(file, options);
    });
    syncBuiltinESMExports();
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      listing.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('refuses a file removed after its directory entries were listed', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/private.env': 'local settings\n' });
    const original = fs.readdirSync;
    const local = path.join(dir, 'local');
    const listing = vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
      const entries = original(file, options);
      if (file === local) {
        rmSync(path.join(local, 'private.env'), { force: true });
      }
      return entries;
    });
    syncBuiltinESMExports();
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      listing.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('refuses a child directory replaced between its parent inspection and descent', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/nested/private.env': 'local settings\n' });
    const nested = path.join(dir, 'local', 'nested');
    const original = fs.lstatSync;
    let replaced = false;
    const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const found = original(file, options);
      if (file === nested && !replaced) {
        replaced = true;
        renameSync(nested, path.join(dir, 'saved'));
        mkdirSync(nested);
      }
      return found;
    });
    syncBuiltinESMExports();
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('refuses a parent directory replaced while its child is inspected', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    mkdirSync(path.join(dir, 'local', 'nested'), { recursive: true });
    const local = path.join(dir, 'local');
    const nested = path.join(local, 'nested');
    const original = fs.readdirSync;
    let replaced = false;
    const listing = vi.spyOn(fs, 'readdirSync').mockImplementation((file, options) => {
      const entries = original(file, options);
      if (file === nested && !replaced) {
        replaced = true;
        renameSync(local, path.join(dir, 'saved'));
        mkdirSync(path.join(local, 'nested'), { recursive: true });
      }
      return entries;
    });
    syncBuiltinESMExports();
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      listing.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each(['dev', 'ino'] as const)('refuses a directory whose %s changes during inspection', async key => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    mkdirSync(path.join(dir, 'local'));
    const local = path.join(dir, 'local');
    const original = fs.lstatSync;
    let reads = 0;
    const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const found = original(file, options);
      reads += Number(file === local);
      if (file === local && found !== undefined && reads > 1) {
        Object.defineProperty(found, key, { value: Number(found[key]) + 1 });
      }
      return found;
    });
    syncBuiltinESMExports();
    try {
      await expect(guardWorkToLose(dir, 'recreating', dir)).rejects.toMatchObject({ code: 'dirty_worktree' });
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each(['missing', 'directory'])('refuses a Git-listed ignored file that is now %s', async kind => {
    const { dir } = await tmpRepo();
    if (kind === 'directory') {
      mkdirSync(path.join(dir, 'local.tsbuildinfo'));
    }
    await gitShim(`if [ "$3 $5" = 'ls-files --others' ]; then printf 'local.tsbuildinfo\\0'; exit 0; fi`);
    const failure = guardWorkToLose(dir, 'recreating', dir);
    await expect(failure).rejects.toMatchObject({ code: 'dirty_worktree' });
    await expect(failure).rejects.toThrow(/could not be inspected/u);
  });
});

describe('unverified nested repository markers', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('conservatively retains ignored directories with an unverified .git marker', async () => {
    const { dir } = await tmpRepo();
    await ignoreGlobally('local/');
    writeFiles(dir, { 'local/.git': 'not a repository\n', 'local/generated.tsbuildinfo': 'generated\n' });
    await expect(guardWorkToLose(dir, { removing: tempDir('main') }, dir)).rejects.toMatchObject({
      code: 'dirty_worktree',
      extra: { files: ['!! local/'], hardToRebuild: ['local/'] },
    });
    await expect(guardWorkToLose(dir, 'recreating', dir)).resolves.toStrictEqual(['local/']);
  });
});
