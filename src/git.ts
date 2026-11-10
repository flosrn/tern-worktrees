import { createHash } from 'node:crypto';
import { constants, cpSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, must, run } from './proc.ts';
import type { RunResult } from './proc.ts';

/** One entry of `git worktree list`. `locked` holds the text of the lock, empty when the lock has no text, or null when the worktree has no lock. */
export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  locked: string | null;
  prunable: boolean;
}

/** Runs `git -C <dir> <args>`, waits for it to exit, and returns its exit status, standard output and standard error. It does not throw when git fails. */
export const gitRun = async (dir: string, ...args: string[]): Promise<RunResult> => await run(['git', '-C', dir, ...args]);

/** Runs `git -C <dir> <args>` and returns its standard output. Throws `git_failed` when git exits with a status other than 0. */
export const gitMust = async (dir: string, ...args: string[]): Promise<string> => await must(['git', '-C', dir, ...args], 'git_failed');

/** Tells if `git -C <dir> <args>` exits with status 0. */
export const gitSucceeds = async (dir: string, ...args: string[]): Promise<boolean> => {
  const result = await gitRun(dir, ...args);
  return result.status === 0;
};

/** Tells if `commit` is an ancestor of `of` in the repository at `dir`, or the same commit. */
export const isAncestor = async (dir: string, commit: string, of: string): Promise<boolean> => await gitSucceeds(dir, 'merge-base', '--is-ancestor', commit, of);

const mainCheckoutOf = (commonDir: string, gitDir: string, bare: string, topLevel: string | undefined): string | null => {
  if (bare === 'true') {
    return null;
  }
  if (commonDir.endsWith('/.git')) {
    return path.dirname(commonDir);
  }
  // An external git directory identifies its main checkout only from that checkout, not from a linked worktree.
  return gitDir === commonDir ? (topLevel ?? null) : null;
};

const ABSOLUTE_PATH = '--path-format=absolute';
const MODULES = 'modules';
const GIT_PATH = '--git-path';
const commonDirArgs = ['rev-parse', ABSOLUTE_PATH, '--git-common-dir', '--git-dir', '--is-bare-repository', '--show-toplevel'];

/** The main checkout of the repository that holds `dir`, or null when `dir` is not in a repository with a checkout. */
export const repoRoot = async (dir: string): Promise<string | null> => {
  const result = await gitRun(dir, ...commonDirArgs);
  const [commonDir, gitDir, bare, topLevel] = result.stdout.trimEnd().split('\n');
  return mainCheckoutOf(commonDir, gitDir, bare, topLevel);
};

/** Like {@link repoRoot}, but throws `not_a_repo` when `dir` is not in a repository with a checkout. */
export const requireRepoRoot = async (dir: string): Promise<string> => {
  const root = await repoRoot(dir);
  if (root === null) {
    throw new CliError('not_a_repo', `${dir} is not in a git repository`);
  }
  return root;
};

/** The position of a directory in its repository. `main` is the top directory of the main checkout, `linked` is the top directory of a linked worktree, and `inside` is a different directory in the repository. */
export type CheckoutRole = 'main' | 'linked' | 'inside';

/** A directory in a repository with a checkout: `main` is the main checkout, as git reports it. */
export interface Checkout {
  main: string;
  role: CheckoutRole;
}

/** The checkout at `dir`, or null when `dir` is not in a repository with a checkout. It compares real paths. */
export const checkoutAt = async (dir: string): Promise<Checkout | null> => {
  const result = await gitRun(dir, ...commonDirArgs);
  const [commonDir, gitDir, bare, topLevel] = result.stdout.trimEnd().split('\n');
  const main = mainCheckoutOf(commonDir, gitDir, bare, topLevel);
  if (main === null) {
    return null;
  }
  const realDir = realpathSync(dir);
  if (topLevel !== realDir) {
    return { main, role: 'inside' };
  }
  return { main, role: main === realDir ? 'main' : 'linked' };
};

