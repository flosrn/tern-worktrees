import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vite-plus/test';
import finishExtension from '../src/omp-finish.ts';
import type { FinishEvent } from '../src/omp-finish-types.ts';
import { askInput, askReply, host } from './omp-finish-host.ts';
import { invalidNativeAnswers } from './omp-finish-errors-cases.ts';
import { tempDir } from './helpers.ts';

describe('OMP finish assessment and consent errors', () => {
  it.each([{}, { id: 'invalid-plan' }, 'not a plan'])('keeps worktrees when the CLI plan envelope is invalid: %j', async output => {
    const h = await host();
    h.respond(output);
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(stop?.additionalContext).toContain('Finish check failed');
    expect(h.shutdowns()).toBe(0);
  });

  it('reports unavailable git and a failed startup baseline without offering consent', async () => {
    const h = await host();
    h.entries.length = 0;
    h.ctx.cwd = '/does-not-exist';
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(stop?.additionalContext).toContain('Cannot resolve');
    expect(h.shutdowns()).toBe(0);
  });

  it('keeps an unchanged already merged delivery after actual tools have run', async () => {
    const h = await host();
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('reports CI not ready without asking repeatedly for explicit ready', async () => {
    const h = await host();
    h.plan.ready = false;
    h.savePlan();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(stop?.additionalContext).toContain('not ready');
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('restores an interrupted native ask as closed rather than replaying its consent', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'interrupted', toolName: 'ask' });
    finishExtension(h.api);
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await expect(h.emit('tool_call', { input, toolCallId: 'duplicate', toolName: 'ask' })).resolves.toMatchObject({ block: true });
  });

  it('blocks a native ask replacement that appears after the plan was offered', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    h.api.getAllTools = () => [];
    await expect(h.emit('tool_call', { input, toolCallId: 'replaced', toolName: 'ask' })).resolves.toMatchObject({ block: true });
  });

  it.each([{}, { id: 'plan-1' }, { id: 'another-plan', selected: [], status: 'armed' }])('keeps caller alive after invalid arm envelope %j', async output => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'arm-invalid', toolName: 'ask' });
    h.respond(output);
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'arm-invalid',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain('Finish arm failed');
    expect(h.shutdowns()).toBe(0);
  });

  it.each(invalidNativeAnswers)('rejects an otherwise valid native answer with $label', async ({ mutate }) => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'bad-result', toolName: 'ask' });
    const event: FinishEvent = { ...askReply(input, 'current'), input, toolCallId: 'bad-result', toolName: 'ask' };
    mutate(event, `tern-wt-finish:${h.plan.id}`);
    const response = await h.emit('tool_result', event);
    expect(response?.additionalContext).toContain('No explicit finish consent');
    await h.emit('tool_result', { ...askReply(input, 'current'), input, toolCallId: 'bad-result', toolName: 'ask' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns() }).toStrictEqual({ arms: [], shutdowns: 0 });
  });

  it('does not arm when a frozen approved target is retained after its preview', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.tool({ action: 'scope', retained: [h.ctx.cwd] });
    await h.emit('tool_call', { input, toolCallId: 'parked', toolName: 'ask' });
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'parked',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain('Retained finish target');
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([]);
  });
});

