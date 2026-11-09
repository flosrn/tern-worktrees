import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { MakeDirectoryOptions, Mode, OpenMode, PathLike } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { finishDirectory, lockFinish, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { tempDir, useSandbox } from './helpers.ts';

const native = vi.hoisted(() => ({ afterMkdir: (_file: string): void => {}, beforeOpen: (_file: string): void => {} }));

vi.mock(import('node:fs'), async importOriginal => {
  const fs = await importOriginal();
  function mkdir(file: PathLike, options: MakeDirectoryOptions & { recursive: true }): string | undefined;
  function mkdir(file: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: false | undefined }) | null): void;
  function mkdir(file: PathLike, options?: MakeDirectoryOptions | Mode | null): string | undefined;
  function mkdir(file: PathLike, options?: MakeDirectoryOptions | Mode | null): string | undefined {
    const result = fs.mkdirSync(file, options);
    native.afterMkdir(String(file));
    return result;
  }
  return {
    ...fs,
    mkdirSync: mkdir,
    openSync: (file: PathLike, flags: OpenMode, mode?: Mode | null): number => {
      native.beforeOpen(String(file));
      return fs.openSync(file, flags, mode);
    },
  };
});

const planId = 'a'.repeat(48);

const durablePlan = (): StoredFinish => {
  const repo = tempDir('finish-private-store');
  return {
    caller: { block: null, identity: null, pid: null, session: null },
    candidates: [],
    current: null,
    errors: [],
    excluded: [],
    id: planId,
    identities: { [repo]: { dev: 1, ino: 2 } },
    inFlight: null,
    keep: [],
    notified: false,
    owned: [],
    ready: true,
    removed: [],
    repo,
    selected: [],
    status: 'planned',
    version: 2,
    warnings: [],
  };
};

describe('finish storage native security boundaries', () => {
  beforeEach(() => {
    native.afterMkdir = (): void => {};
    native.beforeOpen = (): void => {};
    useSandbox();
  });

  afterEach(() => {
    native.afterMkdir = (): void => {};
    native.beforeOpen = (): void => {};
  });

  test.each([`x${planId}`, `${planId}x`, 'a'.repeat(47), 'a'.repeat(49)])('rejects the entire invalid plan id %s before opening storage', id => {
    const base = finishDirectory();
    expect(() => finishDirectory(id)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(() => readFinish(id)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(() => lockFinish(id)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(readdirSync(base)).toStrictEqual([]);
  });

  test.each(['public directory', 'symbolic link'] as const)('rejects an individual plan stored in a %s while the base stays private', kind => {
    const state = durablePlan();
    const base = finishDirectory();
    const directory = path.join(base, planId);
    const outside = tempDir('finish-plan-link');
    chmodSync(outside, 0o700);
    if (kind === 'public directory') {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o755);
    } else {
      symlinkSync(outside, directory);
    }
    expect(() => finishDirectory(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(() => {
      writeFinish(state);
    }).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(() => lockFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect({ baseMode: lstatSync(base).mode % 0o1000, outside: readdirSync(outside), plan: readdirSync(directory) }).toStrictEqual({ baseMode: 0o700, outside: [], plan: [] });
  });

  test('does not replace a private regular file occupying the plan directory', () => {
    const state = durablePlan();
    const directory = finishDirectory(planId);
    writeFileSync(directory, 'not a directory', { mode: 0o600 });
    expect(() => {
      writeFinish(state);
    }).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(() => lockFinish(planId)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(directory, 'utf-8')).toBe('not a directory');
  });

  test('rejects a directory replaced by a private file between mkdir and its native stat', () => {
    const base = finishDirectory();
    const directory = path.join(base, planId);
    mkdirSync(directory, { mode: 0o700 });
    native.afterMkdir = file => {
      if (file === directory) {
        native.afterMkdir = (): void => {};
        rmSync(directory, { recursive: true });
        writeFileSync(directory, 'concurrent replacement', { mode: 0o600 });
      }
    };
    expect(() => finishDirectory(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(readFileSync(directory, 'utf-8')).toBe('concurrent replacement');
    expect(lstatSync(base).mode % 0o1000).toBe(0o700);
  });

  test('round-trips private storage on hosts without getuid', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
    Reflect.deleteProperty(process, 'getuid');
    try {
      const state = durablePlan();
      expect(() => {
        writeFinish(state);
      }).not.toThrow();
      expect(readFinish(planId)).toStrictEqual(state);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(process, 'getuid');
      } else {
        Object.defineProperty(process, 'getuid', descriptor);
      }
    }
  });

  test('preserves the previous durable result and a pre-existing pending checkpoint', () => {
    const state = durablePlan();
    writeFinish(state);
    const pending = path.join(finishDirectory(planId), `state-${process.pid}.tmp`);
    writeFileSync(pending, 'uncommitted checkpoint', { mode: 0o600 });
    expect(() => {
      writeFinish({ ...state, warnings: ['A later result.'] });
    }).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFinish(planId)).toStrictEqual(state);
    expect(readFileSync(pending, 'utf-8')).toBe('uncommitted checkpoint');
  });

  test('publishes private checkpoints and leaves no pending file after replacement', () => {
    const state = durablePlan();
    writeFinish(state);
    const completed = { ...state, status: 'completed' } satisfies StoredFinish;
    writeFinish(completed);
    const directory = finishDirectory(planId);
    expect(readFinish(planId)).toStrictEqual(completed);
    expect(lstatSync(directory).mode % 0o1000).toBe(0o700);
    expect(lstatSync(path.join(directory, 'state.json')).mode % 0o1000).toBe(0o600);
    expect(readdirSync(directory)).toStrictEqual(['state.json']);
  });

  test('keeps the executor pid inspectable in a private lock until explicit release', () => {
    writeFinish(durablePlan());
    const lock = path.join(finishDirectory(planId), 'executor.lock');
    const release = lockFinish(planId);
    try {
      expect(release).toBeTypeOf('function');
      expect(readFileSync(lock, 'utf-8')).toBe(`${process.pid}\n`);
      expect(lstatSync(lock).mode % 0o1000).toBe(0o600);
      expect(lockFinish(planId)).toBeNull();
    } finally {
      release?.();
    }
    expect(existsSync(lock)).toBeFalsy();
  });

  test('does not retain open file descriptors after acquiring and releasing executor locks', () => {
    writeFinish(durablePlan());
    const before = readdirSync('/dev/fd').length;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const release = lockFinish(planId);
      expect(release).toBeTypeOf('function');
      release?.();
    }
    expect(readdirSync('/dev/fd')).toHaveLength(before);
  });

  test.each([null, 'native open failed', { code: 'EEXIST' }, new Error('native open failed')])('propagates a non-errno native lock failure unchanged: %j', failure => {
    writeFinish(durablePlan());
    const lock = path.join(finishDirectory(planId), 'executor.lock');
    native.beforeOpen = file => {
      if (file === lock) {
        // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error values at the native filesystem boundary.
        throw failure;
      }
    };
    let caught: unknown = Symbol('lock did not throw');
    try {
      lockFinish(planId)?.();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(existsSync(lock)).toBeFalsy();
  });
});