/** Like {@link checkoutAt}, but throws `not_a_repo` when `dir` is not in a repository with a checkout. */
export const requireCheckoutAt = async (dir: string): Promise<Checkout> => {
  const checkout = await checkoutAt(dir);
  if (checkout === null) {
    throw new CliError('not_a_repo', `${dir} is not in a git repository`);
  }
  return checkout;
};

/** The branch checked out at `dir`, or null when `dir` has a detached `HEAD`. A tag of the same name does not change it. */
export const currentBranch = async (dir: string): Promise<string | null> => {
  const result = await gitRun(dir, 'symbolic-ref', '-q', 'HEAD');
  const ref = result.stdout.trim();
  return ref === '' ? null : ref.slice('refs/heads/'.length);
};

/**
 * Fetches `origin` in the repository at `root`. When `prune` is true, it also removes the tracking branches of the branches that `origin` deleted.
 * Returns a warning that starts with `fetch failed:` when the fetch fails, else null.
 */
export const fetchOrigin = async (root: string, prune: boolean): Promise<string | null> => {
  const result = await gitRun(root, 'fetch', ...(prune ? ['--prune'] : []), 'origin');
  return result.status === 0 ? null : `fetch failed: ${result.stderr.trim()}`;
};

const parseWorktree = (record: string, index: number): Worktree => {
  const [first, ...fields] = record.split('\0');
  const worktree: Worktree = { branch: null, head: '', locked: null, main: index === 0, path: first.slice('worktree '.length), prunable: false };
  for (const field of fields) {
    const [key] = field.split(' ');
    const value = field.slice(key.length + 1);
    if (key === 'HEAD') {
      worktree.head = value;
    } else if (key === 'branch') {
      worktree.branch = value.slice('refs/heads/'.length);
    } else if (key === 'locked') {
      worktree.locked = value;
    } else if (key === 'prunable') {
      worktree.prunable = true;
    }
  }
  return worktree;
};

/** All worktrees of the repository at `root`, the main checkout first. */
export const worktrees = async (root: string): Promise<Worktree[]> => {
  const output = await gitMust(root, 'worktree', 'list', '--porcelain', '-z');
  return output
    .split('\0\0')
    .filter(record => record !== '')
    .map(parseWorktree);
};

/** The deterministic even base port of a repository branch, in the range 4000 through 5998. */
const branchPort = (root: string, branch: string): number =>
  4000 +
  2 *
    (createHash('sha256')
      .update(`${path.basename(root)}/${branch}`)
      .digest()
      .readUInt32BE(0) %
      1000);

/** Finds the first free even base port, with wraparound. */
const freePort = (start: number, used: Set<number>): number => {
  let port = start;
  while (used.has(port)) {
    port = port === 5998 ? 4000 : port + 2;
  }
  return port;
};

/** Resolves saved ports before deriving the ports of older branch worktrees. */
const portsForBranches = async (root: string, branches: string[]): Promise<Map<string, number>> => {
  const configured = await Promise.all(
    branches.toSorted().map(async name => {
      const result = await gitRun(root, 'config', '--get', `branch.${name}.ternWtPort`);
      return { name, port: result.status === 0 ? Number(result.stdout.trim()) : null };
    }),
  );
  const used = new Set<number>();
  const ports = new Map<string, number>();
  for (const entry of configured) {
    if (entry.port !== null && !used.has(entry.port)) {
      ports.set(entry.name, entry.port);
      used.add(entry.port);
    }
  }
  for (const entry of configured) {
    if (!ports.has(entry.name)) {
      const port = freePort(branchPort(root, entry.name), used);
      ports.set(entry.name, port);
      used.add(port);
    }
  }
  return ports;
};

/** Reads a branch's saved base port, or derives a free port without writing config. */
export const worktreePort = async (root: string, branch: string): Promise<number> => {
  const listed = await worktrees(root);
  const branches = new Set(listed.filter(worktree => !worktree.main && !worktree.prunable).flatMap(worktree => (worktree.branch === null ? [] : [worktree.branch])));
  branches.add(branch);
  const ports = await portsForBranches(root, [...branches]);
  return Number(ports.get(branch));
};

