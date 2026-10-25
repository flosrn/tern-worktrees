// Filesystem boundary spies must intercept the module used by the code.
// oxlint-disable-next-line sonarjs/no-wildcard-import
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { acquireHeavySlot, heavyStatus } from '../src/heavy.ts';
import { useSandbox } from './helpers.ts';

vi.mock(import('node:fs'), { spy: true });
vi.mock(import('node:crypto'), { spy: true });

const GIB = 1024 ** 3;

describe('filesystem ownership failures', () => {
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

  it('does not treat a non-Error filesystem absence as a missing slot', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      // eslint-disable-next-line eslint/no-throw-literal, @typescript-eslint/only-throw-error
      throw { code: 'ENOENT', message: 'plain absence' };
    });
    expect(() => heavyStatus({ totalBytes: GIB })).toThrow('plain absence');
  });

  it('propagates a filesystem failure whose code is not a string', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('numeric failure'), { code: 13 });
    });
    expect(() => heavyStatus({ totalBytes: GIB })).toThrow('numeric failure');
  });

  it('keeps init ownership busy', () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'slot-1.lock'), JSON.stringify({ command: ['init'], cwd: '/', pid: 1, startedAt: 'now' }));
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['init'], pid: 1 });
  });

  it('does not treat a non-Error process inspection failure as permission denied', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      // eslint-disable-next-line eslint/no-throw-literal, @typescript-eslint/only-throw-error
      throw { code: 'EPERM', message: 'plain denial' };
    });
    try {
      expect(() => heavyStatus({ totalBytes: GIB })).toThrow('plain denial');
    } finally {
      release();
    }
  });

  it('does not treat a missing code property as a filesystem absence', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('code missing');
    });
    expect(() => heavyStatus({ totalBytes: GIB })).toThrow('code missing');
  });

  it('does not treat a missing code property as a dead process', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('code missing');
    });
    try {
      expect(() => heavyStatus({ totalBytes: GIB })).toThrow('code missing');
    } finally {
      release();
    }
  });

  it('keeps the published owner when release sees the same bytes under another inode', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    const file = path.join(directory, 'slot-1.lock');
    const bytes = fs.readFileSync(file);
    const alias = path.join(directory, 'slot-1.alias');
    fs.linkSync(file, alias);
    fs.unlinkSync(file);
    fs.writeFileSync(file, bytes);
    release();
    expect(fs.readFileSync(file).equals(bytes)).toBeTruthy();
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['owner'] });
  });

  it('does not overwrite a staging file when its generated name already exists', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const uuid = '00000000-0000-4000-8000-000000000000';
    vi.mocked(randomUUID).mockReturnValue(uuid);
    const staging = path.join(directory, `owner-${process.pid}-${uuid}`);
    fs.writeFileSync(staging, 'existing staging owner');
    await expect(acquireHeavySlot(['owner'], { totalBytes: GIB })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(staging, 'utf-8')).toBe('existing staging owner');
    expect(fs.existsSync(path.join(directory, 'slot-1.lock'))).toBeFalsy();
  });

  it('reports publication failure and removes its temporary owner file', async () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('publication failed'), { code: 'EIO' });
    });
    await expect(acquireHeavySlot(['owner'], { totalBytes: GIB })).rejects.toThrow('publication failed');
    expect(fs.readdirSync(path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy'))).toStrictEqual([]);
  });

  it('leaves no staging file when exclusive publication finds the slot already taken', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    const bytes = JSON.stringify({ command: ['owner'], cwd: '/', pid: process.pid, startedAt: 'now' });
    fs.writeFileSync(file, bytes);
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.linkSync).mockImplementation((source, destination) => {
      if (String(destination) === file) {
        throw Object.assign(new Error('taken'), { code: 'EEXIST' });
      }
      actual.linkSync(source, destination);
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cancellation = new AbortController();
    const pending = acquireHeavySlot(['waiting'], { signal: cancellation.signal, totalBytes: GIB });
    cancellation.abort('SIGINT');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readdirSync(directory).filter(name => name.startsWith('owner-'))).toStrictEqual([]);
    expect(fs.readFileSync(file, 'utf-8')).toBe(bytes);
  });
});

