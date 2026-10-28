import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isUnder } from './paths.ts';
import { gitMust, submodules } from './git.ts';
import { must } from './proc.ts';

/** The immutable identity and optional checkout whose work must survive a force delete. */
export interface RecoveryTarget {
  repo: string;
  branch: string | null;
  head: string;
  worktree: string | null;
}

const recoveredWork = new Map<string, string>();

const hashFile = (hash: Hash, root: string, file: string): void => {
  const absolute = path.join(root, file);
  const stat = lstatSync(absolute);
  hash.update(JSON.stringify([file, stat.mode]));
  if (stat.isSymbolicLink()) {
    hash.update(readlinkSync(absolute));
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`cannot recover non-regular file: ${absolute}`);
  }
  const fd = openSync(absolute, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer);
      if (count === 0) {
        break;
      }
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
};

const workSignature = async (dir: string): Promise<string> => {
  const hash = createHash('sha256');
  const subs = await submodules(dir);
  for (const checkout of ['', ...subs]) {
    const root = path.join(dir, checkout);
    // eslint-disable-next-line no-await-in-loop
    const head = await gitMust(root, 'rev-parse', 'HEAD');
    // eslint-disable-next-line no-await-in-loop
    const patch = await gitMust(root, 'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--');
    hash.update(JSON.stringify([checkout, head, patch]));
    // eslint-disable-next-line no-await-in-loop
    const untracked = await gitMust(root, 'ls-files', '--others', '--exclude-standard', '-z');
    for (const file of untracked.split('\0').filter(Boolean)) {
      hashFile(hash, root, file);
    }
  }
  return hash.digest('hex');
};

/** Refuses force delete when work changed after its durable copy. */
export const guardCleanRecovery = async (dir: string, recovery: string): Promise<void> => {
  if ((await workSignature(dir)) !== recoveredWork.get(recovery)) {
    throw new Error('worktree changed after recovery');
  }
};

const syncPath = (file: string): void => {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const syncTree = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      syncTree(file);
    } else {
      syncPath(file);
    }
  }
  syncPath(dir);
};

const saveCheckout = async (dir: string, destination: string, revision: string, checkout: boolean, branches = false): Promise<void> => {
  mkdirSync(destination, { mode: 0o700, recursive: true });
  if (checkout) {
    await gitMust(dir, 'diff', '--binary', '--no-ext-diff', '--no-textconv', `--output=${path.join(destination, 'changes.patch')}`, 'HEAD', '--');
    const untracked = await gitMust(dir, 'ls-files', '--others', '--exclude-standard', '-z');
    const list = path.join(destination, 'untracked-files');
    writeFileSync(list, untracked, { mode: 0o600 });
    await must(['tar', '-cf', path.join(destination, 'untracked.tar'), '-C', dir, '--null', '-T', list], 'git_failed');
  }
  const local = await gitMust(dir, 'rev-list', revision, ...(branches ? ['--branches'] : []), '--not', '--remotes');
  if (local.trim() !== '') {
    await gitMust(dir, 'bundle', 'create', path.join(destination, 'commits.bundle'), revision, ...(branches ? ['--branches'] : []), '--not', '--remotes');
  }
};

const saveSubmodules = async (dir: string, destination: string): Promise<{ path: string; head: string }[]> => {
  const modules: { path: string; head: string }[] = [];
  const subs = await submodules(dir);
  for (const [index, sub] of subs.entries()) {
    const subDir = path.join(dir, sub);
    // eslint-disable-next-line no-await-in-loop
    const head = await gitMust(subDir, 'rev-parse', 'HEAD');
    // eslint-disable-next-line no-await-in-loop
    await saveCheckout(subDir, path.join(destination, 'submodules', String(index)), 'HEAD', true, true);
    modules.push({ head: head.trim(), path: sub });
  }
  return modules;
};

const syncParents = (timestamp: string, state: string): void => {
  let parent = timestamp;
  for (;;) {
    syncPath(parent);
    if (parent === state || path.dirname(parent) === parent) {
      return;
    }
    parent = path.dirname(parent);
  }
};

interface RecoveryLocation {
  state: string;
  timestamp: string;
  destination: string;
}

const recoveryDestination = (target: RecoveryTarget): RecoveryLocation => {
  const configured = process.env.XDG_STATE_HOME;
  const state = configured === undefined || configured === '' ? path.join(homedir(), '.local', 'state') : configured;
  const root = path.join(state, 'tern-wt', 'recovery');
  if (target.worktree !== null && isUnder(root, target.worktree)) {
    throw new Error('recovery directory must be outside the removed worktree');
  }
  const timestamp = path.join(root, new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(timestamp, { mode: 0o700, recursive: true });
  const slug = (target.branch ?? path.basename(target.worktree ?? target.repo)).replaceAll(/[^a-zA-Z0-9._-]/gu, '-').slice(0, 100);
  const destination = mkdtempSync(path.join(timestamp, `${slug}-`));
  return { destination, state, timestamp };
};

/** Saves patches, new files and local-only commits durably before resource or worktree removal. */
export const recoverCleanTarget = async (target: RecoveryTarget): Promise<string> => {
  const { destination, state, timestamp } = recoveryDestination(target);
  const dir = target.worktree ?? target.repo;
  const revision = target.worktree === null && target.branch !== null ? `refs/heads/${target.branch}` : 'HEAD';
  const head = await gitMust(dir, 'rev-parse', revision);
  if (head.trim() !== target.head) {
    throw new Error('HEAD changed before recovery');
  }
  const signature = target.worktree === null ? null : await workSignature(dir);
  await saveCheckout(dir, destination, revision, target.worktree !== null);
  const modules = target.worktree === null ? [] : await saveSubmodules(dir, destination);
  writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify({ ...target, submodules: modules }, null, 2)}\n`, { mode: 0o600 });
  syncTree(destination);
  syncParents(timestamp, state);
  const finalHead = await gitMust(dir, 'rev-parse', revision);
  const finalSignature = signature === null ? null : await workSignature(dir);
  if (finalHead.trim() !== target.head || finalSignature !== signature) {
    throw new Error('worktree changed during recovery');
  }
  if (signature !== null) {
    recoveredWork.set(destination, signature);
  }
  return destination;
};
