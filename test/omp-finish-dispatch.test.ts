import { describe, expect, it, vi } from 'vite-plus/test';
import type { FinishExtensionAPI } from '../src/omp-finish-types.ts';
import { askInput, askReply, FinishHost, host } from './omp-finish-host.ts';
import { tempDir, tmpRepo, useSandbox } from './helpers.ts';

describe('OMP process dispatch contract', () => {
  it('pins the checkout, caller identity and execution deadlines at each process boundary', async () => {
    const h = await host();
    const execute = h.api.exec.bind(h.api);
    const calls: Parameters<FinishExtensionAPI['exec']>[] = [];
    const dispatch: FinishExtensionAPI['exec'] = async (command, args, options) => {
      calls.push([command, args, options]);
      return await execute(command, args, options);
    };
    h.api.exec = dispatch;
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'process-contract', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'process-contract',
      toolName: 'ask',
    });
    expect(calls.find(([command]) => command === 'git')).toStrictEqual(['git', ['-C', h.ctx.cwd, 'rev-parse', '--show-toplevel'], { cwd: h.ctx.cwd, timeout: 10_000 }]);
    expect(calls.find(([, args]) => args[1] === 'plan')?.slice(1)).toStrictEqual([
      ['finish', 'plan', '--repo', h.ctx.cwd, '--current', h.ctx.cwd, '--pid', String(process.pid), '--session', 'session-1'],
      { cwd: h.ctx.cwd, timeout: 30_000 },
    ]);
    expect(calls.find(([, args]) => args[1] === 'arm')?.[2]).toStrictEqual({ cwd: h.ctx.cwd, timeout: 30_000 });
    expect(calls.find(([, args]) => args[0] === 'ctl')?.slice(1)).toStrictEqual([
      ['ctl', 'plugins', 'run', 'plugin.tern-worktrees.finish-watch'],
      { cwd: h.ctx.cwd, timeout: 10_000 },
    ]);
  });

  it.each([
    { code: 1, killed: false },
    { code: 0, killed: true },
  ])('rejects failed git even when stdout contains an absolute checkout: %j', async failure => {
    const h = await host();
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => (command === 'git' ? { ...failure, stderr: '', stdout: `${h.ctx.cwd}\n` } : await execute(command, args, options));
    await h.tool({ action: 'ready' });
    const before = h.calls().length;
    const response = await h.emit('session_stop');
    expect(response?.additionalContext).toContain('Cannot resolve the current checkout');
    expect(h.calls()).toHaveLength(before);
    expect(h.shutdowns()).toBe(0);
  });

  it.each(['01', '+1', '1.0', '1e1', '9007199254740992'])('does not bind a malformed caller block: %s', async block => {
    const h = await host();
    vi.stubEnv('TERN_PANE', block);
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    expect(h.calls().findLast(call => call[1] === 'plan')).not.toContain('--block');
  });

  it('keeps backend reasons and warnings visible when no candidate can be offered', async () => {
    const h = await host();
    h.plan.candidates = [];
    h.plan.warnings = ['The saved merge could not be verified.'];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const response = await h.emit('session_stop');
    expect(response?.additionalContext).toContain('not ready');
    expect(response?.continue).toBeTruthy();
    expect(response?.additionalContext).toContain('active_process');
    expect(response?.additionalContext).toContain('The saved merge could not be verified.');
    expect(response?.additionalContext).not.toContain('<form');
  });
});

