import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CliOutput } from '../src/cli-output.ts';
import { run } from '../src/commands/heavy.ts';
import { acquireHeavySlot, heavyStatus } from '../src/heavy.ts';
import { runInherited } from '../src/proc.ts';
import { tempDir, tmpRepo, useSandbox } from './helpers.ts';

const GIB = 1024 ** 3;

describe('host-wide heavy slots', () => {
  beforeEach(() => {
    useSandbox();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sizes slots from total physical GiB, rounds down, and keeps at least one', () => {
    expect(heavyStatus({ totalBytes: 32 * GIB }).slots).toHaveLength(4);
    expect(heavyStatus({ slotMemoryGb: 10, totalBytes: 32 * GIB }).slots).toHaveLength(3);
    expect(heavyStatus({ totalBytes: 2 * GIB }).slots).toStrictEqual([{ busy: false, command: null, cwd: null, pid: null, slot: 1, startedAt: null }]);
  });

  it('makes ownership visible and releases only the slot it acquired', async () => {
    const options = { totalBytes: 14 * GIB };
    const releaseFirst = await acquireHeavySlot(['build', '--release'], options);
    const releaseSecond = await acquireHeavySlot(['test'], options);
    try {
      expect(heavyStatus(options).slots).toMatchObject([
        { busy: true, command: ['build', '--release'], cwd: process.cwd(), pid: process.pid, slot: 1 },
        { busy: true, command: ['test'], slot: 2 },
      ]);
      releaseFirst();
      releaseFirst();
      expect(heavyStatus(options).slots.map(slot => slot.busy)).toStrictEqual([false, true]);
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });

  it('announces waiting once, polls every five seconds, and proceeds when a slot is released', async () => {
    // This integration test exercises the native promise timer, external to fake-timer control.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const options = { totalBytes: GIB };
    const releaseFirst = await acquireHeavySlot(['first'], options);
    let acquired = false;
    const waiting = (async () => {
      const release = await acquireHeavySlot(['second'], options);
      acquired = true;
      return release;
    })();
    try {
      await delay(5000);
      expect(acquired).toBeFalsy();
      expect(stderr).toHaveBeenCalledExactlyOnceWith('tern-wt: all 1 heavy slots are busy; waiting\n');
      releaseFirst();
      expect(acquired).toBeFalsy();
      const releaseSecond = await waiting;
      expect(acquired).toBeTruthy();
      expect(heavyStatus(options).slots[0]).toMatchObject({ busy: true, command: ['second'] });
      releaseSecond();
    } finally {
      releaseFirst();
    }
  }, 15_000);

  it('reclaims a lock whose owning process has exited', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    expect(dead.status).toBe(0);
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'slot-1.lock'), JSON.stringify({ command: ['old'], cwd: '/old', pid: dead.pid, startedAt: '2020-01-01T00:00:00Z' }));
    const release = await acquireHeavySlot(['replacement'], { totalBytes: GIB });
    try {
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'], pid: process.pid });
    } finally {
      release();
    }
  });

  it('cancels a waiter without taking or releasing the occupied slot', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const options = { totalBytes: GIB };
    const release = await acquireHeavySlot(['owner'], options);
    const cancellation = new AbortController();
    const waiting = acquireHeavySlot(['waiter'], { ...options, signal: cancellation.signal });
    cancellation.abort('SIGINT');
    try {
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      expect(heavyStatus(options).slots[0]).toMatchObject({ busy: true, command: ['owner'] });
    } finally {
      release();
    }
  });

  it.each([
    'null',
    '{}',
    '{"pid":"1"}',
    '{"pid":0}',
    '{"pid":1.5}',
    '{"pid":1,"cwd":2}',
    '{"pid":1,"cwd":"/","startedAt":2}',
    '{"pid":1,"cwd":"/","startedAt":"now","command":2}',
    '{"pid":1,"cwd":"/","startedAt":"now","command":[2]}',
    'not json',
  ])('replaces invalid lock metadata before running a new owner: %s', async bytes => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'slot-1.lock'), bytes);
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: false });
    const release = await acquireHeavySlot(['replacement'], { totalBytes: GIB });
    try {
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
    } finally {
      release();
    }
  });

  it('does not remove a replacement lock when an earlier owner releases', async () => {
    const release = await acquireHeavySlot(['old'], { totalBytes: GIB });
    const file = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy', 'slot-1.lock');
    writeFileSync(file, JSON.stringify({ command: ['replacement'], cwd: '/', pid: process.pid, startedAt: 'now' }));
    release();
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
  });

  it('allows release after the lock file disappears', async () => {
    const release = await acquireHeavySlot(['old'], { totalBytes: GIB });
    unlinkSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy', 'slot-1.lock'));
    release();
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: false });
  });

  it('recovers a dead reclaimer before taking its stale slot', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    const owner = { command: ['old'], cwd: '/', pid: dead.pid, startedAt: 'old' };
    const bytes = JSON.stringify(owner);
    writeFileSync(file, bytes);
    const key = createHash('sha256').update(`${file}:${bytes}`).digest('hex');
    writeFileSync(path.join(directory, `reclaim-${key}.lock`), bytes);
    const release = await acquireHeavySlot(['replacement'], { totalBytes: GIB });
    try {
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
    } finally {
      release();
    }
  });
});

