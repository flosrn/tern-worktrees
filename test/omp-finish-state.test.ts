import { once } from 'node:events';
import { describe, expect, it } from 'vite-plus/test';
import finishExtension from '../src/omp-finish.ts';
import type { FinishEvent } from '../src/omp-finish-types.ts';
import { askInput, askReply, host } from './omp-finish-host.ts';
import { tempDir } from './helpers.ts';

describe('OMP session state boundaries', () => {
  it.each(['session_start', 'session_branch', 'session_tree'])('restores the saved scope on %s and ignores unrelated state-bearing entries', async lifecycle => {
    const h = await host();
    await h.tool({ action: 'scope', owned: [h.ctx.cwd], workflow: 'orchestrate' });
    h.entries.push(
      { customType: 'other.extension', data: { owned: [], requested: true, worker: true }, type: 'custom' },
      { customType: 'tern-worktrees.finish', data: { owned: [], requested: true, worker: true }, type: 'message' },
      { customType: 'tern-worktrees.finish', type: 'custom' },
    );
    finishExtension(h.api);
    await h.emit(lifecycle);
    await h.tool({ action: 'ready' });
    expect(askInput(await h.emit('session_stop')).html).toContain(h.ctx.cwd);
    expect(h.calls().findLast(call => call[1] === 'plan')).toStrictEqual(expect.arrayContaining(['--owned', h.ctx.cwd]));
  });

  it('persists a closed interrupted ask before a second extension restart', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'interrupted-durable', toolName: 'ask' });
    finishExtension(h.api);
    await h.emit('session_start');
    const restored = h.entries.at(-1)?.data;
    expect(restored).toMatchObject({ pending: { status: 'closed' }, requested: false });
    finishExtension(h.api);
    await h.emit('session_branch');
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'interrupted-durable',
      toolName: 'ask',
    });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([]);
  });

  it('keeps a saved worker silent across an extension restart', async () => {
    const h = await host();
    await h.emit('before_agent_start', { prompt: "This worker is assigned by the user's explicit `orchestrate` invocation." });
    finishExtension(h.api);
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('does not classify an ordinary prompt as a dispatched worker', async () => {
    const h = await host();
    await h.emit('before_agent_start', { prompt: 'Implement the delivery in this session.' });
    await h.tool({ action: 'ready' });
    expect(askInput(await h.emit('session_stop')).html).toContain('<input type="radio" name="tern-wt-finish:plan-1" value="none" checked');
  });

  it('allows an explicitly identified main agent to assess readiness and ask', async () => {
    const h = await host();
    h.ctx.agent = { kind: 'main' };
    h.entries.length = 0;
    await h.emit('session_start');
    expect(h.entries.at(-1)?.data?.baselineMerged).toStrictEqual([`${h.ctx.cwd}:${'a'.repeat(40)}`]);
    await h.tool({ action: 'ready' });
    expect(askInput(await h.emit('session_stop')).html).toContain('<input type="radio" name="tern-wt-finish:plan-1" value="none" checked');
  });

  it('never assesses a native task agent during startup', async () => {
    const h = await host();
    h.ctx.agent = { kind: 'task' };
    h.entries.length = 0;
    const before = h.calls().length;
    await h.emit('session_start');
    expect(h.calls()).toHaveLength(before);
  });

  it.each(['ask', 'worktree_finish', 'failed tool', 'no tool'])('does not infer a completed delivery from %s', async completion => {
    const h = await host();
    h.plan.candidates[0].head = 'c'.repeat(40);
    h.plan.candidates[0].pr.headRefOid = 'c'.repeat(40);
    h.savePlan();
    if (completion !== 'no tool') {
      await h.emit('tool_result', { isError: completion === 'failed tool', toolName: completion === 'failed tool' ? 'bash' : completion });
    }
    const before = h.calls().length;
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.calls()).toHaveLength(before);
    await h.emit('tool_result', { toolName: 'bash' });
    expect(askInput(await h.emit('session_stop')).html).toContain('c'.repeat(40));
  });

  it('preserves a baseline across restore so a new merge is not mistaken for an old one', async () => {
    const h = await host();
    h.plan.candidates[0].head = 'd'.repeat(40);
    h.plan.candidates[0].pr.headRefOid = 'd'.repeat(40);
    h.savePlan();
    finishExtension(h.api);
    await h.emit('session_tree');
    await h.emit('tool_result', { toolName: 'bash' });
    expect(askInput(await h.emit('session_stop')).html).toContain('d'.repeat(40));
  });

  it('requires explicit readiness for a run marked orchestrate even without an initial scope action', async () => {
    const h = await host();
    await h.tool({ action: 'ready', workflow: 'orchestrate' });
    h.plan.candidates = [];
    h.savePlan();
    await h.emit('session_stop');
    h.plan.candidates.push({
      branch: 'feature/later',
      head: 'e'.repeat(40),
      path: h.ctx.cwd,
      pr: { headRefOid: 'e'.repeat(40), mergeCommit: 'f'.repeat(40), mergedAt: '2026-11-09T00:00:00Z', number: 43, url: 'https://github.com/test/repo/pull/43' },
    });
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await h.tool({ action: 'ready' });
    expect(askInput(await h.emit('session_stop')).html).toContain('<input type="radio" name="tern-wt-finish:plan-1" value="none" checked');
  });
});

