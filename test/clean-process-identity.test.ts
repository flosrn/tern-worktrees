import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { identityOf, processSnapshot } from '../src/clean-processes.ts';
import type { ResourceContext, ResourcePlan } from '../src/clean-resources.ts';
import { tempDir, useSandbox } from './helpers.ts';

vi.mock(import('node:fs/promises'), { spy: true });

describe('targeted proc identity inspection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['stat', 'cwd', 'cmdline'])('does not report an unreadable %s as a process exit', async missing => {
    const root = tempDir('targeted-proc');
    const cwd = tempDir('targeted-proc-cwd');
    const directory = path.join(root, '90001');
    mkdirSync(directory);
    const fields = ['S', '1', '90001', ...Array.from({ length: 16 }, () => '0'), '100'];
    writeFileSync(path.join(directory, 'stat'), `90001 (worker) ${fields.join(' ')}`);
    writeFileSync(path.join(directory, 'cmdline'), 'omp');
    symlinkSync(cwd, path.join(directory, 'cwd'));
    rmSync(path.join(directory, missing));
    vi.stubEnv('TERN_WT_PROC_ROOT', root);
    await expect(identityOf(90_001)).rejects.toThrow('Process inspection incomplete: 90001; process preserved.');
    rmSync(directory, { recursive: true });
    await expect(identityOf(90_001)).resolves.toBeNull();
  });
});

const emptyPlan = (): ResourcePlan => ({ containers: [], keep: [], paths: [], processes: [], protectedWorktrees: [], warnings: [] });
const context: ResourceContext = { removeWorktrees: ['/repo/remove'], repo: '/repo/main', worktrees: ['/repo/remove', '/repo/live'] };

describe('owned process inspection through host commands', () => {
  let root: string;
  let bin: string;
  let rows: string;

  const entry = (pid: number, command = 'node worker.js', cwd = '/repo/remove'): string => {
    const directory = path.join(root, String(pid));
    mkdirSync(directory, { recursive: true });
    const fields = ['S', '1', String(pid), ...Array.from({ length: 16 }, () => '0'), '100'];
    writeFileSync(path.join(directory, 'stat'), `${pid} (worker (nested) name) ${fields.join(' ')}`);
    writeFileSync(path.join(directory, 'cmdline'), command.replaceAll(' ', '\0'));
    symlinkSync(cwd, path.join(directory, 'cwd'));
    return directory;
  };

  beforeEach(() => {
    useSandbox();
    root = process.env.TERN_WT_PROC_ROOT ?? '';
    bin = tempDir('owned-process-bin');
    rows = path.join(bin, 'rows');
    writeFileSync(rows, '');
    writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nexec /bin/cat '${rows}'\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubGlobal('process', { ...process, platform: 'linux' });
  });

  afterEach(() => {
    vi.mocked(stat).mockReset();
    vi.unstubAllGlobals();
  });

  it('reads complete identities when the process directory also contains non-PID entries', async () => {
    const directory = entry(930_001, 'node worker.js', '/repo/remove/child');
    const fields = ['S', '42', '77', ...Array.from({ length: 16 }, () => '0'), '100'];
    writeFileSync(path.join(directory, 'stat'), `930001 (worker (nested) name)   ${fields.join('   ')}  \n`);
    writeFileSync(path.join(directory, 'cmdline'), '\0node\0worker.js\0');
    mkdirSync(path.join(root, 'self'));
    writeFileSync(rows, '930001 1 930001 node worker.js\n');
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([
      { command: 'node worker.js', cwd: '/repo/remove/child', group: 77, parent: 42, pid: 930_001, start: '100' },
    ]);
    expect(plan).toStrictEqual(emptyPlan());
  });

  it('does not report an exit after the owner lookup when the host has no uid API', async () => {
    const directory = entry(930_005);
    const owner = await stat(directory);
    const host = { ...process };
    Reflect.deleteProperty(host, 'getuid');
    vi.stubGlobal('process', host);
    vi.mocked(stat).mockImplementationOnce(async () => {
      rmSync(directory, { recursive: true });
      await Promise.resolve();
      return owner;
    });
    await expect(identityOf(930_005)).rejects.toThrow('Process inspection incomplete: 930005; process preserved.');
  });

  it('uses Linux identity inspection without a proc override instead of invoking BSD inspectors', async () => {
    vi.stubEnv('TERN_WT_PROC_ROOT', '');
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('process not found'), { code: 'ENOENT' }));
    writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nprintf "BSD inspection must not run on Linux" >&2\nexit 127\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
    await expect(identityOf(930_006)).resolves.toBeNull();
  });

  it('reports an incomplete identity using normalized columns from a padded ps row', async () => {
    const directory = entry(930_007, 'node worker.js', '/outside');
    rmSync(path.join(directory, 'stat'));
    writeFileSync(rows, '  930007   1   930007   node   worker.js  \n');
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([]);
    expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 930007 (node worker.js).']);
    expect(plan.keep).toStrictEqual([{ id: '930007', kind: 'process', reason: 'Process inspection incomplete: 930007 (node worker.js); process preserved.' }]);
    expect(plan.protectedWorktrees).toStrictEqual([]);
  });

  it.each([0, -1, 1.5, 9_007_199_254_740_992])('rejects invalid ps PID %s even when a matching directory exists', async invalid => {
    entry(930_002);
    entry(invalid);
    writeFileSync(rows, `930002 1 930002 node worker.js\n${invalid} 1 1 unsafe worker\n`);
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([
      { command: 'node worker.js', cwd: '/repo/remove', group: 930_002, parent: 1, pid: 930_002, start: '100' },
    ]);
    expect(plan).toStrictEqual(emptyPlan());
  });

  it('reports each uncertain external process but not an uncertain caller', async () => {
    const caller = entry(process.pid, 'node clean');
    const first = entry(930_003, 'node first.js');
    const second = entry(930_004, 'node second.js', '/repo/live');
    for (const directory of [caller, first, second]) {
      rmSync(path.join(directory, 'stat'));
    }
    writeFileSync(rows, `${process.pid} 1 ${process.pid} node clean\n930003 1 930003 node first.js\n930004 1 930004 node second.js\n`);
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([]);
    expect(plan.warnings).toStrictEqual(['Process inspection incomplete: 930003 (node first.js), 930004 (node second.js).']);
    expect(plan.protectedWorktrees).toStrictEqual(['/repo/remove', '/repo/live']);
    expect(plan.keep).toStrictEqual([
      { id: '930003', kind: 'process', reason: 'Process inspection incomplete: 930003 (node first.js); process preserved.' },
      { id: '/repo/remove', kind: 'worktree', reason: 'Process inspection incomplete: 930003 (node first.js); process preserved.' },
      { id: '930004', kind: 'process', reason: 'Process inspection incomplete: 930004 (node second.js); process preserved.' },
      { id: '/repo/live', kind: 'worktree', reason: 'Process inspection incomplete: 930004 (node second.js); process preserved.' },
    ]);
  });
});