describe('OMP finish host and final report errors', () => {
  it('ignores native subagent lifecycle and pending messages', async () => {
    const h = await host();
    h.ctx.agent = { kind: 'task' };
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    h.ctx.agent = { kind: 'main' };
    h.ctx.hasPendingMessages = () => true;
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('passes through a malformed unrelated ask and rejects invalid finish tool action', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    await expect(h.emit('tool_call', { input: {}, toolName: 'ask' })).resolves.toBeUndefined();
    await expect(h.tool({ action: 'remove' })).resolves.toMatchObject({ isError: true });
    await h.emit('before_agent_start');
  });

  it('does not send invalid or missing Tern block values to the backend', async () => {
    const h = await host();
    vi.stubEnv('TERN_PANE', undefined);
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    expect(h.calls().findLast(call => call[1] === 'plan')).not.toContain('--block');
  });

  it.each([
    { content: [{ text: 'Not an assistant report.', type: 'text' }], role: 'user', stopReason: 'stop' },
    { content: [{ text: 'Still executing tools.', type: 'text' }], role: 'assistant', stopReason: 'toolUse' },
    { content: [{ text: 'Private reasoning is not the delivery report.', type: 'thinking' }], role: 'assistant', stopReason: 'stop' },
    { content: [{ text: ' \n\t ', type: 'text' }], role: 'assistant', stopReason: 'stop' },
    { role: 'assistant', stopReason: 'stop' },
    undefined,
  ])('requires a delivered assistant text report before shutdown: %j', async message => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'report', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'report',
      toolName: 'ask',
    });
    await h.emit('message_end', { message });
    const stop = await h.emit('session_stop');
    expect(stop?.additionalContext).toContain('final delivery report');
    expect({ continue: stop?.continue, shutdowns: h.shutdowns() }).toStrictEqual({ continue: true, shutdowns: 0 });
    await h.emit('message_end', {
      message: { content: [{ type: 'thinking' }, { text: 'Delivered to the user.', type: 'text' }], role: 'assistant', stopReason: 'stop' },
    });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(1);
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(1);
  });

  it('fails closed if native ask attribution changes after the actual question', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'changed-source', toolName: 'ask' });
    h.api.getAllTools = () => [];
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'changed-source',
      toolName: 'ask',
    });
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([]);
  });

  it('ignores unrelated persisted entries when restoring the extension state', async () => {
    const h = await host();
    h.entries.push({ customType: 'other.extension', type: 'custom' }, { type: 'message' });
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(stop?.continue).toBeTruthy();
  });

  it.each(['worker could not notify', ''])('warns but keeps the saved arm when Tern notification fails: %s', async stderr => {
    const h = await host();
    const warnings: string[] = [];
    h.ctx.ui = {
      notify: message => {
        warnings.push(message);
      },
    };
    const binary = `${h.ctx.cwd}/tern-notify-failure.cjs`;
    writeFileSync(binary, `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exitCode=1;`, { mode: 0o755 });
    vi.stubEnv('TERN_BIN', binary);
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'notify-fail', toolName: 'ask' });
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'notify-fail',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain('armed');
    expect(warnings).toHaveLength(1);
  });

  it('reports an empty-stderr CLI failure honestly without shutting down', async () => {
    const h = await host();
    writeFileSync(h.binary, 'process.exitCode=1;');
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(stop?.additionalContext).toContain('tern-wt finish failed');
  });
});

