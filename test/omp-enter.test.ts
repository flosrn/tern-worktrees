import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Mock } from 'vite-plus/test';
import { requestEnter } from '../src/enter.ts';
import enterExtension from '../src/omp-enter.ts';
import type { EnterContext, EnterExecResult, EnterExtensionAPI, EnterHandler, EnterHookResult } from '../src/omp-enter.ts';
import { tempDir, useSandbox } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'tern-wt');
const SESSION = '01a1c956-a9e5-72d7-b9a1-e0e3732c4db9';
const SUCCESS: EnterExecResult = { code: 0, killed: false, stderr: '', stdout: '{}' };
const END_TURN =
  'This session moves into the recorded worktree when this turn ends: a fork of it continues the task there, and this session ends. Make no other tool call. End the turn now with one short line for the user.';
const noSessionFiles: string[] = [];

interface Fixture {
  ctx: EnterContext;
  exec: Mock<EnterExtensionAPI['exec']>;
  emit: (name: string) => Promise<EnterHookResult | undefined>;
  notify: Mock<(message: string, type: 'info' | 'warning' | 'error') => void>;
  shutdown: Mock<() => void>;
}

interface FixtureOptions {
  answer?: EnterExecResult;
  ui?: boolean;
  overrides?: Partial<EnterContext>;
}

const fixture = ({ answer = SUCCESS, ui = true, overrides = {} }: FixtureOptions = {}): Fixture => {
  const handlers = new Map<string, EnterHandler>();
  const exec = vi.fn<EnterExtensionAPI['exec']>(async () => await Promise.resolve(answer));
  enterExtension({
    exec,
    on: (name, handler) => {
      handlers.set(name, handler);
    },
  });
  const notify = vi.fn<(message: string, type: 'info' | 'warning' | 'error') => void>();
  const shutdown = vi.fn<() => void>();
  const ctx: EnterContext = { cwd: tempDir('cwd'), sessionManager: { getSessionFile: () => '/sessions/a.jsonl', getSessionId: () => SESSION }, shutdown, ...overrides };
  if (ui) {
    ctx.ui = { notify };
  }
  return { ctx, emit: async name => await handlers.get(name)?.({}, ctx), exec, notify, shutdown };
};

describe('enter lifecycle', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('tells the agent to end the turn after the request, then blocks each other tool call', async () => {
    const host = fixture();
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
    requestEnter(SESSION, '/wt');
    await expect(host.emit('tool_result')).resolves.toStrictEqual({ additionalContext: END_TURN });
    await expect(host.emit('tool_result')).resolves.toBeUndefined();
    await expect(host.emit('tool_call')).resolves.toMatchObject({ block: true });
  });

  it('forks the session at the end of the turn, then shuts this session down', async () => {
    const host = fixture();
    requestEnter(SESSION, '/wt');
    await host.emit('tool_result');
    await expect(host.emit('session_stop')).resolves.toBeUndefined();
    expect(host.exec).toHaveBeenCalledWith(CLI, ['enter', '--session', SESSION, '--fork', '/sessions/a.jsonl'], { cwd: host.ctx.cwd, timeout: 60_000 });
    expect(host.notify).toHaveBeenCalledWith('Session forked into the worktree', 'info');
    expect(host.shutdown).toHaveBeenCalledOnce();
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
  });

  it('forks a request that no tool result reported', async () => {
    const host = fixture({ overrides: { agent: { kind: 'main' } } });
    requestEnter(SESSION, '/wt');
    await host.emit('session_stop');
    expect(host.shutdown).toHaveBeenCalledOnce();
  });

  it('passes an empty session file to the CLI, which refuses it', async () => {
    const host = fixture({ overrides: { sessionManager: { getSessionFile: () => noSessionFiles.at(0), getSessionId: () => SESSION } } });
    requestEnter(SESSION, '/wt');
    await host.emit('session_stop');
    expect(host.exec.mock.calls[0]?.[1]).toStrictEqual(['enter', '--session', SESSION, '--fork', '']);
  });

  it('does nothing without a request', async () => {
    const host = fixture();
    await expect(host.emit('tool_result')).resolves.toBeUndefined();
    await expect(host.emit('session_stop')).resolves.toBeUndefined();
    expect(host.exec).not.toHaveBeenCalled();
  });

  it('ignores the requests of a subagent', async () => {
    const host = fixture({ overrides: { agent: { kind: 'task' } } });
    requestEnter(SESSION, '/wt');
    await expect(host.emit('tool_result')).resolves.toBeUndefined();
    await expect(host.emit('session_stop')).resolves.toBeUndefined();
    expect(host.exec).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 1, killed: false, stderr: 'no tab\n', stdout: '' }, 'no tab'],
    [{ code: 1, killed: false, stderr: '', stdout: '' }, 'tern-wt enter failed (1)'],
    [{ code: 0, killed: true, stderr: '', stdout: '' }, 'tern-wt enter failed (0)'],
  ])('keeps the session and continues the task when the fork fails', async (answer, reason) => {
    const host = fixture({ answer });
    requestEnter(SESSION, '/wt');
    await host.emit('tool_result');
    await expect(host.emit('session_stop')).resolves.toStrictEqual({
      additionalContext: `The move into the worktree failed, so this session stays here: ${reason}. Tell the user, then continue the task in this session.`,
      continue: true,
    });
    expect(host.shutdown).not.toHaveBeenCalled();
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
  });

  it('shuts down without a UI', async () => {
    const host = fixture({ ui: false });
    requestEnter(SESSION, '/wt');
    await host.emit('session_stop');
    expect(host.shutdown).toHaveBeenCalledOnce();
  });
});
