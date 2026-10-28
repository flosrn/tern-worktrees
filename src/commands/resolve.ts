import path from 'node:path';
import { directoryArgs } from '../directory-args.ts';
import { repoRoot } from '../git.ts';
import { readOrigin } from '../github.ts';
import { repoKey } from '../repo-ref.ts';

/** The repository that holds a directory, with null values when the directory is not in a repository. */
export interface ResolvedDir {
  dir: string;
  root: string | null;
  name: string | null;
  owner: string | null;
  origin: string | null;
}

const resolveDir = async (dir: string): Promise<ResolvedDir> => {
  const root = await repoRoot(dir);
  if (root === null) {
    return { dir, name: null, origin: null, owner: null, root: null };
  }
  const { github } = await readOrigin(root);
  return { dir, name: path.basename(root), origin: github ? repoKey(github) : null, owner: github?.owner ?? null, root };
};

/** `resolve <dir>...`: the repository root, name, GitHub owner and origin of each directory. Each distinct directory resolves once. */
export const run = async (args: string[]): Promise<{ repos: ResolvedDir[] }> => {
  const { positionals, originalPositionals } = directoryArgs({ allowPositionals: true, args, options: {} });
  const byDir = new Map<string, Promise<ResolvedDir>>();
  const repos = positionals.map(async (dir, index) => {
    const resolving = byDir.get(dir) ?? resolveDir(dir);
    byDir.set(dir, resolving);
    return { ...(await resolving), dir: originalPositionals[index] };
  });
  return { repos: await Promise.all(repos) };
};