describe('OMP durable lifecycle decisions', () => {
  it.each(['identity revoked', 'invalid answer', 'backend failed'])('persists a terminal decision immediately after %s', async outcome => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    if (outcome === 'identity revoked') {
      h.api.getAllTools = () => [];
      await h.emit('tool_call', { input, toolCallId: 'terminal', toolName: 'ask' });
    } else {
      await h.emit('tool_call', { input, toolCallId: 'terminal', toolName: 'ask' });
      if (outcome === 'backend failed') {
        h.failArm();
      }
      const result: FinishEvent = { ...askReply(input, 'current'), input, toolCallId: 'terminal', toolName: 'ask' };
      if (outcome === 'invalid answer') {
        result.content = [{ text: 'User answers:\n{invalid json', type: 'text' }];
      }
      await h.emit('tool_result', result);
    }
    expect(h.entries.at(-1)?.data?.pending?.status).toBe('closed');
    finishExtension(h.api);
    await h.emit('session_start');
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(0);
  });

  it('persists the active call identity before native ask can finish', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'durable-call', toolName: 'ask' });
    expect(h.entries.at(-1)?.data?.pending).toMatchObject({ callId: 'durable-call', status: 'asking' });
  });

  it('persists arming before the watcher observes it and persists the delivered report and final closure', async () => {
    const h = await host();
    const observed: string[] = [];
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => {
      if (args[0] === 'ctl') {
        observed.push(h.entries.at(-1)?.data?.pending?.status ?? 'missing');
      }
      return await execute(command, args, options);
    };
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'durable-arm', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'durable-arm',
      toolName: 'ask',
    });
    expect(observed).toStrictEqual(['armed']);
    await h.emit('message_end', { message: { content: [{ text: 'Delivery completed.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    expect(h.entries.at(-1)?.data?.pending).toMatchObject({ reported: true, status: 'armed' });
    await h.emit('session_stop');
    expect({ shutdowns: h.shutdowns(), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({ shutdowns: 1, status: 'closed' });
  });

  it('remembers successful work across restart before assessing a newly merged checkout', async () => {
    const h = await host();
    await h.emit('tool_result', { toolName: 'bash' });
    h.plan.candidates[0].head = 'd'.repeat(40);
    h.plan.candidates[0].pr.headRefOid = 'd'.repeat(40);
    h.savePlan();
    finishExtension(h.api);
    await h.emit('session_start');
    expect(askInput(await h.emit('session_stop')).html).toContain('d'.repeat(40));
  });

  it('persists automatic assessment progress even when only another checkout merged', async () => {
    const h = await host();
    const other = tempDir('finish-new-merge-elsewhere');
    h.plan.candidates = [{ ...h.plan.candidates[0], path: other }];
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    const saved = h.entries.at(-1)?.data;
    expect({ failed: saved?.automaticCheckFailed }).toStrictEqual({ failed: false });
    expect(saved?.baselineMerged).toContain(`${other}:${'a'.repeat(40)}`);
    finishExtension(h.api);
    await h.emit('session_start');
    h.plan.current = other;
    h.savePlan();
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('offers a new current merge among old and unrelated merged candidates', async () => {
    const h = await host();
    const old = { ...h.plan.candidates[0], path: tempDir('finish-old-batch') };
    const unrelated = { ...old, head: 'e'.repeat(40), path: tempDir('finish-unrelated-batch') };
    h.plan.candidates.push(old);
    h.savePlan();
    h.entries.length = 0;
    await h.emit('session_start');
    h.plan.candidates = [{ ...h.plan.candidates[0], head: 'f'.repeat(40) }, old, unrelated];
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    const input = askInput(await h.emit('session_stop'));
    const [currentPreview = '', otherPreview = ''] = input.html.match(/<section>[\s\S]*?<\/section>/gu) ?? [];
    expect(currentPreview).toContain('f'.repeat(40));
    expect(otherPreview).toContain(unrelated.path);
  });

  it('records a failed assessment barrier before the process starts', async () => {
    const h = await host();
    const barriers: boolean[] = [];
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => {
      if (args[1] === 'plan') {
        barriers.push(h.entries.at(-1)?.data?.automaticCheckFailed === true);
        return { code: 1, killed: false, stderr: 'assessment interrupted', stdout: '' };
      }
      return await execute(command, args, options);
    };
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    expect(barriers).toStrictEqual([true]);
    expect(h.entries.at(-1)?.data).toMatchObject({ automaticCheckFailed: true, requested: false });
  });
});

describe('OMP persistence failure recovery', () => {
  it('invalidates a baseline installed by a later restore when the earlier startup assessment rejects', async () => {
    const h = await host();
    h.entries.length = 0;
    const execute = h.api.exec.bind(h.api);
    const checkpoints = new EventTarget();
    const entered = once(checkpoints, 'entered');
    let firstCheckout = true;
    h.api.exec = async (command, args, options) => {
      if (command === 'git' && firstCheckout) {
        firstCheckout = false;
        const failed = once(checkpoints, 'failed');
        checkpoints.dispatchEvent(new Event('entered'));
        await failed;
        throw new Error('earlier startup checkout failed');
      }
      return await execute(command, args, options);
    };
    const startup = h.emit('session_start');
    await entered;
    try {
      await h.emit('session_branch');
      expect(h.entries.at(-1)?.data?.baselineMerged).toStrictEqual([`${h.ctx.cwd}:${'a'.repeat(40)}`]);
    } finally {
      checkpoints.dispatchEvent(new Event('failed'));
      await startup;
    }
    expect(h.entries.at(-1)?.data?.baselineMerged).toBeUndefined();
    h.plan.candidates[0].head = 'c'.repeat(40);
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('recovers a single journal failure by persisting the completed assessment from the catch', async () => {
    const h = await host();
    h.plan.candidates[0].head = 'd'.repeat(40);
    h.plan.candidates[0].pr.headRefOid = 'd'.repeat(40);
    h.savePlan();
    await h.tool({ action: 'ready' });
    const append = h.api.appendEntry.bind(h.api);
    let failed = false;
    h.api.appendEntry = (customType, data) => {
      if (!failed && data.automaticCheckFailed === false && data.baselineMerged?.includes(`${h.ctx.cwd}:${'d'.repeat(40)}`) === true) {
        failed = true;
        throw new Error('journal write interrupted once');
      }
      append(customType, data);
    };
    const response = await h.emit('session_stop');
    expect(response?.additionalContext).toMatch(/journal write interrupted once/u);
    expect({ failed, saved: h.entries.at(-1)?.data?.automaticCheckFailed }).toStrictEqual({ failed: true, saved: false });
    expect(h.entries.at(-1)?.data?.baselineMerged).toContain(`${h.ctx.cwd}:${'d'.repeat(40)}`);
    finishExtension(h.api);
    await h.emit('session_start');
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });
});

describe('OMP public session journal contract', () => {
  it('publishes finish state under the journal type used by session-history consumers', async () => {
    const h = await host();
    await h.tool({ action: 'ready', owned: [h.ctx.cwd] });
    const saved = h.ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'tern-worktrees.finish')?.data;
    expect(saved).toMatchObject({ owned: [h.ctx.cwd], requested: true });
    expect(saved?.baselineMerged).toContain(`${h.ctx.cwd}:${'a'.repeat(40)}`);
  });

  it('preserves a recorded readiness declaration when restoring an already closed refusal', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'closed-refusal', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'none'),
      input,
      toolCallId: 'closed-refusal',
      toolName: 'ask',
    });
    await h.tool({ action: 'ready' });
    finishExtension(h.api);
    await h.emit('session_branch');
    expect(h.entries.at(-1)?.data).toMatchObject({ pending: { status: 'closed' }, requested: true });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(0);
  });
});

describe('OMP final residual state contracts', () => {
  it('records readiness without inventing a scope or an orchestration workflow', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const saved = h.entries.at(-1)?.data;
    expect({ orchestrate: saved?.orchestrate === true, scoped: saved?.scoped === true }).toStrictEqual({ orchestrate: false, scoped: false });
    expect(askInput(await h.emit('session_stop')).html).toContain('<input type="radio" name="tern-wt-finish:plan-1" value="none" checked');
  });

  it('recovers a missing baseline using only the actual merged paths and heads', async () => {
    const h = await host();
    h.entries.length = 0;
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => {
      if (command === 'git') {
        throw new Error('startup checkout unavailable');
      }
      return await execute(command, args, options);
    };
    await h.emit('session_start');
    expect(h.entries.at(-1)?.data?.baselineMerged).toBeUndefined();
    h.api.exec = execute;
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    expect(h.entries.at(-1)?.data?.baselineMerged).toStrictEqual([`${h.ctx.cwd}:${'a'.repeat(40)}`]);
  });

  it('recovers an interrupted report persistence before returning from the watcher', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'watcher-report', toolName: 'ask' });
    const append = h.api.appendEntry.bind(h.api);
    const execute = h.api.exec.bind(h.api);
    let interrupted = false;
    h.api.appendEntry = (customType, data) => {
      if (!interrupted && data.pending?.reported === true) {
        interrupted = true;
        throw new Error('report journal interrupted once');
      }
      append(customType, data);
    };
    h.api.exec = async (command, args, options) => {
      if (args[0] === 'ctl') {
        await h.emit('message_end', {
          message: { content: [{ text: 'Delivery report was sent while the watcher started.', type: 'text' }], role: 'assistant', stopReason: 'stop' },
        });
      }
      return await execute(command, args, options);
    };
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'watcher-report',
      toolName: 'ask',
    });
    expect({ interrupted, reported: h.entries.at(-1)?.data?.pending?.reported }).toStrictEqual({ interrupted: true, reported: true });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(1);
  });
});