/** Saves live worktree ports before a new branch gets its port. Concurrent creates must run sequentially. */
export const assignWorktreePort = async (root: string, branch: string | null, created: boolean): Promise<number | null> => {
  if (branch === null) {
    return null;
  }
  const listed = await worktrees(root);
  const branches = listed
    .filter(worktree => !worktree.main && !worktree.prunable && (!created || worktree.branch !== branch))
    .flatMap(worktree => (worktree.branch === null ? [] : [worktree.branch]));
  const ports = await portsForBranches(root, branches);
  if (created) {
    const saved = await gitRun(root, 'config', '--get', `branch.${branch}.ternWtPort`);
    const used = new Set(ports.values());
    const previous = Number(saved.stdout.trim());
    ports.set(branch, saved.status === 0 && !used.has(previous) ? previous : freePort(branchPort(root, branch), used));
  }
  for (const [name, port] of ports) {
    // Git config writes share one lock file.
    // eslint-disable-next-line no-await-in-loop
    await gitMust(root, 'config', `branch.${name}.ternWtPort`, String(port));
  }
  return Number(ports.get(branch));
};

const lines = (output: string): string[] => output.split('\n').filter(line => line !== '');

const statusArgs = (ignoreSubmodules: 'all' | 'none'): string[] => ['status', '--porcelain', '--untracked-files=all', `--ignore-submodules=${ignoreSubmodules}`];

/**
 * The `git status --porcelain` lines of the worktree at `dir`, submodule changes included. It lists each file that git does not track,
 * also when `status.showUntrackedFiles` hides them.
 */
export const dirtyFiles = async (dir: string): Promise<string[]> => lines(await gitMust(dir, ...statusArgs('none')));

/** The number of changed files of the worktree at `dir`, and `error`, the git error when git cannot count them, else null. */
export interface ChangedCount {
  count: number;
  error: string | null;
}

/**
 * Counts the files that {@link dirtyFiles} lists, without a throw. When git fails, for example on a submodule with a broken `.git` file,
 * `error` holds the git error and the count does not include the submodules. The count is 0 when that fails too.
 */
export const changedFileCount = async (dir: string): Promise<ChangedCount> => {
  const full = await gitRun(dir, ...statusArgs('none'));
  if (full.status === 0) {
    return { count: lines(full.stdout).length, error: null };
  }
  const outer = await gitRun(dir, ...statusArgs('all'));
  return { count: outer.status === 0 ? lines(outer.stdout).length : 0, error: full.stderr.trim() };
};

/** The path config entries in `.gitmodules` at `base`. Git runs in `top`. */
const gitmodulesEntries = async (top: string, base: string): Promise<{ key: string; sub: string }[]> => {
  const result = await gitRun(top, 'config', '-z', '-f', path.join(base, '.gitmodules'), '--get-regexp', String.raw`^submodule\..*\.path$`);
  return result.stdout
    .split('\0')
    .filter(entry => entry !== '')
    .map(entry => ({ key: entry.slice(0, entry.indexOf('\n')), sub: entry.slice(entry.indexOf('\n') + 1) }));
};

const brokenGitfilesUnder = async (top: string, base: string): Promise<string[]> => {
  const subs = await gitmodulesEntries(top, base);
  const found = await Promise.all(
    subs.map(async ({ sub }) => {
      const subDir = path.join(base, sub);
      const gitfile = path.join(subDir, '.git');
      const broken = lstatSync(gitfile, { throwIfNoEntry: false })?.isFile() === true && !(await gitSucceeds(subDir, 'rev-parse', '--git-dir'));
      return [...(broken ? [gitfile] : []), ...(await brokenGitfilesUnder(top, subDir))];
    }),
  );
  return found.flat();
};

