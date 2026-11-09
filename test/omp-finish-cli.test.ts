import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import finishExtension from '../src/omp-finish.ts';
import { askInput, askReply, host } from './omp-finish-host.ts';

describe('OMP CLI response boundaries', () => {
  it.each([
    { error: 'Invalid finish plan identifier', field: 'id', omitted: true, value: 0 },
    { error: 'Invalid finish plan identifier', field: 'id', omitted: false, value: 7 },
    { error: 'Invalid finish plan response', field: 'candidates', omitted: true, value: 0 },
    { error: 'Invalid finish plan response', field: 'candidates', omitted: false, value: {} },
  ])('rejects a malformed plan $field before using its other valid fields: $value', async ({ error, field, omitted, value }) => {
    const h = await host();
    const output = { ...h.plan, [field]: value };
    if (omitted) {
      Reflect.deleteProperty(output, field);
    }
    writeFileSync(h.binary, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    await h.tool({ action: 'ready' });
    const response = await h.emit('session_stop');
    expect(response?.additionalContext).toContain(error);
    expect(response?.additionalContext).not.toContain('<form');
    expect(h.shutdowns()).toBe(0);
  });

  it.each([
    { error: 'Invalid finish arm identifier', field: 'id', omitted: true, value: 0 },
    { error: 'Invalid finish arm identifier', field: 'id', omitted: false, value: 7 },
    { error: 'Invalid finish arm response', field: 'id', omitted: false, value: 'another-plan' },
    { error: 'Invalid finish arm response', field: 'selected', omitted: true, value: 0 },
    { error: 'Invalid finish arm response', field: 'selected', omitted: false, value: {} },
    { error: 'Invalid finish arm response', field: 'status', omitted: false, value: 'declined' },
  ])('rejects a malformed arm $field with the otherwise approved target set: $value', async ({ error, field, omitted, value }) => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'envelope', toolName: 'ask' });
    const output = { id: h.plan.id, selected: [h.ctx.cwd], status: 'armed', [field]: value };
    if (omitted) {
      Reflect.deleteProperty(output, field);
    }
    writeFileSync(h.binary, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'envelope',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain(error);
    await h.emit('message_end', { message: { content: [{ text: 'Arm rejected; keep all worktrees.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(0);
  });

  it('requires a declined backend status even when the refusal selects no targets', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'refusal-status', toolName: 'ask' });
    h.respond({ id: h.plan.id, selected: [], status: 'armed' });
    const response = await h.emit('tool_result', {
      ...askReply(input, 'none'),
      input,
      toolCallId: 'refusal-status',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toContain('Invalid finish arm response');
    expect(h.shutdowns()).toBe(0);
  });
});

describe('OMP null CLI envelopes', () => {
  it('reports a null plan as an invalid CLI identifier instead of exposing a property-access failure', async () => {
    const h = await host();
    writeFileSync(h.binary, "process.stdout.write('null');");
    await h.tool({ action: 'ready' });
    const response = await h.emit('session_stop');
    expect(response?.additionalContext).toMatch(/Error: Invalid.*plan.*identifier/u);
    expect(response?.additionalContext).not.toContain('TypeError');
    expect({ hasPending: h.entries.at(-1)?.data?.pending !== undefined, shutdowns: h.shutdowns() }).toStrictEqual({ hasPending: false, shutdowns: 0 });
  });

  it('reports a null arm as an invalid CLI identifier and durably closes the consent', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'null-arm', toolName: 'ask' });
    writeFileSync(h.binary, "process.stdout.write('null');");
    const response = await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'null-arm',
      toolName: 'ask',
    });
    expect(response?.additionalContext).toMatch(/Error: Invalid.*arm.*identifier/u);
    expect(response?.additionalContext).not.toContain('TypeError');
    expect({ shutdowns: h.shutdowns(), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({ shutdowns: 0, status: 'closed' });
  });
});

describe('OMP registered tool contract', () => {
  it('publishes an essential tool with the supported action and workflow schemas', async () => {
    const h = await host();
    const schema = h.api.zod.string();
    const enumerations: string[][] = [];
    const properties: string[][] = [];
    h.api.zod.enum = values => {
      enumerations.push(values);
      return schema;
    };
    h.api.zod.object = fields => {
      properties.push(Object.keys(fields).toSorted());
      return schema;
    };
    finishExtension(h.api);
    const tool = h.tools.get('worktree_finish');
    expect(tool?.loadMode).toBe('essential');
    expect(properties).toStrictEqual([['action', 'owned', 'retained', 'workflow']]);
    expect(enumerations).toStrictEqual([['scope', 'ready'], ['orchestrate']]);
  });
});