describe('OMP finish durable retry and scope errors', () => {
  it.each(['ask unavailable', 'CI pending', 'CLI error'])('bounds automatic finish fallback across successive stops and restart: %s', async failure => {
    const h = await host();
    h.plan.candidates = [];
    h.plan.ready = false;
    h.savePlan();
    h.entries.length = 0;
    await h.emit('session_start');
    h.plan.candidates = [
      {
        branch: 'feature/new',
        head: 'c'.repeat(40),
        path: h.ctx.cwd,
        pr: { headRefOid: 'c'.repeat(40), mergeCommit: 'd'.repeat(40), mergedAt: '2026-11-09T00:00:00Z', number: 43, url: 'https://github.com/test/repo/pull/43' },
      },
    ];
    h.plan.ready = failure !== 'CI pending';
    h.savePlan();
    const cli = readFileSync(h.binary, 'utf-8');
    await h.emit('tool_result', { toolName: 'bash' });
    if (failure === 'ask unavailable') {
      h.api.getActiveTools = () => [];
    }
    if (failure === 'CLI error') {
      h.failArm();
    }
    const stop = await h.emit('session_stop');
    expect(stop?.continue).toBeTruthy();
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    writeFileSync(h.binary, cli);
    h.api.getActiveTools = () => ['ask', 'worktree_finish'];
    h.plan.ready = true;
    h.savePlan();
    finishExtension(h.api);
    await h.emit('session_start');
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await h.tool({ action: 'ready' });
    expect(askInput(await h.emit('session_stop')).html).toContain(h.ctx.cwd);
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([]);
  });

  it('checks a new automatic merge before warning that ask is unavailable', async () => {
    const h = await host();
    h.api.getActiveTools = () => [];
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('consumes a failed automatic CI assessment until a different merge or explicit readiness', async () => {
    const h = await host();
    const [candidate] = h.plan.candidates;
    h.plan.candidates = [];
    h.savePlan();
    h.entries.length = 0;
    await h.emit('session_start');
    h.plan.candidates = [candidate];
    h.plan.ready = false;
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    const stop = await h.emit('session_stop');
    expect(stop?.additionalContext).toContain('not ready');
    h.plan.ready = true;
    h.savePlan();
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    h.plan.candidates = [{ ...candidate, head: 'e'.repeat(40), pr: { ...candidate.pr, headRefOid: 'e'.repeat(40) } }];
    h.savePlan();
    expect(askInput(await h.emit('session_stop')).html).toContain('e'.repeat(40));
  });

  it('closes restored consent without frozen selections instead of rebuilding approval from the scope', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const pending = h.entries.at(-1)?.data?.pending;
    expect(pending).toBeDefined();
    if (pending !== undefined) {
      Reflect.deleteProperty(pending, 'approved');
    }
    finishExtension(h.api);
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await expect(h.emit('tool_call', { input, toolCallId: 'legacy', toolName: 'ask' })).resolves.toMatchObject({ block: true });
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([]);
  });

  it('keeps the recorded scope when another scope path cannot be canonicalized', async () => {
    const h = await host();
    await h.tool({ action: 'scope', owned: [h.ctx.cwd] });
    await expect(h.tool({ action: 'scope', owned: [`${h.ctx.cwd}/missing`] })).resolves.toMatchObject({ isError: true });
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    expect(input.html).toContain(h.ctx.cwd);
    expect(h.calls().findLast(call => call[1] === 'plan')).toStrictEqual(expect.arrayContaining(['--owned', h.ctx.cwd]));
  });

  it('allows explicit readiness and fresh consent after the startup assessment failed', async () => {
    const h = await host();
    const checkout = h.ctx.cwd;
    h.entries.length = 0;
    h.ctx.cwd = '/does-not-exist';
    await h.emit('session_start');
    h.ctx.cwd = checkout;
    await h.emit('tool_result', { toolName: 'bash' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    expect(input.html).toContain(checkout);
    await h.emit('tool_call', { input, toolCallId: 'startup-recovered', toolName: 'ask' });
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'startup-recovered',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain('teardown is armed');
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns() }).toStrictEqual({
      arms: [['finish', 'arm', 'plan-1', '--choice', 'current', '--selected', checkout]],
      shutdowns: 0,
    });
    await h.emit('message_end', { message: { content: [{ text: 'Delivery completed after the startup check recovered.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(1);
  });

  it('keeps the caller alive when an approved target is retained while the arm process is running', async () => {
    const h = await host();
    const other = tempDir('finish-retained-mixed');
    h.plan.candidates.push({ ...h.plan.candidates[0], path: other });
    h.savePlan();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'retained-during-arm', toolName: 'ask' });
    const execute = h.api.exec.bind(h.api);
    h.api.exec = async (command, args, options) => {
      const output = execute(command, args, options);
      if (command.endsWith('/bin/tern-wt') && args[1] === 'arm') {
        await h.tool({ action: 'scope', retained: [h.ctx.cwd] });
      }
      return await output;
    };
    const response = await h.emit('tool_result', {
      ...askReply(input, 'merged'),
      input,
      toolCallId: 'retained-during-arm',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain('Retained finish target');
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([['finish', 'arm', 'plan-1', '--choice', 'merged', '--selected', h.ctx.cwd, '--selected', other]]);
    await h.emit('message_end', {
      message: { content: [{ text: 'Caller kept because the target was retained during arming.', type: 'text' }], role: 'assistant', stopReason: 'stop' },
    });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(0);
  });
});