describe('slot publication and recovery failures', () => {
  beforeEach(() => {
    useSandbox();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.linkSync).mockReset();
    vi.mocked(fs.unlinkSync).mockReset();
  });

  it('propagates release failures rather than claiming successful release', async () => {
    const release = await acquireHeavySlot(['owner'], { totalBytes: GIB });
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('release failed'), { code: 'EACCES' });
    });
    expect(release).toThrow('release failed');
    expect(release).not.toThrow();
    unlink.mockRestore();
    expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['owner'] });
  });

  it('reclaims a stale slot without inspecting its newly published live claim', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    const deadPid = 2_147_483_647;
    fs.writeFileSync(file, JSON.stringify({ command: ['dead'], cwd: '/', pid: deadPid, startedAt: 'old' }));
    const kill = vi.spyOn(process, 'kill');
    const release = await acquireHeavySlot(['replacement'], { totalBytes: GIB });
    try {
      // Publication establishes claim ownership without a second process check.
      expect(kill).toHaveBeenCalledWith(deadPid, 0);
      expect(kill).not.toHaveBeenCalledWith(process.pid, 0);
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
    } finally {
      release();
    }
    expect(fs.readdirSync(directory)).toStrictEqual([]);
  });

  it('acquires without waiting after reclaiming a dead reclamation claim', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    const bytes = JSON.stringify({ command: ['dead'], cwd: '/', pid: 2_147_483_647, startedAt: 'old' });
    fs.writeFileSync(file, bytes);
    const key = createHash('sha256').update(`${file}:${bytes}`).digest('hex');
    fs.writeFileSync(path.join(directory, `reclaim-${key}.lock`), bytes);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cancellation = new AbortController();
    const pending = acquireHeavySlot(['replacement'], { signal: cancellation.signal, totalBytes: GIB });
    // Immediate acquisition completes before abort. A polling fallback rejects on abort.
    cancellation.abort('SIGINT');
    await expect(pending).resolves.toBeTypeOf('function');
    const release = await pending;
    try {
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
    } finally {
      release();
    }
    expect(fs.readdirSync(directory)).toStrictEqual([]);
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
    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith('tern-wt: all 1 heavy slots are busy; waiting\n');
    });
    cancellation.abort('SIGINT');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(bytes);
    expect(stderr.mock.calls.filter(([message]) => message === 'tern-wt: all 1 heavy slots are busy; waiting\n').length).toBeGreaterThanOrEqual(1);
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

  it('keeps a slot when raw ownership disappears before exclusive recovery', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    fs.writeFileSync(file, 'invalid metadata');
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.readFileSync).mockImplementationOnce((target, options) => {
      if (String(target) === file) {
        actual.unlinkSync(file);
        throw Object.assign(new Error('raw ownership disappeared'), { code: 'ENOENT' });
      }
      return actual.readFileSync(target, options);
    });
    const release = await acquireHeavySlot(['replacement'], { totalBytes: GIB });
    try {
      expect(heavyStatus({ totalBytes: GIB }).slots[0]).toMatchObject({ busy: true, command: ['replacement'] });
    } finally {
      release();
    }
  });

  it('keeps ownership that reappears after the stale bytes disappear', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    fs.writeFileSync(file, 'invalid metadata');
    const replacement = JSON.stringify({ command: ['replacement'], cwd: '/', pid: process.pid, startedAt: 'new' });
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.readFileSync).mockImplementationOnce((target, options) => {
      if (String(target) === file) {
        actual.unlinkSync(file);
        throw Object.assign(new Error('raw ownership disappeared'), { code: 'ENOENT' });
      }
      return actual.readFileSync(target, options);
    });
    vi.mocked(fs.linkSync).mockImplementation((source, destination) => {
      if (String(destination) === file) {
        actual.writeFileSync(file, replacement);
        throw Object.assign(new Error('reappeared'), { code: 'EEXIST' });
      }
      actual.linkSync(source, destination);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cancellation = new AbortController();
    const pending = acquireHeavySlot(['waiting'], { signal: cancellation.signal, totalBytes: GIB });
    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith('tern-wt: all 1 heavy slots are busy; waiting\n');
    });
    cancellation.abort('SIGINT');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(replacement);
  });

  it('propagates malformed ownership bytes that are not JSON syntax errors', () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'slot-1.lock'), 'invalid metadata');
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new TypeError('malformed ownership');
    });
    try {
      expect(() => heavyStatus({ totalBytes: GIB })).toThrow('malformed ownership');
    } finally {
      parse.mockRestore();
    }
  });

  it('propagates denied access while reading raw stale ownership', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    fs.writeFileSync(file, 'invalid metadata');
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.readFileSync).mockImplementation((target, options) => {
      if (String(target) === file) {
        throw Object.assign(new Error('raw ownership read failed'), { code: 'EACCES' });
      }
      return actual.readFileSync(target, options);
    });
    await expect(acquireHeavySlot(['replacement'], { totalBytes: GIB })).rejects.toThrow('raw ownership read failed');
  });

  it('keeps the stale slot when exclusive recovery cannot be published again', async () => {
    const directory = path.join(process.env.TERN_PLUGIN_DATA ?? '', 'heavy');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'slot-1.lock');
    const bytes = JSON.stringify({ command: ['old'], cwd: '/', pid: 2_147_483_647, startedAt: 'old' });
    fs.writeFileSync(file, bytes);
    const key = createHash('sha256').update(`${file}:${bytes}`).digest('hex');
    const claim = path.join(directory, `reclaim-${key}.lock`);
    fs.writeFileSync(claim, bytes);
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.linkSync).mockImplementation((source, destination) => {
      if (String(destination) === claim) {
        throw Object.assign(new Error('claim occupied'), { code: 'EEXIST' });
      }
      actual.linkSync(source, destination);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cancellation = new AbortController();
    const pending = acquireHeavySlot(['waiting'], { signal: cancellation.signal, totalBytes: GIB });
    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith('tern-wt: all 1 heavy slots are busy; waiting\n');
    });
    cancellation.abort('SIGINT');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(bytes);
  });
});
