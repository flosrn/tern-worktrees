import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isJsonObject } from '../json.ts';
import { userHome } from '../paths.ts';
import { CliError } from '../proc.ts';

/** What `setup` did to a symbolic link. */
export type LinkAction = 'created' | 'kept' | 'replaced' | 'removed';

/** A symbolic link that `setup` manages, its target and what `setup` did to it. */
export interface SetupLink {
  path: string;
  target: string;
  action: LinkAction;
}

/** The output of `setup`. */
export interface SetupResult {
  links: SetupLink[];
}

const PACKAGE_NAME = 'tern-worktrees';

const conflict = (target: string, reason: string): CliError => new CliError('path_conflict', `${target} ${reason}`, { path: target });

const onDisk = <T>(target: string, action: () => T): T => {
  try {
    return action();
  } catch (error) {
    throw conflict(target, `cannot be used: ${String(error)}`);
  }
};

const existingAncestor = (dir: string): string => {
  try {
    lstatSync(dir);
    return dir;
  } catch {
    return existingAncestor(path.dirname(dir));
  }
};

const existingDirAbove = (link: string): string => {
  const ancestor = existingAncestor(path.dirname(link));
  if (!onDisk(ancestor, () => statSync(ancestor)).isDirectory()) {
    throw conflict(ancestor, 'is not a directory');
  }
  return ancestor;
};

const linkAction = (link: string, target: string): LinkAction => {
  const stat = onDisk(link, () => lstatSync(link, { throwIfNoEntry: false }));
  if (!stat) {
    return 'created';
  }
  if (!stat.isSymbolicLink()) {
    throw conflict(link, 'exists and is not a symbolic link');
  }
  return onDisk(link, () => readlinkSync(link)) === target ? 'kept' : 'replaced';
};

type PlannedLink = Pick<SetupLink, 'path' | 'target'>;

const planLink = (link: string, target: string): PlannedLink => {
  const ancestor = existingDirAbove(link);
  if (linkAction(link, target) !== 'kept') {
    onDisk(ancestor, () => {
      accessSync(ancestor, constants.W_OK);
    });
  }
  return { path: link, target };
};

/** Makes `link`. When a second `setup`, from a window that starts at the same time, made the same link first, the link is `kept`. */
const makeLink = (link: SetupLink): SetupLink => {
  try {
    symlinkSync(link.target, link.path);
    return link;
  } catch (error) {
    // SAFETY: `symlinkSync` throws a Node error, which has an optional string `code`.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && lstatSync(link.path).isSymbolicLink() && readlinkSync(link.path) === link.target) {
      return { ...link, action: 'kept' };
    }
    throw error;
  }
};

/** Checks the link again, then makes or replaces it. */
const applyLink = (planned: PlannedLink): SetupLink => {
  const link: SetupLink = { ...planned, action: linkAction(planned.path, planned.target) };
  if (link.action === 'kept') {
    return link;
  }
  return onDisk(link.path, () => {
    if (link.action === 'replaced') {
      unlinkSync(link.path);
    }
    mkdirSync(path.dirname(link.path), { recursive: true });
    return makeLink(link);
  });
};

/** Only migrates links to the bundled skill of a tern-worktrees package. */
const legacyLink = (home: string): PlannedLink | null => {
  const link = path.join(home, '.omp', 'agent', 'skills', PACKAGE_NAME);
  try {
    if (!lstatSync(link).isSymbolicLink()) {
      return null;
    }
    const target = readlinkSync(link);
    const resolved = path.resolve(path.dirname(link), target);
    if (path.basename(resolved) !== PACKAGE_NAME || path.basename(path.dirname(resolved)) !== 'skills') {
      return null;
    }
    const manifest: unknown = JSON.parse(readFileSync(path.join(resolved, '..', '..', 'package.json'), 'utf-8'));
    return isJsonObject(manifest) && 'name' in manifest && manifest.name === PACKAGE_NAME ? { path: link, target } : null;
  } catch {
    return null;
  }
};

/**
 * `setup`: links `~/.local/bin/tern-wt` to the CLI and `~/.agents/skills/tern-worktrees` to the skill of the package that it runs from.
 * It checks each link and its parent directories before it changes anything, so a `path_conflict` keeps the machine as it was. A second run changes nothing.
 */
export const run = (args: string[]): SetupResult => {
  parseArgs({ args, options: {} });
  const pkg = realpathSync(path.join(import.meta.dirname, '..', '..'));
  const home = userHome();
  const links = [
    planLink(path.join(home, '.local', 'bin', 'tern-wt'), path.join(pkg, 'bin', 'tern-wt')),
    planLink(path.join(home, '.agents', 'skills', PACKAGE_NAME), path.join(pkg, 'skills', PACKAGE_NAME)),
  ];
  const legacy = legacyLink(home);
  if (legacy) {
    onDisk(path.dirname(legacy.path), () => {
      accessSync(path.dirname(legacy.path), constants.W_OK);
    });
  }
  const applied = links.map(applyLink);
  if (legacy && legacyLink(home)?.target === legacy.target) {
    onDisk(legacy.path, () => {
      unlinkSync(legacy.path);
    });
    applied.push({ ...legacy, action: 'removed' });
  }
  return { links: applied };
};