describe('OMP arm completion boundaries', () => {
  it('arms an automatic finish without a previously declared retained set', async () => {
    const h = await host();
    h.plan.candidates[0].head = 'c'.repeat(40);
    h.plan.candidates[0].pr.headRefOid = 'c'.repeat(40);
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    const input = askInput(await h.emit('session_stop'));
    expect(h.calls().findLast(call => call[1] === 'plan')).not.toContain('--exclude');
    await h.emit('tool_call', { input, toolCallId: 'automatic-arm', toolName: 'ask' });
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'automatic-arm',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toMatch(/teardown is armed/u);
    await h.emit('message_end', { message: { content: [{ text: 'Delivery completed.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect({ selected: h.entries.at(-1)?.data?.pending?.selected, shutdowns: h.shutdowns() }).toStrictEqual({ selected: [h.ctx.cwd], shutdowns: 1 });
  });

  it('keeps a non-null current checkout alive when only another approved worktree is selected', async () => {
    const h = await host();
    const other = tempDir('finish-selected-elsewhere');
    h.plan.candidates = [{ ...h.plan.candidates[0], path: other }];
    h.savePlan();
    await h.tool({ action: 'ready', owned: [other] });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'elsewhere', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'elsewhere',
      toolName: 'ask',
    });
    await h.emit('message_end', { message: { content: [{ text: 'Delivery completed elsewhere.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect({ current: h.entries.at(-1)?.data?.pending?.plan.current, selected: h.entries.at(-1)?.data?.pending?.selected, shutdowns: h.shutdowns() }).toStrictEqual({
      current: h.ctx.cwd,
      selected: [other],
      shutdowns: 0,
    });
  });

  it.each([
    { code: 1, killed: false, stderr: '  watcher exited unexpectedly  ', warning: /watcher exited unexpectedly/u },
    { code: 1, killed: false, stderr: '   ', warning: /watcher unavailable/u },
    { code: 0, killed: true, stderr: '', warning: /watcher unavailable/u },
  ])('keeps the durable arm and explains watcher failure: %j', async ({ code, killed, stderr, warning }) => {
    const h = await host();
    const notices: { message: string; type: string }[] = [];
    h.ctx.ui = {
      notify: (message, type) => {
        notices.push({ message, type });
      },
    };
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => (args[0] === 'ctl' ? { code, killed, stderr, stdout: '' } : await execute(command, args, options));
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'watcher-failure', toolName: 'ask' });
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'watcher-failure',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toMatch(/teardown is armed/u);
    expect(notices.map(notice => notice.type)).toStrictEqual(['warning']);
    expect(notices[0].message).toMatch(warning);
    expect(h.entries.at(-1)?.data?.pending).toMatchObject({ selected: [h.ctx.cwd], status: 'armed' });
  });

  it.each(['success', 'failure without UI', 'refusal'])('does not manufacture a notification warning after %s', async outcome => {
    const h = await host();
    const notices: string[] = [];
    let watcherCalls = 0;
    if (outcome !== 'failure without UI') {
      h.ctx.ui = {
        notify: message => {
          notices.push(message);
        },
      };
    }
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => {
      if (args[0] === 'ctl') {
        watcherCalls += 1;
        return { code: outcome === 'failure without UI' ? 1 : 0, killed: false, stderr: '', stdout: '' };
      }
      return await execute(command, args, options);
    };
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'watcher-outcome', toolName: 'ask' });
    const response = await h.emit('tool_result', {
      ...askReply(input, outcome === 'refusal' ? 'none' : 'current'),
      input,
      toolCallId: 'watcher-outcome',
      toolName: 'ask',
    });
    expect({ notices, status: h.entries.at(-1)?.data?.pending?.status, watcherCalls }).toStrictEqual({
      notices: [],
      status: outcome === 'refusal' ? 'closed' : 'armed',
      watcherCalls: outcome === 'refusal' ? 0 : 1,
    });
    expect(response?.additionalContext).toMatch(outcome === 'refusal' ? /declined.*[Kk]eep/u : /teardown is armed/u);
  });
});

describe('OMP initial process state', () => {
  it('stays idle before startup and accepts an empty initial worktree scope', async () => {
    useSandbox();
    const repo = await tmpRepo();
    const h = new FinishHost(repo.dir, tempDir('finish-before-startup'));
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    const response = await h.tool({ action: 'ready' });
    expect({ error: response.isError, owned: response.details.owned }).toStrictEqual({ error: false, owned: [] });
    expect(h.calls()).toStrictEqual([]);
  });

  it('reports the failed CLI exit when stderr contains no actual diagnostic', async () => {
    const h = await host();
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => (args[1] === 'plan' ? { code: 9, killed: false, stderr: ' \n\t ', stdout: '' } : await execute(command, args, options));
    await h.tool({ action: 'ready' });
    const response = await h.emit('session_stop');
    expect(response?.additionalContext).toMatch(/finish failed \(9\)/u);
    expect(response?.additionalContext).not.toContain('<form');
    expect(h.shutdowns()).toBe(0);
  });
});