/**
 * The `.git` files of the submodules of the worktree at `dir`, at each depth, that point to no git directory. It reads the submodule paths
 * from the `.gitmodules` files, so it also finds a submodule in a submodule with a broken `.git` file.
 */
const brokenSubmoduleGitfiles = async (dir: string): Promise<string[]> => await brokenGitfilesUnder(dir, dir);

/**
 * Repairs the submodule `.git` files that omp clone mode copied into the worktree at `dir`. This copies the submodule git directories of the
 * main checkout (`.git/modules`) into the git directory of the worktree, copy-on-write where the file system can. Then it removes each broken
 * `.git` file. When the copy fails, the `.git` files stay and a `submodule repair failed:` warning tells why.
 */
const repairClonedSubmodules = async (root: string, dir: string): Promise<string[]> => {
  const broken = await brokenSubmoduleGitfiles(dir);
  if (broken.length === 0) {
    return [];
  }
  try {
    const [from, to] = await Promise.all([root, dir].map(async checkout => await gitMust(checkout, 'rev-parse', ABSOLUTE_PATH, GIT_PATH, MODULES)));
    cpSync(from.trim(), to.trim(), { mode: constants.COPYFILE_FICLONE, recursive: true });
  } catch (error) {
    // SAFETY: the git step throws a CliError, and the copy throws an Error from node:fs.
    return [`submodule repair failed: ${(error as Error).message}`];
  }
  for (const gitfile of broken) {
    rmSync(gitfile);
  }
  return [];
};

/** Tells if the object store at `dir` holds `commit`. */
const hasCommit = async (dir: string, commit: string): Promise<boolean> => await gitSucceeds(dir, 'cat-file', '-e', `${commit}^{commit}`);

/** Copies borrowed objects after checkout, then removes their reference. A failure keeps the reference and becomes an update warning. */
const dissociateSubmodule = async (target: string, sub: string): Promise<string[]> => {
  try {
    const alternates = await gitMust(target, 'rev-parse', ABSOLUTE_PATH, GIT_PATH, 'objects/info/alternates');
    if (!lstatSync(alternates.trim(), { throwIfNoEntry: false })) {
      return [];
    }
    await gitMust(target, 'repack', '-a', '-d');
    rmSync(alternates.trim(), { force: true });
    return [];
  } catch (error) {
    // SAFETY: git commands throw a CliError, and file removal throws an Error from node:fs.
    return [`local submodule reuse failed for ${sub}: ${(error as Error).message}; reference to main checkout objects remains`];
  }
};