describe('macOS whitespace at the host command boundary', () => {
  const pid = 940_001;
  let bin: string;
  let psRows: string;
  let psError: string;
  let lsofRows: string;
  let lsofError: string;

  beforeEach(() => {
    useSandbox();
    bin = tempDir('darwin-process-bin');
    psRows = path.join(bin, 'ps-rows');
    psError = path.join(bin, 'ps-error');
    lsofRows = path.join(bin, 'lsof-rows');
    lsofError = path.join(bin, 'lsof-error');
    const uid = process.getuid?.() ?? 0;
    writeFileSync(psRows, `${pid} 1 ${pid} ${uid} Wed Oct 28 12:00:00 2026 node worker.js\n`);
    writeFileSync(psError, '');
    writeFileSync(lsofRows, `p${pid}\0\nfcwd\0n/repo/remove\0\n`);
    writeFileSync(lsofError, '');
    writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\n/bin/cat '${psRows}'\n/bin/cat '${psError}' >&2\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\n/bin/cat '${lsofRows}'\n/bin/cat '${lsofError}' >&2\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('TERN_WT_PROC_ROOT', '');
    vi.stubGlobal('process', { ...process, getuid: () => uid, platform: 'darwin' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 28, 12, 0, 2));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['stdout', 'stderr'])('recognizes an exited PID when ps has only %s whitespace', async stream => {
    writeFileSync(psRows, stream === 'stdout' ? ' \t\n' : '');
    writeFileSync(psError, stream === 'stderr' ? ' \t\n' : '');
    await expect(identityOf(pid)).resolves.toBeNull();
  });

  it('protects worktrees when the full ps inventory fails without any rows', async () => {
    writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(lsofRows, '');
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([]);
    expect(plan.warnings).toStrictEqual(['Cannot inspect processes; worktree process ownership cannot be proven.']);
    expect(plan.protectedWorktrees).toStrictEqual(context.worktrees);
  });

  it('does not strip an interior newline from a cwd field', async () => {
    writeFileSync(lsofRows, `p${pid}\0\nfcwd\0n/repo/remove/line\nnext\0\n`);
    await expect(identityOf(pid)).resolves.toStrictEqual({
      command: 'node worker.js',
      cwd: '/repo/remove/line\nnext',
      group: pid,
      parent: 1,
      pid,
      start: 'Wed Oct 28 12:00:00 2026',
    });
  });

  it('reads padded inner ps rows without shifting PID and ownership columns', async () => {
    const uid = process.getuid?.() ?? 0;
    writeFileSync(psRows, `${pid} 1 ${pid} ${uid} Wed Oct 28 12:00:00 2026 node first.js\n  940002   42   77   ${uid}   Wed Oct 28 12:00:00 2026   node second.js  \n`);
    writeFileSync(lsofRows, `p${pid}\0\nfcwd\0n/repo/remove\0\np940002\0\nfcwd\0n/repo/live\0\n`);
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([
      { command: 'node first.js', cwd: '/repo/remove', group: pid, parent: 1, pid, start: 'Wed Oct 28 12:00:00 2026' },
      { command: 'node second.js', cwd: '/repo/live', group: 77, parent: 42, pid: 940_002, start: 'Wed Oct 28 12:00:00 2026' },
    ]);
    expect(plan).toStrictEqual(emptyPlan());
  });

  it('accepts lsof whitespace without treating it as an ownership diagnostic', async () => {
    writeFileSync(lsofError, ' \t\n');
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([
      { command: 'node worker.js', cwd: '/repo/remove', group: pid, parent: 1, pid, start: 'Wed Oct 28 12:00:00 2026' },
    ]);
    expect(plan).toStrictEqual(emptyPlan());
  });

  it('reports the trimmed host diagnostic when lsof cannot prove ownership', async () => {
    writeFileSync(lsofError, '  cannot inspect a volume\n');
    const plan = emptyPlan();
    await expect(processSnapshot(context, plan)).resolves.toStrictEqual([]);
    expect(plan.warnings).toStrictEqual(['Cannot inspect process cwd with lsof (exit 0): cannot inspect a volume; worktree process ownership cannot be proven.']);
    expect(plan.protectedWorktrees).toStrictEqual(context.worktrees);
  });
});
