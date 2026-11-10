import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { checkoutAt, repoRoot } from '../src/git.ts';
import { git, tempDir, useSandbox } from './helpers.ts';

describe('separate Git directories', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('finds a separate main checkout but rejects its linked worktree and metadata directory', async () => {
    const root = tempDir('separate-git');
    const checkout = path.join(root, 'checkout');
    const sub = path.join(checkout, 'sub');
    const linked = path.join(root, 'linked');
    const metadata = path.join(root, 'metadata');
    await git(root, 'init', '--quiet', '--separate-git-dir', metadata, checkout);
    await git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
    mkdirSync(sub);
    await git(checkout, 'worktree', 'add', '--quiet', '-b', 'side', linked);
    await expect(Promise.all([repoRoot(checkout), repoRoot(sub), repoRoot(linked), repoRoot(metadata)])).resolves.toStrictEqual([checkout, checkout, null, null]);
    await expect(Promise.all([checkoutAt(checkout), checkoutAt(sub), checkoutAt(linked), checkoutAt(metadata)])).resolves.toStrictEqual([
      { main: checkout, role: 'main' },
      { main: checkout, role: 'inside' },
      null,
      null,
    ]);
  });

  it('gives null in a bare repository named .git', async () => {
    const root = tempDir('bare');
    const bare = path.join(root, '.git');
    await git(root, 'init', '--quiet', '--bare', bare);
    await expect(Promise.all([repoRoot(bare), checkoutAt(bare)])).resolves.toStrictEqual([null, null]);
  });
});
