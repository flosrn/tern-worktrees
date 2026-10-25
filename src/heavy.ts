import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as pollDelay } from 'node:timers/promises';
import { isJsonObject, isString } from './json.ts';
import { pluginData } from './paths.ts';

const GIB = 1024 ** 3;

/** The process holding a host-wide heavy slot. */
export interface HeavyOwner {
  pid: number;
  cwd: string;
  command: string[];
  startedAt: string;
}

/** The heavy slots and physical memory reported by the host. */
export interface HeavyStatus {
  slots: (({ slot: number; busy: true } & HeavyOwner) | { slot: number; busy: false; pid: null; cwd: null; command: null; startedAt: null })[];
  memAvailableGb: number;
  memTotalGb: number;
}

/** The sizing policy of host-wide heavy slots. */
export interface HeavyOptions {
  slotMemoryGb?: number;
  totalBytes?: number;
}

const slotCount = (options: HeavyOptions): number => Math.max(1, Math.floor((options.totalBytes ?? totalmem()) / GIB / (options.slotMemoryGb ?? 7)));
const slotPath = (slot: number): string => path.join(pluginData(), 'heavy', `slot-${slot}.lock`);
// Filesystem and process errors carry string codes only on Error objects.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) {
      return false;
    }
    if (hasCode(error, 'EPERM')) {
      return true;
    }
    throw error;
  }
};

const parseOwner = (bytes: string): HeavyOwner | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (!isJsonObject(raw)) {
    return null;
  }
  const fields: { pid?: unknown; cwd?: unknown; command?: unknown; startedAt?: unknown } = raw;
  if (!Number.isInteger(fields.pid)) {
    return null;
  }
  // SAFETY: Number.isInteger accepts only numbers, without coercion.
  const pid = fields.pid as number;
  if (pid < 1) {
    return null;
  }
  if (!isString(fields.cwd) || !isString(fields.startedAt)) {
    return null;
  }
  if (!Array.isArray(fields.command) || !fields.command.every(isString)) {
    return null;
  }
  return { command: fields.command, cwd: fields.cwd, pid, startedAt: fields.startedAt };
};

const readOwner = (file: string): HeavyOwner | null => {
  try {
    return parseOwner(readFileSync(file).toString());
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
};

/** Reads slot ownership without changing live or stale locks. */
export const heavyStatus = (options: HeavyOptions = {}): HeavyStatus => ({
  memAvailableGb: freemem() / GIB,
  memTotalGb: (options.totalBytes ?? totalmem()) / GIB,
  slots: Array.from({ length: slotCount(options) }, (_, index) => {
    const slot = index + 1;
    const owner = readOwner(slotPath(slot));
    return owner !== null && alive(owner.pid) ? { ...owner, busy: true, slot } : { busy: false, command: null, cwd: null, pid: null, slot, startedAt: null };
  }),
});

const releaseOwnedSlot = (file: string, inode: number, bytes: string): (() => void) => {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (statSync(file).ino === inode && readFileSync(file, 'utf-8') === bytes) {
        unlinkSync(file);
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        throw error;
      }
    }
  };
};

const tryAcquireSlot = (file: string, owner: HeavyOwner): (() => void) | null => {
  const staging = path.join(path.dirname(file), `owner-${process.pid}-${randomUUID()}`);
  const bytes = JSON.stringify(owner);
  writeFileSync(staging, bytes, { flag: 'wx', mode: 0o600 });
  try {
    // Publish complete ownership bytes with exclusive creation of the lock name.
    linkSync(staging, file);
    return releaseOwnedSlot(file, statSync(file).ino, bytes);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw error;
    }
  } finally {
    unlinkSync(staging);
  }
  return null;
};

const reclaimDeadSlot = (file: string, claimant: HeavyOwner): boolean => {
  let bytes: string;
  try {
    bytes = readFileSync(file, 'utf-8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return true;
    }
    throw error;
  }
  const owner = parseOwner(bytes);
  if (owner !== null && alive(owner.pid)) {
    return false;
  }
  const key = createHash('sha256').update(`${file}:${bytes}`).digest('hex');
  const claim = path.join(pluginData(), 'heavy', `reclaim-${key}.lock`);
  let release = tryAcquireSlot(claim, claimant);
  if (release === null && reclaimDeadSlot(claim, claimant)) {
    release = tryAcquireSlot(claim, claimant);
  }
  if (release === null) {
    return false;
  }
  try {
    // Only the exclusive claimant can remove this dead owner's slot.
    if (readFileSync(file, 'utf-8') === bytes) {
      unlinkSync(file);
    }
    return true;
  } finally {
    release();
  }
};

/** Waits for a host-wide slot. The returned release is safe to call more than once. */
export const acquireHeavySlot = async (command: string[], options: HeavyOptions & { cwd?: string; signal?: AbortSignal } = {}): Promise<() => void> => {
  mkdirSync(path.join(pluginData(), 'heavy'), { recursive: true });
  let announced = false;
  while (true) {
    options.signal?.throwIfAborted();
    const owner: HeavyOwner = { command, cwd: options.cwd ?? process.cwd(), pid: process.pid, startedAt: new Date().toISOString() };
    for (let slot = 1; slot <= slotCount(options); slot += 1) {
      const file = slotPath(slot);
      const release = tryAcquireSlot(file, owner);
      if (release !== null) {
        return release;
      }
      if (reclaimDeadSlot(file, owner)) {
        slot -= 1;
      }
    }
    if (!announced) {
      process.stderr.write(`tern-wt: all ${slotCount(options)} heavy slots are busy; waiting\n`);
      announced = true;
    }
    // Poll sequentially at five-second intervals while the host is busy.
    // oxlint-disable-next-line no-await-in-loop
    await pollDelay(5000, undefined, { signal: options.signal });
  }
};