/** Fetches the recorded commit from a shallow local source before checking it out. */
const fetchLocalCommit = async (target: string, source: string, commit: string): Promise<RunResult> => {
  const fetched = await gitRun(target, '-c', 'protocol.file.allow=always', 'fetch', '--depth', '1', pathToFileURL(source).href, commit);
  return fetched.status === 0 ? await gitRun(target, 'checkout', '--detach', commit) : fetched;
};
/** Initializes top-level submodules from independent copies of the main checkout's objects when it holds the recorded commit. */
const reuseLocalSubmodules = async (root: string, dir: string): Promise<string[]> => {
  const entries = await gitmodulesEntries(dir, dir);
  await gitRun(dir, 'submodule', 'init');
  const warnings = await Promise.all(
    entries.map(async ({ key, sub }) => {
      const source = path.join(root, sub);
      const target = path.join(dir, sub);
      if (!lstatSync(path.join(source, '.git'), { throwIfNoEntry: false }) || lstatSync(path.join(target, '.git'), { throwIfNoEntry: false })) {
        return [];
      }
      const recorded = await gitRun(dir, 'ls-tree', '--format=%(objectname)', 'HEAD', '--', sub);
      if (!(await hasCommit(source, recorded.stdout.trim()))) {
        return [];
      }
      const urlKey = `${key.slice(0, -'path'.length)}url`;
      const url = await gitRun(dir, 'config', '--get', urlKey);
      if (url.status !== 0) {
        return [];
      }
      const moduleName = key.slice('submodule.'.length, -'.path'.length);
      const moduleDir = await gitMust(dir, 'rev-parse', ABSOLUTE_PATH, GIT_PATH, `${MODULES}/${moduleName}`);
      const cloned = !lstatSync(moduleDir.trim(), { throwIfNoEntry: false });
      const shallow = await gitRun(source, 'rev-parse', '--is-shallow-repository');
      const isShallow = shallow.stdout.trim() === 'true';
      let initialized = await gitRun(
        dir,
        '-c',
        'protocol.file.allow=always',
        '-c',
        `${urlKey}=${isShallow ? pathToFileURL(source).href : source}`,
        'submodule',
        'update',
        '--init',
        ...(isShallow ? ['--depth', '1'] : ['--reference', source]),
        '--no-fetch',
        '--',
        sub,
      );
      if (isShallow && initialized.status !== 0 && lstatSync(path.join(target, '.git'), { throwIfNoEntry: false })) {
        initialized = await fetchLocalCommit(target, source, recorded.stdout.trim());
      }
      if (cloned && lstatSync(path.join(target, '.git'), { throwIfNoEntry: false })) {
        await gitRun(target, 'remote', 'set-url', 'origin', url.stdout.trim());
      }
      if (initialized.status !== 0) {
        return [`local submodule reuse failed for ${sub}: ${initialized.stderr.trim()}`];
      }
      if (!lstatSync(path.join(target, '.git'), { throwIfNoEntry: false })) {
        return [];
      }
      return isShallow ? [] : await dissociateSubmodule(target, sub);
    }),
  );
  return warnings.flat();
};

/**
 * Updates the submodules of the worktree at `dir`. `root` is its main checkout. It repairs the `.git` files that omp clone mode copied,
 * initializes top-level submodules from local objects where possible, then runs `git submodule update --init --recursive`.
 * Warnings keep the repair warning first, then the update warning.
 */
export const updateSubmodules = async (root: string, dir: string): Promise<string[]> => {
  const warnings = await repairClonedSubmodules(root, dir);
  warnings.push(...(await reuseLocalSubmodules(root, dir)));
  const result = await gitRun(dir, 'submodule', 'update', '--init', '--recursive');
  return result.status === 0 ? warnings : [...warnings, `submodule update failed: ${result.stderr.trim()}`];
};

/** The paths of the initialized submodules of the worktree at `dir`, at each depth, relative to `dir`. A submodule comes before the submodules in it. */
export const submodules = async (dir: string): Promise<string[]> => lines(await gitMust(dir, 'submodule', 'foreach', '--quiet', '--recursive', 'printf "%s\\n" "$displaypath"'));

/** The commit recorded for `sub` at `revision` that is also in the object store of the submodule, or null. */
export const recordedSubmoduleCommit = async (dir: string, revision: string, sub: string): Promise<string | null> => {
  const result = await gitRun(dir, 'ls-tree', '--format=%(objectname)', revision, '--', sub);
  const commit = result.stdout.trim();
  if (!(await hasCommit(path.join(dir, sub), commit))) {
    return null;
  }
  return commit;
};

/** The short hashes of the commits of `HEAD` and local branches not held by a remote branch or by `retained`. */
export const unpushedCommits = async (dir: string, retained: string | null): Promise<string[]> => {
  const kept = retained !== null && (await hasCommit(dir, retained));
  return lines(await gitMust(dir, 'rev-list', '--abbrev-commit', 'HEAD', '--branches', '--not', '--remotes', ...(kept ? [retained] : [])));
};

/** The ignored files of the worktree at `dir`, one entry for each file, as paths relative to `dir`. It does not look into submodules. */
export const ignoredFiles = async (dir: string): Promise<string[]> => {
  const output = await gitMust(dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard');
  return output.split('\0').filter(file => file !== '');
};