describe('heavy command', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('forwards the child exit code and releases its host slot', async () => {
    const repo = await tmpRepo();
    await expect(run(['--repo', repo.dir, '--', process.execPath, '-e', 'process.exit(23)'])).resolves.toStrictEqual(new CliOutput(23));
    expect(heavyStatus().slots.every(slot => !slot.busy)).toBeTruthy();
  });

  it('runs in the current directory with inherited and configured environment', async () => {
    const repo = await tmpRepo();
    mkdirSync(path.join(repo.dir, '.tern'));
    writeFileSync(path.join(repo.dir, '.tern', 'worktree.json'), JSON.stringify({ env: { HEAVY_TEST_VALUE: 'from-config' } }));
    const output = path.join(tempDir('heavy-output'), 'result.json');
    const script =
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({cwd:process.cwd(),value:process.env.HEAVY_TEST_VALUE,inherited:process.env.HEAVY_INHERITED}))";
    vi.stubEnv('HEAVY_INHERITED', 'from-parent');
    await run(['--repo', repo.dir, '--', process.execPath, '-e', script, output]);
    expect(JSON.parse(readFileSync(output, 'utf-8'))).toStrictEqual({ cwd: process.cwd(), inherited: 'from-parent', value: 'from-config' });
  });

  it('uses the current worktree when --repo is absent', async () => {
    const repo = await tmpRepo();
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo.dir);
    try {
      const result = await run(['--status']);
      expect(result).not.toBeInstanceOf(CliOutput);
    } finally {
      cwd.mockRestore();
    }
  });

  it('reports slots and host RAM as JSON data without executing a child', async () => {
    const repo = await tmpRepo();
    const result = await run(['--status', '--repo', repo.dir]);
    expect(result).not.toBeInstanceOf(CliOutput);
    if (result instanceof CliOutput) {
      throw new TypeError('Expected host slot status');
    }
    expect(result.memTotalGb).toBeGreaterThan(0);
    expect(result.memAvailableGb).toBeGreaterThanOrEqual(0);
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it('rejects a missing command and a status request mixed with a command', async () => {
    await expect(run([])).rejects.toMatchObject({ code: 'bad_args' });
    await expect(run(['--status', '--', 'echo'])).rejects.toMatchObject({ code: 'bad_args' });
  });

  it.each([
    { code: 130, signal: 'SIGINT' },
    { code: 143, signal: 'SIGTERM' },
    { code: 129, signal: 'SIGHUP' },
  ] as const)('forwards $signal and releases the slot after the child stops', async ({ signal, code }) => {
    const repo = await tmpRepo();
    const ready = path.join(tempDir('heavy-ready'), 'ready');
    const script = "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)";
    const execution = run(['--repo', repo.dir, '--', process.execPath, '-e', script, ready]);
    while (!existsSync(ready)) {
      // Wait for the command to start before sending its signal.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    process.emit(signal);
    process.emit(signal);
    await expect(execution).resolves.toStrictEqual(new CliOutput(code));
    expect(heavyStatus().slots.every(slot => !slot.busy)).toBeTruthy();
  });

  it('propagates a service failure without starting the requested child', async () => {
    const repo = await tmpRepo();
    mkdirSync(path.join(repo.dir, '.tern'));
    writeFileSync(path.join(repo.dir, '.tern', 'worktree.json'), JSON.stringify({ services: { db: { containerPort: 5432, image: 'postgres:17', port: 5433 } } }));
    const bin = tempDir('heavy-docker');
    writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const output = path.join(bin, 'child');
    await expect(run(['--repo', repo.dir, '--', 'sh', '-c', `touch '${output}'`])).rejects.toMatchObject({ code: 'service_failed' });
    expect(existsSync(output)).toBeFalsy();
  });

  it.each([
    { code: 130, signal: 'SIGINT' },
    { code: 143, signal: 'SIGTERM' },
    { code: 129, signal: 'SIGHUP' },
  ] as const)('cancels a waiting command on $signal without releasing another owner', async ({ signal, code }) => {
    const repo = await tmpRepo();
    mkdirSync(path.join(repo.dir, '.tern'));
    writeFileSync(path.join(repo.dir, '.tern', 'worktree.json'), JSON.stringify({ heavy: { slotMemoryGb: 1_000_000 } }));
    const release = await acquireHeavySlot(['occupied'], { totalBytes: GIB });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const execution = run(['--repo', repo.dir, '--', process.execPath, '-e', 'process.exit(99)']);
    try {
      await vi.waitFor(() => {
        expect(stderr).toHaveBeenCalledWith('tern-wt: all 1 heavy slots are busy; waiting\n');
      });
      process.emit(signal);
      await expect(execution).resolves.toStrictEqual(new CliOutput(code));
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['occupied'] });
    } finally {
      release();
      stderr.mockRestore();
    }
  });

  it('releases its active slot when the process emits exit', async () => {
    const repo = await tmpRepo();
    const ready = path.join(tempDir('heavy-exit'), 'ready');
    const execution = run(['--repo', repo.dir, '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {},1000)", ready]);
    while (!existsSync(ready)) {
      // Wait for real process readiness before exercising the exit event.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    process.emit('exit', 0);
    expect(heavyStatus().slots.every(slot => !slot.busy)).toBeTruthy();
    process.emit('SIGTERM');
    await expect(execution).resolves.toStrictEqual(new CliOutput(143));
  });
});

describe('inherited command execution', () => {
  it('forwards signal-derived exit status', async () => {
    await expect(runInherited([process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"])).resolves.toBe(143);
    await expect(runInherited([process.execPath, '-e', "process.kill(process.pid, 'SIGINT')"])).resolves.toBe(130);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops a process and its descendants on %s', async signal => {
    const output = path.join(tempDir('heavy-descendant'), 'done');
    const ready = `${output}.ready`;
    const cancellation = new AbortController();
    const descendant = "require('node:fs').writeFileSync(process.argv[2], 'ready'); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 1000)";
    const script =
      "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], {stdio:'inherit'}); setInterval(() => {},1000)";
    const execution = runInherited([process.execPath, '-e', script, descendant, output, ready], { signal: cancellation.signal });
    while (!existsSync(ready)) {
      // Wait for the real child to publish readiness before cancellation.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    cancellation.abort(signal);
    await expect(execution).resolves.toBe(signal === 'SIGINT' ? 130 : 143);
    await delay(1200);
    expect(existsSync(output)).toBeFalsy();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('forwards a %s that arrives twice to the child group', async (signal, exitCode) => {
    const output = path.join(tempDir('heavy-repeat'), signal);
    const ready = `${output}.ready`;
    const cancellation = new AbortController();
    const script = "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {},1000)";
    const execution = runInherited([process.execPath, '-e', script, ready], { signal: cancellation.signal });
    while (!existsSync(ready)) {
      // Wait for real process readiness before sending the signals.
      // oxlint-disable-next-line no-await-in-loop
      await delay(10);
    }
    process.emit(signal);
    process.emit(signal);
    cancellation.abort(signal);
    await expect(execution).resolves.toBe(exitCode);
    expect(existsSync(output)).toBeFalsy();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('does not spawn after %s cancellation', async signal => {
    const output = path.join(tempDir('heavy-cancel'), 'spawned');
    const cancellation = new AbortController();
    cancellation.abort(signal);
    await expect(runInherited(['sh', '-c', `touch '${output}'`], { signal: cancellation.signal })).resolves.toBe(signal === 'SIGINT' ? 130 : 143);
    expect(existsSync(output)).toBeFalsy();
  });

  it('reports an unavailable executable as exit 127', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(runInherited([path.join(tempDir('heavy-missing'), 'missing')])).resolves.toBe(127);
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it('handles cancellation immediately after an executable fails to spawn', async () => {
    const cancellation = new AbortController();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const execution = runInherited([path.join(tempDir('heavy-no-pid'), 'missing')], { signal: cancellation.signal });
      cancellation.abort('SIGTERM');
      await expect(execution).resolves.toBe(127);
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it('reports a child stopped by a different signal as exit one', async () => {
    await expect(runInherited([process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"])).resolves.toBe(1);
  });
});
