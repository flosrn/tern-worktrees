import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import timers from 'node:timers/promises';
import { vi } from 'vite-plus/test';
import type { MockInstance } from 'vite-plus/test';
import type { ResourceContext } from '../src/clean-resources.ts';
import { run } from '../src/proc.ts';
import { ls, processOf } from '../src/tern.ts';
import { useSandbox } from './helpers.ts';

const REMOVED_WORKTREE = '/repo/remove';
export interface ContainerFixture {
  Id: string;
  Name?: string;
  Config?: { Labels: Record<string, string> | null } | null;
  Mounts?: { Source: string }[];
}

export interface ResourceFixture {
  root: string;
  ctx: ResourceContext;
  state: {
    containers: ContainerFixture[];
    dockerList: string | null;
    listStatus: number;
    inspectStatus: number;
    rmStatus: number;
    stderr: string;
    ps: string | null;
    psStatus: number;
    ids: number[];
    calls: string[][];
  };
  kill: MockInstance<typeof process.kill>;
  delay: MockInstance<typeof timers.setTimeout>;
  entry: (pid: number, cwd?: string, command?: string, parent?: number, start?: string, group?: number) => string;
  block: (cwd: string | null) => void;
}

/** Builds Docker ownership evidence for a removed worktree. */
export const dockerContainer = (Id: string, sources = [REMOVED_WORKTREE], labels: Record<string, string> = {}): ContainerFixture => ({
  Config: { Labels: labels },
  Id,
  Mounts: sources.map(Source => ({ Source })),
  Name: '/db',
});

const block = (cwd: string | null) => {
  vi.mocked(ls).mockResolvedValue({ sessions: [{ id: 1, name: 'repo', tabs: [{ blocks: [{ cwd, id: 1, title: 'shell' }], id: 1, name: 'work' }] }] });
};

/** Installs isolated OS boundaries for resource safety tests. */
export const resourceFixture = (): ResourceFixture => {
  useSandbox();
  const root = process.env.TERN_WT_PROC_ROOT ?? '';
  const ctx: ResourceContext = { removeWorktrees: [REMOVED_WORKTREE], repo: '/repo/main', worktrees: [REMOVED_WORKTREE, '/repo/live'] };
  const state: ResourceFixture['state'] = {
    calls: [],
    containers: [],
    dockerList: null,
    ids: [],
    inspectStatus: 0,
    listStatus: 0,
    ps: null,
    psStatus: 0,
    rmStatus: 0,
    stderr: '',
  };
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const delay = vi.spyOn(timers, 'setTimeout').mockResolvedValue(undefined);
  vi.mocked(ls).mockResolvedValue({ sessions: [] });
  vi.mocked(processOf).mockResolvedValue({ child: null, foreground: null, group: null, pane: 1 });
  vi.mocked(run).mockImplementation(async argv => {
    state.calls.push(argv);
    await Promise.resolve();
    if (argv[0] === 'ps') {
      return { status: state.psStatus, stderr: '', stdout: state.ps ?? state.ids.map(pid => `${pid} 1 ${pid} worker`).join('\n') };
    }
    if (argv[1] === 'ps') {
      return { status: state.listStatus, stderr: '', stdout: state.dockerList ?? state.containers.map(item => item.Id).join('\n') };
    }
    if (argv[1] === 'inspect') {
      return { status: state.inspectStatus, stderr: '', stdout: JSON.stringify(state.containers.filter(item => argv.includes(item.Id))) };
    }
    return { status: state.rmStatus, stderr: state.stderr, stdout: '' };
  });
  const entry = (pid: number, cwd = REMOVED_WORKTREE, command = 'node worker.js', parent = 1, start = '100', group = pid) => {
    state.ids.push(pid);
    const dir = path.join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    rmSync(path.join(dir, 'cwd'), { force: true });
    symlinkSync(cwd, path.join(dir, 'cwd'));
    const fields = ['S', String(parent), String(group), ...Array.from({ length: 16 }, () => '0'), start];
    writeFileSync(path.join(dir, 'stat'), `${pid} (worker) ${fields.join(' ')}`);
    writeFileSync(path.join(dir, 'cmdline'), command.replaceAll(' ', '\0'));
    return dir;
  };
  return { block, ctx, delay, entry, kill, root, state };
};
