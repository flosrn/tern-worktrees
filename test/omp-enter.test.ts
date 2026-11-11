import { realpathSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Mock } from 'vite-plus/test';
import enterExtension from '../src/omp-enter.ts';
import type { EnterContext, EnterExecResult, EnterExtensionAPI, EnterHandler, EnterHookResult, EnterTool, EnterToolResult } from '../src/omp-enter.ts';
import { tempDir } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'tern-wt');
const SUCCESS: EnterExecResult = { code: 0, killed: false, stderr: '', stdout: '{}' };
const schema = { optional: () => schema };
const noSessionFiles: string[] = [];

interface Fixture {
  ctx: EnterContext;
  exec: Mock<EnterExtensionAPI['exec']>;
  emit: (name: string) => Promise<EnterHookResult | undefined>;
  enter: (params: { path?: string }, overrides?: Partial<EnterContext>) => EnterToolResult;
  notify: Mock<(message: string, type: 'info' | 'warning' | 'error') => void>;
  shutdown: Mock<() => void>;
}

interface FixtureOptions {
  answer?: EnterExecResult;
  ui?: boolean;
}

const fixture = ({ answer = SUCCESS, ui = true }: FixtureOptions = {}): Fixture => {
  const handlers = new Map<string, EnterHandler>();
  let tool: EnterTool | undefined;
  const exec = vi.fn<EnterExtensionAPI['exec']>(async () => await Promise.resolve(answer));
  enterExtension({
    exec,
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerTool: registered => {
      tool = registered;
    },
    zod: { object: () => schema, string: () => schema },
  });
  const notify = vi.fn<(message: string, type: 'info' | 'warning' | 'error') => void>();
  const shutdown = vi.fn<() => void>();
  const ctx: EnterContext = { cwd: tempDir('cwd'), sessionManager: { getSessionFile: () => '/sessions/a.jsonl' }, shutdown };
  if (ui) {
    ctx.ui = { notify };
  }
  return {
    ctx,
    emit: async name => await handlers.get(name)?.({ toolName: 'bash' }, ctx),
    enter: (params, overrides = {}) => tool?.execute('call', params, undefined, undefined, { ...ctx, ...overrides }) ?? { content: [], details: {} },
    exec,
    notify,
    shutdown,
  };
};

describe('worktree_enter', () => {
  let worktree: string;
  beforeEach(() => {
    vi.stubEnv('TERN_PANE', '7');
    worktree = realpathSync(tempDir('worktree'));
  });

  it('records the worktree and blocks each other tool call of the turn', async () => {
    const host = fixture();
    expect(host.enter({ path: worktree })).toStrictEqual({
      content: [
        {
          text: `This session moves into ${worktree} when this turn ends: a fork of it continues the task there, and this session ends. Make no other tool call. End the turn now with one short line for the user.`,
          type: 'text',
        },
      ],
      details: { path: worktree },
    });
    await expect(host.emit('tool_call')).resolves.toMatchObject({ block: true });
  });

  it('forks the session into the worktree when the turn ends, then shuts this session down', async () => {
    const host = fixture();
    host.enter({ path: worktree });
    await expect(host.emit('session_stop')).resolves.toBeUndefined();
    expect(host.exec).toHaveBeenCalledWith(CLI, ['enter', worktree, '--fork', '/sessions/a.jsonl'], { cwd: host.ctx.cwd, timeout: 60_000 });
    expect(host.notify).toHaveBeenCalledWith(`Session forked into ${worktree}`, 'info');
    expect(host.shutdown).toHaveBeenCalledOnce();
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
  });

  it('resolves a relative path from the session directory', () => {
    const host = fixture();
    expect(host.enter({ path: path.relative(host.ctx.cwd, worktree) })).toMatchObject({ details: { path: worktree } });
  });

  it('does nothing at the end of a turn without a request', async () => {
    const host = fixture();
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
    await expect(host.emit('session_stop')).resolves.toBeUndefined();
    expect(host.exec).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 1, killed: false, stderr: 'enter failed: no tab\n', stdout: '' }, 'enter failed: no tab'],
    [{ code: 1, killed: false, stderr: '', stdout: '' }, 'tern-wt enter failed (1)'],
    [{ code: 0, killed: true, stderr: '', stdout: '' }, 'tern-wt enter failed (0)'],
  ])('keeps the session and continues the task when the fork fails', async (answer, reason) => {
    const host = fixture({ answer });
    host.enter({ path: worktree });
    await expect(host.emit('session_stop')).resolves.toStrictEqual({
      additionalContext: `The move into ${worktree} failed, so this session stays here: ${reason}. Tell the user, then continue the task in this session.`,
      continue: true,
    });
    expect(host.shutdown).not.toHaveBeenCalled();
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
  });

  it('shuts down without a UI', async () => {
    const host = fixture({ ui: false });
    host.enter({ path: worktree });
    await host.emit('session_stop');
    expect(host.shutdown).toHaveBeenCalledOnce();
  });

  const refusals: [string, { path?: string }, Partial<EnterContext>, string][] = [
    ['a subagent', { path: 'x' }, { agent: { kind: 'task' } }, 'Only the main session can move into a worktree.'],
    ['an empty path', { path: ' ' }, {}, 'Expected the path of a worktree.'],
    ['no path', {}, {}, 'Expected the path of a worktree.'],
    ['no session file', { path: 'x' }, { sessionManager: { getSessionFile: () => noSessionFiles.at(0) } }, 'This session has no session file to fork.'],
    ['an empty session file', { path: 'x' }, { sessionManager: { getSessionFile: () => '' } }, 'This session has no session file to fork.'],
  ];

  it.each(refusals)('refuses %s', async (_name, params, overrides, text) => {
    const host = fixture();
    expect(host.enter(params, overrides)).toStrictEqual({ content: [{ text, type: 'text' }], details: {}, isError: true });
    await expect(host.emit('tool_call')).resolves.toBeUndefined();
  });

  it('accepts the main agent', () => {
    expect(fixture().enter({ path: worktree }, { agent: { kind: 'main' } })).toMatchObject({ details: { path: worktree } });
  });

  it('refuses a missing worktree', () => {
    const result = fixture().enter({ path: path.join(worktree, 'none') });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/^Cannot resolve the worktree path: Error: ENOENT/u);
  });

  it.each([undefined, ''])('refuses outside Tern (TERN_PANE %j)', pane => {
    vi.stubEnv('TERN_PANE', pane);
    expect(fixture().enter({ path: worktree })).toMatchObject({
      content: [{ text: 'This session does not run in a Tern pane, so it cannot move into the tab of a worktree.' }],
      isError: true,
    });
  });
});
