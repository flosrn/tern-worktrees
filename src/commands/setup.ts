import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isJsonObject } from '../json.ts';
import { ompAgentDir, userHome } from '../paths.ts';
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
const PACKAGE_MANIFEST = 'package.json';

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

/** Proves that a previous extension target belongs to a different installation of this package, not merely the same link name. */
const bundledOmp = (target: string): boolean => {
  if (path.basename(target) !== 'omp') {
    return false;
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(target, PACKAGE_MANIFEST), 'utf-8'));
    const parent: unknown = JSON.parse(readFileSync(path.join(target, '..', PACKAGE_MANIFEST), 'utf-8'));
    if (!isJsonObject(manifest) || !('name' in manifest) || !isJsonObject(parent) || !('name' in parent)) {
      return false;
    }
    return manifest.name === 'tern-worktrees-omp' && parent.name === PACKAGE_NAME;
  } catch {
    return false;
  }
};

const linkAction = (link: string, target: string, omp: boolean): LinkAction => {
  const stat = onDisk(link, () => lstatSync(link, { throwIfNoEntry: false }));
  if (!stat) {
    return 'created';
  }
  if (!stat.isSymbolicLink()) {
    throw conflict(link, 'exists and is not a symbolic link');
  }
  const previous = onDisk(link, () => readlinkSync(link));
  const resolved = path.resolve(path.dirname(link), previous);
  if (previous === target || (omp && resolved === target)) {
    return 'kept';
  }
  if (omp && !bundledOmp(resolved)) {
    throw conflict(link, 'does not point to the bundled OMP extension');
  }
  return 'replaced';
};

type PlannedLink = Pick<SetupLink, 'path' | 'target'> & { omp: boolean };

const planLink = (link: string, target: string, omp = false): PlannedLink => {
  const ancestor = existingDirAbove(link);
  if (linkAction(link, target, omp) !== 'kept') {
    onDisk(ancestor, () => {
      accessSync(ancestor, constants.W_OK);
    });
  }
  return { omp, path: link, target };
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
  const link: SetupLink = { action: linkAction(planned.path, planned.target, planned.omp), path: planned.path, target: planned.target };
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
const legacyLink = (home: string): Pick<SetupLink, 'path' | 'target'> | null => {
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
    const manifest: unknown = JSON.parse(readFileSync(path.join(resolved, '..', '..', PACKAGE_MANIFEST), 'utf-8'));
    return isJsonObject(manifest) && 'name' in manifest && manifest.name === PACKAGE_NAME ? { path: link, target } : null;
  } catch {
    return null;
  }
};

/** Includes the active agent, the default agent and real profiles, without inventing profiles or following profile links. */
const ompAgentDirs = (home: string): string[] => {
  const from = { env: process.env, exists: existsSync, home, platform: process.platform };
  const defaultEnv = { ...process.env, OMP_PROFILE: '', PI_CODING_AGENT_DIR: '', PI_PROFILE: '' };
  const defaultAgent = ompAgentDir({ ...from, env: defaultEnv });
  const agents = new Set([defaultAgent, ompAgentDir(from)]);
  const profiles = path.join(defaultAgent, '..', 'profiles');
  if (onDisk(profiles, () => lstatSync(profiles, { throwIfNoEntry: false }))?.isDirectory() === true) {
    const entries = onDisk(profiles, () => readdirSync(profiles, { withFileTypes: true }));
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agent = ompAgentDir({ ...from, env: { ...defaultEnv, OMP_PROFILE: entry.name } });
      if (agent === path.join(profiles, entry.name, 'agent')) {
        agents.add(agent);
      }
    }
  }
  return [...agents];
};

/**
 * `setup`: links the CLI, the skill and the omp extension of this package. Native extension links cover the default agent, the active agent and real profiles.
 * It checks each link and its parent directories before it changes anything, so a `path_conflict` keeps the machine as it was. A second run changes nothing.
 */
export const run = (args: string[]): SetupResult => {
  parseArgs({ args, options: {} });
  const pkg = realpathSync(path.join(import.meta.dirname, '..', '..'));
  const home = userHome();
  const links = [
    planLink(path.join(home, '.local', 'bin', 'tern-wt'), path.join(pkg, 'bin', 'tern-wt')),
    planLink(path.join(home, '.agents', 'skills', PACKAGE_NAME), path.join(pkg, 'skills', PACKAGE_NAME)),
    ...ompAgentDirs(home).map(agent => planLink(path.join(agent, 'extensions', 'tern-worktrees-omp'), path.join(pkg, 'omp'), true)),
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
