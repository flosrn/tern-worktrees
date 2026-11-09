import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import finishExtension from '../src/omp-finish.ts';
import { askInput, askReply, host } from './omp-finish-host.ts';
import { tempDir, ternLog } from './helpers.ts';

describe('OMP delivery finish', () => {
  it('blocks a destructive HTML default before the real ask executes', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    input.html = input.html.replace('value="none" checked', 'value="none"').replace('value="current"', 'value="current" checked');
    const called = await h.emit('tool_call', { input, toolCallId: 'ask-1', toolName: 'ask' });
    expect(called?.block).toBeTruthy();
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-1',
      toolName: 'ask',
    });
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
    expect(h.shutdowns()).toBe(0);
  });

  it('arms only the approved saved plan, then waits for a final report before shutdown', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    await h.emit('tool_call', { input, toolCallId: 'ask-1', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'merged'),
      input,
      toolCallId: 'ask-1',
      toolName: 'ask',
    });
    expect({
      arms: h.calls().filter(args => args[1] === 'arm'),
      reported: h.entries.at(-1)?.data?.pending?.reported === true,
      shutdowns: h.shutdowns(),
      status: h.entries.at(-1)?.data?.pending?.status,
    }).toStrictEqual({
      arms: [['finish', 'arm', 'plan-1', '--choice', 'merged', '--selected', h.ctx.cwd]],
      reported: false,
      shutdowns: 0,
      status: 'armed',
    });
    const missingReport = await h.emit('session_stop');
    expect(missingReport?.continue).toBeTruthy();
    expect(h.shutdowns()).toBe(0);
    await h.emit('message_end', { message: { content: [{ text: 'Livraison terminée. Nettoyage approuvé après sortie.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(1);
  });

  it('keeps orchestration workers silent even if their session later calls ready', async () => {
    const h = await host();
    await h.emit('before_agent_start', {
      prompt: "/skill:implement-ticket\nImplement ticket 42.\n\n<dispatch>\nThis worker is assigned by the user's explicit `orchestrate` invocation.\n</dispatch>",
      reason: 'prompt',
    });
    await h.tool({ action: 'ready' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
  });

  it('does not offer teardown through an extension impersonating the native ask tool', async () => {
    const h = await host();
    h.api.getAllTools = () => [{ name: 'ask', sourceInfo: { path: '/fake/ask.ts', source: 'extension' } }];
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(String(stop?.additionalContext)).not.toContain('"html":');
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
  });

  it('persists an explicit refusal so a resumed session cannot ask or arm the same delivery again', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    await h.emit('tool_call', { input, toolCallId: 'ask-none', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'none'),
      input,
      toolCallId: 'ask-none',
      toolName: 'ask',
    });
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([['finish', 'arm', 'plan-1', '--choice', 'none']]);
    finishExtension(h.api);
    await h.emit('session_start');
    await h.tool({ action: 'ready' });
    const resumed = await h.emit('session_stop');
    expect(String(resumed?.additionalContext)).not.toContain('"html":');
    expect(h.shutdowns()).toBe(0);
  });

  it('passes retained lanes as exclusions even when they are merged and otherwise removable', async () => {
    const h = await host();
    const done = tempDir('finish-done');
    const parked = tempDir('finish-parked');
    const alsoParked = tempDir('finish-also-parked');
    await h.tool({ action: 'scope', owned: [done, parked], retained: [parked], workflow: 'orchestrate' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await h.tool({ action: 'ready', retained: [alsoParked] });
    await h.emit('session_stop');
    const plans = h.calls().filter(args => args[1] === 'plan');
    expect(plans.at(-1)).toStrictEqual(expect.arrayContaining(['--exclude', parked, '--exclude', alsoParked]));
    const none = await h.emit('session_stop');
    expect(String(none?.additionalContext)).not.toContain('"html":');
  });

  it('automatically offers after this session ships an unchanged prepared HEAD, but not an old merged checkout', async () => {
    const h = await host();
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    h.plan.candidates = [];
    h.plan.ready = false;
    h.savePlan();
    h.entries.length = 0;
    await h.emit('session_start');
    await h.emit('tool_result', { input: { command: 'deliver' }, isError: false, toolCallId: 'ship-pr', toolName: 'bash' });
    h.plan.candidates = [
      {
        branch: 'feature/one',
        head: 'a'.repeat(40),
        path: h.ctx.cwd,
        pr: { headRefOid: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), mergedAt: '2026-11-09T00:00:00Z', number: 42, url: 'https://github.com/test/repo/pull/42' },
      },
    ];
    h.plan.ready = true;
    h.savePlan();
    const stop = await h.emit('session_stop');
    expect(stop?.continue).toBeTruthy();
    expect(askInput(stop).html).toContain(`name="tern-wt-finish:${h.plan.id}"`);
  });
});

describe('OMP finish safety', () => {
  it.each(['running job', 'queued delivery', 'active delivery', 'pending delivery', 'pending message'])('waits for %s independently before shutdown', async active => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'ask-jobs', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-jobs',
      toolName: 'ask',
    });
    await h.emit('message_end', { message: { content: [{ text: 'Delivered.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    h.ctx.getAsyncJobSnapshot = () => ({
      delivery: { delivering: active === 'active delivery', pendingJobIds: active === 'pending delivery' ? ['bg_1'] : [], queued: active === 'queued delivery' ? 1 : 0 },
      recent: [],
      running: active === 'running job' ? [{ id: 'bg_1' }] : [],
    });
    h.ctx.hasPendingMessages = () => active === 'pending message';
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(0);
    h.ctx.getAsyncJobSnapshot = () => ({ delivery: { delivering: false, pendingJobIds: [], queued: 0 }, recent: [{ id: 'bg_1' }], running: [] });
    h.ctx.hasPendingMessages = () => false;
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(1);
  });

  it('leaves unrelated ask forms untouched while a finish plan is pending', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    const other = {
      html: '<form id="another-question" name="another-question"><label><input type="radio" name="another-question" value="yes" checked>Yes</label><label><input type="radio" name="another-question" value="no">No</label></form>',
    };
    await expect(h.emit('tool_call', { input: other, toolCallId: 'other', toolName: 'ask' })).resolves.toBeUndefined();
    await h.emit('tool_result', {
      content: [{ text: 'User answers:\n{"another-question":"yes"}', type: 'text' }],
      details: { answers: [{ answer: 'Yes', name: 'another-question', question: 'Continue?' }] },
      input: other,
      isError: false,
      toolCallId: 'other',
      toolName: 'ask',
    });
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
  });

  it('does not exit or claim teardown when the CLI cannot start the external worker', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    await h.emit('tool_call', { input, toolCallId: 'ask-error', toolName: 'ask' });
    h.failArm();
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-error',
      toolName: 'ask',
    });
    expect(h.entries.at(-1)?.data?.pending?.status).toBe('closed');
    await h.emit('message_end', { message: { content: [{ text: 'Teardown failed; tab kept.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(0);
  });

  it('pins the actual Tern caller block in every plan', async () => {
    const h = await host();
    vi.stubEnv('TERN_PANE', '420');
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    expect(h.calls().findLast(args => args[1] === 'plan')).toStrictEqual(expect.arrayContaining(['--block', '420']));
  });

  it('starts the window notification watcher before requesting shutdown', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    await h.emit('tool_call', { input, toolCallId: 'ask-watch', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-watch',
      toolName: 'ask',
    });
    expect(ternLog()).toContain('ctl plugins run plugin.tern-worktrees.finish-watch');
    expect(h.shutdowns()).toBe(0);
  });

  it('keeps the caller alive if the arm response widens the approved saved target set', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    await h.emit('tool_call', { input, toolCallId: 'ask-wide', toolName: 'ask' });
    h.respond({ id: h.plan.id, selected: [h.ctx.cwd, '/work/unapproved'], status: 'armed' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-wide',
      toolName: 'ask',
    });
    expect(h.entries.at(-1)?.data?.pending?.status).toBe('closed');
    await h.emit('message_end', { message: { content: [{ text: 'Final report.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(0);
  });

  it('does not shut down a main-checkout coordinator whose approved targets are elsewhere', async () => {
    const h = await host();
    const target = tempDir('finish-coordinator-target');
    h.plan.current = null;
    h.plan.candidates[0].path = target;
    h.savePlan();
    await h.tool({ action: 'ready', owned: [target], workflow: 'orchestrate' });
    const stop = await h.emit('session_stop');

    const input = askInput(stop);
    await h.emit('tool_call', { input, toolCallId: 'ask-coordinator', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-coordinator',
      toolName: 'ask',
    });
    await h.emit('message_end', { message: { content: [{ text: 'Run completed.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([['finish', 'arm', 'plan-1', '--choice', 'current', '--selected', target]]);
    expect(h.shutdowns()).toBe(0);
  });

  it('defers automatic finish for every explicitly scoped multi-delivery run until ready', async () => {
    const h = await host();
    h.plan.candidates = [];
    h.plan.ready = false;
    h.savePlan();
    h.entries.length = 0;
    await h.emit('session_start');
    await h.tool({ action: 'scope', owned: [h.ctx.cwd] });
    await h.emit('tool_result', { isError: false, toolCallId: 'ship-first', toolName: 'bash' });
    h.plan.candidates = [
      {
        branch: 'feature/one',
        head: 'a'.repeat(40),
        path: h.ctx.cwd,
        pr: { headRefOid: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), mergedAt: '2026-11-09T00:00:00Z', number: 42, url: 'https://github.com/test/repo/pull/42' },
      },
    ];
    h.plan.ready = true;
    h.savePlan();
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(askInput(stop).html).toContain(`name="tern-wt-finish:${h.plan.id}"`);
  });

  it('uses the checkout top level as current when the session starts in a subdirectory', async () => {
    const h = await host();
    const top = h.ctx.cwd;
    h.ctx.cwd = path.join(top, 'nested');
    mkdirSync(h.ctx.cwd);
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    const args = h.calls().findLast(call => call[1] === 'plan') ?? [];
    expect(args[args.indexOf('--current') + 1]).toBe(top);
  });

  it('shows an owned symlink target canonically and arms only the frozen current-only preview', async () => {
    const h = await host();
    const target = tempDir('finish-owned-target');
    const other = tempDir('finish-other-target');
    const alias = path.join(tempDir('finish-owned-alias'), 'owned');
    symlinkSync(target, alias);
    const [candidate] = h.plan.candidates;
    h.plan.current = null;
    h.plan.candidates = [
      { ...candidate, path: target },
      { ...candidate, path: other },
    ];
    h.savePlan();
    await expect(h.tool({ action: 'scope', owned: [alias], workflow: 'orchestrate' })).resolves.toMatchObject({ details: { owned: [target] }, isError: false });
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const [currentPreview = '', otherPreview = ''] = input.html.match(/<section>[\s\S]*?<\/section>/gu) ?? [];
    expect({
      current: [currentPreview.includes(target), currentPreview.includes(alias), currentPreview.includes(other)],
      mergedHasOther: otherPreview.includes(other),
      planHasTarget: h
        .calls()
        .findLast(call => call[1] === 'plan')
        ?.includes(target),
    }).toStrictEqual({ current: [true, false, false], mergedHasOther: true, planHasTarget: true });
    await h.tool({ action: 'scope', owned: [other] });
    await h.emit('tool_call', { input, toolCallId: 'owned-alias', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'owned-alias',
      toolName: 'ask',
    });
    expect(h.entries.at(-1)?.data?.pending?.status).toBe('armed');
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([['finish', 'arm', 'plan-1', '--choice', 'current', '--selected', target]]);
    await h.emit('message_end', { message: { content: [{ text: 'Run delivered.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(0);
  });

  it('passes retained symlink targets canonically as exclusions without selecting them', async () => {
    const h = await host();
    const retained = tempDir('finish-retained-target');
    const alias = path.join(tempDir('finish-retained-alias'), 'retained');
    symlinkSync(retained, alias);
    h.plan.candidates.push({ ...h.plan.candidates[0], path: retained });
    h.savePlan();
    await h.tool({ action: 'scope', owned: [h.ctx.cwd], retained: [alias] });
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const keptPreview = input.html.match(/<section>[\s\S]*?<\/section>/gu)?.[2] ?? '';
    expect(keptPreview).toContain(retained);
    expect(keptPreview).toContain('retained');
    expect(h.calls().findLast(call => call[1] === 'plan')).toStrictEqual(expect.arrayContaining(['--exclude', retained]));
    await h.emit('tool_call', { input, toolCallId: 'retained-alias', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'merged'),
      input,
      toolCallId: 'retained-alias',
      toolName: 'ask',
    });
    expect(h.entries.at(-1)?.data?.pending?.status).toBe('armed');
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([['finish', 'arm', 'plan-1', '--choice', 'merged', '--selected', h.ctx.cwd]]);
  });

  it('sends every merged-preview target and no owned-only subset when the user approves all merged PRs', async () => {
    const h = await host();
    const other = tempDir('finish-merged-other');
    h.plan.candidates.push({ ...h.plan.candidates[0], path: other });
    h.savePlan();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const [currentPreview = '', otherPreview = ''] = input.html.match(/<section>[\s\S]*?<\/section>/gu) ?? [];
    expect({
      current: [currentPreview.includes(h.ctx.cwd), currentPreview.includes(other)],
      other: [otherPreview.includes(other), otherPreview.includes(h.ctx.cwd)],
      otherOccurrences: input.html.split(other).length,
    }).toStrictEqual({ current: [true, false], other: [true, false], otherOccurrences: 2 });
    await h.emit('tool_call', { input, toolCallId: 'merged-selection', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'merged'),
      input,
      toolCallId: 'merged-selection',
      toolName: 'ask',
    });
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({
      arms: [['finish', 'arm', 'plan-1', '--choice', 'merged', '--selected', h.ctx.cwd, '--selected', other]],
      status: 'armed',
    });
  });
});
