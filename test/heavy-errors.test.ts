// Filesystem boundary spies must intercept the module used by the code.
// oxlint-disable-next-line sonarjs/no-wildcard-import
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { acquireHeavySlot, heavyStatus } from '../src/heavy.ts';
import { useSandbox } from './helpers.ts';

vi.mock(import('node:fs'), { spy: true });

const GIB = 1024 ** 3;

describe('heavy operating-system failures', () => {
  beforeEach(() => {
    useSandbox();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.linkSync).mockReset();
    vi.mocked(fs.unlinkSync).mockReset();
  });

  it('keeps a slot busy when permission checks deny access to its owner', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    try {
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['owner'] });
    } finally {
      release();
    }
  });

  it('propagates an unexpected process inspection error', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('inspection failed'), { code: 'EINVAL' });
    });
    try {
      expect(() => heavyStatus({ totalBytes: GIB })).toThrow('inspection failed');
    } finally {
      release();
    }
  });

  it('does not report unreadable ownership as an available slot', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('unreadable owner'), { code: 'EACCES' });
    });
    expect(() => heavyStatus({ totalBytes: GIB })).toThrow('unreadable owner');
  });

  it('reports publication failure and removes its temporary owner file', async () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('publication failed'), { code: 'EIO' });
    });
    await expect(acquireHeavySlot(['owner'], { totalBytes: GIB })).rejects.toThrow('publication failed');
    expect(fs.readdirSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy'))).toStrictEqual([]);
  });

  it('propagates release failures rather than claiming successful release', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('release failed'), { code: 'EACCES' });
    });
    expect(release).toThrow('release failed');
    unlink.mockRestore();
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true });
  });

  it('does not bypass a live reclamation claim', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    const bytes = JSON.stringify({ command: ['dead'], cwd: '/', pid: 2_147_483_647, startedAt: 'old' });
    fs.writeFileSync(file, bytes);
    const key = createHash('sha256').update(`${file}:${bytes}`).digest('hex');
    fs.writeFileSync(path.join(directory, `reclaim-${key}.lock`), JSON.stringify({ command: ['reclaim'], cwd: '/', pid: process.pid, startedAt: 'now' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cancellation = new AbortController();
    const pending = acquireHeavySlot(['waiting'], { signal: cancellation.signal, totalBytes: GIB });
    cancellation.abort('SIGINT');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(bytes);
    expect(stderr).toHaveBeenCalledExactlyOnceWith('tern-wt: all 1 heavy slots are busy; waiting\n');
  });

  it('preserves ownership replaced while a stale recovery claim is published', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    fs.writeFileSync(file, JSON.stringify({ command: ['dead'], cwd: '/', pid: 2_147_483_647, startedAt: 'old' }));
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.linkSync).mockImplementation((source, destination) => {
      actual.linkSync(source, destination);
      if (String(destination).includes('reclaim-')) {
        fs.writeFileSync(file, JSON.stringify({ command: ['replacement'], cwd: '/', pid: process.pid, startedAt: 'new' }));
      }
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cancellation = new AbortController();
    const pending = acquireHeavySlot(['waiting'], { signal: cancellation.signal, totalBytes: GIB });
    cancellation.abort('SIGINT');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
  });
});
