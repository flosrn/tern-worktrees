import { describe, expect, it } from 'vite-plus/test';
import type { FinishEvent } from '../src/omp-finish-types.ts';
import { askInput, askReply, host } from './omp-finish-host.ts';
import { tempDir } from './helpers.ts';

const currentLabel = 'Supprimer seulement mes worktrees';
const mergedLabel = 'Supprimer aussi les autres PR fusionnées du dépôt';
const noneLabel = 'Ne rien supprimer';
const legend = 'La livraison est terminée. Quels worktrees souhaitez-vous supprimer après le bilan final ?';

describe('OMP native HTML consent', () => {
  it('arms the immutable selection from the native HTML form reply', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const pending = h.entries.at(-1)?.data?.pending;
    expect(input.html).toContain('<form id="tern-wt-finish:plan-1" name="tern-wt-finish:plan-1">');
    expect(input.html).toContain('<input type="radio" name="tern-wt-finish:plan-1" value="none" checked');
    await expect(h.emit('tool_call', { input, toolCallId: 'html-native-current', toolName: 'ask' })).resolves.toBeUndefined();
    await h.emit('tool_result', {
      content: [{ text: 'User answers:\n{\n  "tern-wt-finish:plan-1": "current"\n}', type: 'text' }],
      details: { answers: [{ answer: currentLabel, name: 'tern-wt-finish:plan-1', question: legend }] },
      input,
      isError: false,
      toolCallId: 'html-native-current',
      toolName: 'ask',
    });
    expect({
      approved: pending?.approved.current,
      arms: h.calls().filter(call => call[1] === 'arm'),
      shutdowns: h.shutdowns(),
      status: h.entries.at(-1)?.data?.pending?.status,
    }).toStrictEqual({
      approved: [h.ctx.cwd],
      arms: [['finish', 'arm', 'plan-1', '--choice', 'current', '--selected', h.ctx.cwd]],
      shutdowns: 0,
      status: 'armed',
    });
  });
});

describe('OMP native ask identity', () => {
  it.each([
    { name: 'another built-in tool', tools: [{ name: 'read', sourceInfo: { path: '<builtin:ask>', source: 'builtin' } }] },
    { name: 'extension source at the built-in path', tools: [{ name: 'ask', sourceInfo: { path: '<builtin:ask>', source: 'extension' } }] },
    { name: 'built-in source at another path', tools: [{ name: 'ask', sourceInfo: { path: '<builtin:read>', source: 'builtin' } }] },
    { name: 'missing source attribution', tools: [{ name: 'ask' }] },
  ])('requires every native identity field when offering: $name', async ({ tools }) => {
    const h = await host();
    h.api.getAllTools = () => tools;
    await h.tool({ action: 'ready' });
    await h.emit('session_stop');
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), pendingAbsent: h.entries.at(-1)?.data?.pending === undefined, shutdowns: h.shutdowns() }).toStrictEqual({
      arms: [],
      pendingAbsent: true,
      shutdowns: 0,
    });
  });

  it.each([
    { name: 'name', tools: [{ name: 'read', sourceInfo: { path: '<builtin:ask>', source: 'builtin' } }] },
    { name: 'source', tools: [{ name: 'ask', sourceInfo: { path: '<builtin:ask>', source: 'extension' } }] },
    { name: 'path', tools: [{ name: 'ask', sourceInfo: { path: '<builtin:read>', source: 'builtin' } }] },
  ])('permanently closes an offer when identity changes in $name before invoking ask', async ({ tools }) => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    h.api.getAllTools = () => tools;
    await expect(h.emit('tool_call', { input, toolCallId: 'identity-call', toolName: 'ask' })).resolves.toMatchObject({ block: true });
    h.api.getAllTools = () => [{ name: 'ask', sourceInfo: { path: '<builtin:ask>', source: 'builtin' } }];
    await expect(h.emit('tool_call', { input, toolCallId: 'identity-retry', toolName: 'ask' })).resolves.toMatchObject({ block: true });
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({ arms: [], status: 'closed' });
  });

  it.each([
    { name: 'name', tools: [{ name: 'read', sourceInfo: { path: '<builtin:ask>', source: 'builtin' } }] },
    { name: 'source', tools: [{ name: 'ask', sourceInfo: { path: '<builtin:ask>', source: 'extension' } }] },
    { name: 'path', tools: [{ name: 'ask', sourceInfo: { path: '<builtin:read>', source: 'builtin' } }] },
  ])('rejects an identity change in $name while native ask is running', async ({ tools }) => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'identity-result', toolName: 'ask' });
    h.api.getAllTools = () => tools;
    await h.emit('tool_result', { ...askReply(input), input, toolCallId: 'identity-result', toolName: 'ask' });
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns(), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({
      arms: [],
      shutdowns: 0,
      status: 'closed',
    });
  });
});

describe('OMP HTML consent presentation', () => {
  it('shows each immutable target once with three semantic radios and a safe default', async () => {
    const h = await host();
    const other = tempDir(`finish-html-other-${'long-path-'.repeat(12)}`);
    h.plan.candidates.push({ ...h.plan.candidates[0], path: other });
    h.savePlan();
    await h.tool({ action: 'ready' });
    const { html } = askInput(await h.emit('session_stop'));
    expect(html).toContain('<form id="tern-wt-finish:plan-1" name="tern-wt-finish:plan-1">');
    expect([...html.matchAll(/<input\b[^>]*>/gu)].map(match => match[0])).toStrictEqual([
      '<input type="radio" name="tern-wt-finish:plan-1" value="current" aria-describedby="tern-wt-finish:plan-1:current-scope">',
      '<input type="radio" name="tern-wt-finish:plan-1" value="merged" aria-describedby="tern-wt-finish:plan-1:merged-scope">',
      '<input type="radio" name="tern-wt-finish:plan-1" value="none" checked aria-describedby="tern-wt-finish:plan-1:none-scope">',
    ]);
    expect(html).not.toMatch(/<(?:script|style|button)\b|\s(?:style|on\w+)=/iu);
    expect({
      approved: h.entries.at(-1)?.data?.pending?.approved,
      currentOccurrences: html.split(h.ctx.cwd).length - 1,
      forms: html.match(/<form\b/gu)?.length,
      otherOccurrences: html.split(other).length - 1,
    }).toStrictEqual({
      approved: { current: [h.ctx.cwd], merged: [h.ctx.cwd, other], none: [] },
      currentOccurrences: 1,
      forms: 1,
      otherOccurrences: 1,
    });
    expect([...html.matchAll(/<p>(?<text>.*?)<\/p>/gu)].map(match => match.groups?.text)).toStrictEqual(
      expect.arrayContaining([h.ctx.cwd, other, 'PR #42 https://github.com/test/repo/pull/42', `HEAD ${'a'.repeat(40)}`, `PR HEAD ${'a'.repeat(40)}`]),
    );
  });

  it('escapes every dynamic HTML metacharacter in paths, PR proof, keep causes and warnings', async () => {
    const h = await host();
    const unsafe = '/work/<tag a="x">\'&';
    h.plan.current = unsafe;
    h.plan.candidates[0] = {
      ...h.plan.candidates[0],
      head: '<head>&"\'',
      path: unsafe,
      pr: { ...h.plan.candidates[0].pr, headRefOid: '<pr>&"\'', url: 'https://example.test/?a="<&\'' },
    };
    h.plan.keep = [{ code: 'inspection_failed', detail: '<error a="x">\'&', path: `${unsafe}/kept` }];
    h.plan.warnings = ['<warning a="x">\'&'];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const { html } = askInput(await h.emit('session_stop'));
    const escapedFragments = [
      '<p>/work/&lt;tag a=&quot;x&quot;&gt;&#39;&amp;</p>',
      '<p>HEAD &lt;head&gt;&amp;&quot;&#39;</p>',
      '<p>PR HEAD &lt;pr&gt;&amp;&quot;&#39;</p>',
      '<p>PR #42 https://example.test/?a=&quot;&lt;&amp;&#39;</p>',
      '<p>/work/&lt;tag a=&quot;x&quot;&gt;&#39;&amp;/kept</p>\n<p>inspection_failed</p>\n<p>&lt;error a=&quot;x&quot;&gt;&#39;&amp;</p>',
      '<p>&lt;warning a=&quot;x&quot;&gt;&#39;&amp;</p>',
    ];
    expect(escapedFragments.filter(fragment => !html.includes(fragment))).toStrictEqual([]);
    expect(html).not.toContain(unsafe);
  });

  it('keeps structured causes and warning entries independently readable', async () => {
    const h = await host();
    h.plan.keep = [
      { code: 'active_process', path: '/work/busy' },
      { code: 'inspection_failed', detail: 'uncommitted work', path: '/work/dirty' },
    ];
    h.plan.warnings = ['Merge proof is incomplete.', 'One target is still active.'];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const { html } = askInput(await h.emit('session_stop'));
    expect(html).toContain('<p>/work/busy</p>\n<p>active_process</p>');
    expect(html).toContain('<p>/work/dirty</p>\n<p>inspection_failed</p>\n<p>uncommitted work</p>');
    expect(html).toContain('<p>Merge proof is incomplete.</p>\n<p>One target is still active.</p>');
    expect(html).not.toContain('<pre>');
  });
});

describe('OMP consent dispatch boundaries', () => {
  it.each(['bash', 'worktree_finish'])('does not consume the saved form when another tool carries it: %s', async toolName => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await expect(h.emit('tool_call', { input, toolCallId: 'wrong-tool', toolName })).resolves.toBeUndefined();
    await h.emit('tool_call', { input, toolCallId: 'real-ask', toolName: 'ask' });
    await h.emit('tool_result', { ...askReply(input), input, toolCallId: 'real-ask', toolName: 'ask' });
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([['finish', 'arm', 'plan-1', '--choice', 'current', '--selected', h.ctx.cwd]]);
  });

  it.each(['changed default', 'wrong form name', 'extra form', 'hidden target', 'unstripped intent'])('blocks non-exact HTML hook input: %s', async change => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const changed = { ...input };
    if (change === 'changed default') {
      changed.html = changed.html.replace('value="none" checked', 'value="none"');
    }
    if (change === 'wrong form name') {
      changed.html = changed.html.replace('name="tern-wt-finish:plan-1"', 'name="tern-wt-finish:another-plan"');
    }
    if (change === 'extra form') {
      changed.html += '<form><input name="other" value="merged"></form>';
    }
    if (change === 'hidden target') {
      changed.html += '<input type="hidden" name="target" value="/work/hidden">';
    }
    const eventInput = change === 'unstripped intent' ? { ...changed, i: 'Intent still present' } : changed;
    await expect(h.emit('tool_call', { input: eventInput, toolCallId: 'tampered', toolName: 'ask' })).resolves.toMatchObject({ block: true });
    await h.emit('tool_result', { ...askReply(input), input: eventInput, toolCallId: 'tampered', toolName: 'ask' });
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns(), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({
      arms: [],
      shutdowns: 0,
      status: 'offered',
    });
  });

  it.each([undefined, '', '   '])('requires a nonblank native call identifier: %j', async toolCallId => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await expect(h.emit('tool_call', { input, toolCallId, toolName: 'ask' })).resolves.toMatchObject({ block: true });
    await h.emit('tool_result', { ...askReply(input), input, toolCallId, toolName: 'ask' });
    expect(h.calls().filter(call => call[1] === 'arm')).toStrictEqual([]);
  });

  it.each(['different call', 'different tool', 'not yet called'])('ignores an otherwise valid native result from %s', async mismatch => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    if (mismatch !== 'not yet called') {
      await h.emit('tool_call', { input, toolCallId: 'expected', toolName: 'ask' });
    }
    await expect(
      h.emit('tool_result', {
        ...askReply(input),
        input,
        toolCallId: mismatch === 'different call' ? 'unexpected' : 'expected',
        toolName: mismatch === 'different tool' ? 'bash' : 'ask',
      }),
    ).resolves.toBeUndefined();
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns() }).toStrictEqual({ arms: [], shutdowns: 0 });
  });

  it.each([{ toolName: 'ask' }, { input: { html: null }, toolName: 'ask' }, { input: { html: '<form><input name="unrelated"></form>' }, toolName: 'ask' }])(
    'passes through unrelated malformed asks without consuming the offer: %j',
    async event => {
      const h = await host();
      await h.tool({ action: 'ready' });
      const input = askInput(await h.emit('session_stop'));
      await expect(h.emit('tool_call', event)).resolves.toBeUndefined();
      expect(h.entries.at(-1)?.data?.pending?.status).toBe('offered');
      await h.emit('tool_call', { input, toolCallId: 'after-unrelated', toolName: 'ask' });
      await h.emit('tool_result', { ...askReply(input), input, toolCallId: 'after-unrelated', toolName: 'ask' });
      expect(h.entries.at(-1)?.data?.pending?.status).toBe('armed');
    },
  );
});

describe('OMP native dual consent evidence', () => {
  const validDetails = { answers: [{ answer: currentLabel, name: 'tern-wt-finish:plan-1', question: legend }] };
  const currentContent = [{ text: 'User answers:\n{\n  "tern-wt-finish:plan-1": "current"\n}', type: 'text' }];

  it.each([
    { content: currentContent, details: { answers: [{ answer: 'current', name: 'tern-wt-finish:plan-1', question: legend }] }, name: 'Other text equal to current' },
    {
      content: [{ text: `User answers:\n${JSON.stringify({ 'tern-wt-finish:plan-1': currentLabel })}`, type: 'text' }],
      details: validDetails,
      name: 'Other text equal to a known label',
    },
    { content: [{ text: 'User answers:\n{"tern-wt-finish:another":"current"}', type: 'text' }], details: validDetails, name: 'another plan JSON key' },
    { content: currentContent, details: { answers: [{ answer: currentLabel, name: 'tern-wt-finish:another', question: legend }] }, name: 'another plan detail name' },
    { content: currentContent, details: { answers: [{ answer: mergedLabel, name: 'tern-wt-finish:plan-1', question: legend }] }, name: 'mismatched known label' },
    { content: [{ text: 'current', type: 'text' }], details: validDetails, name: 'free prose' },
    { content: currentContent, details: { ...validDetails, customInput: 'current' }, name: 'unexpected details' },
    { content: [{ text: 'Ask tool was cancelled by the user', type: 'text' }], isError: true, name: 'cancel' },
    {
      content: [{ text: 'No answer before the timeout; submitted the form\'s current values:\n{\n  "tern-wt-finish:plan-1": "none"\n}', type: 'text' }],
      details: { answers: [{ answer: noneLabel, name: 'tern-wt-finish:plan-1', question: legend }], timedOut: true },
      isError: false,
      name: 'native timeout',
    },
    { content: currentContent, details: { ...validDetails, timedOut: true }, isError: false, name: 'timeout flagged on current result' },
    {
      content: [{ text: 'No answer before the timeout; submitted the form\'s current values:\n{"tern-wt-finish:plan-1":"none"}', type: 'text' }],
      details: { answers: [{ answer: noneLabel, name: 'tern-wt-finish:plan-1', question: legend }] },
      name: 'timeout text without flag',
    },
    { name: 'no data' },
  ])('refuses $name and cannot reuse a later valid result', async ({ name: _name, ...reply }) => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'refused', toolName: 'ask' });
    await h.emit('tool_result', { ...reply, input, toolCallId: 'refused', toolName: 'ask' });
    await h.emit('tool_result', { ...askReply(input), input, toolCallId: 'refused', toolName: 'ask' });
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns(), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({
      arms: [],
      shutdowns: 0,
      status: 'closed',
    });
  });

  it('closes consent if the result changes the exact HTML input', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('tool_call', { input, toolCallId: 'result-tamper', toolName: 'ask' });
    const event: FinishEvent = { ...askReply(input), input: { html: `${input.html} ` }, toolCallId: 'result-tamper', toolName: 'ask' };
    await h.emit('tool_result', event);
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), status: h.entries.at(-1)?.data?.pending?.status }).toStrictEqual({ arms: [], status: 'closed' });
  });
});

describe('OMP report order', () => {
  it('ignores finish-shaped calls and reports before a plan exists', async () => {
    const h = await host();
    await expect(h.emit('tool_call', { input: { html: '<form id="tern-wt-finish:unknown"></form>' }, toolCallId: 'before-plan', toolName: 'ask' })).resolves.toBeUndefined();
    await h.emit('message_end', { message: { content: [{ text: 'Ordinary final response.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    expect({ arms: h.calls().filter(call => call[1] === 'arm'), shutdowns: h.shutdowns() }).toStrictEqual({ arms: [], shutdowns: 0 });
  });

  it('requires a genuine final report after consent, not one emitted while offered or asking', async () => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    await h.emit('message_end', { message: { content: [{ text: 'Report before consent.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('tool_call', { input, toolCallId: 'report-order', toolName: 'ask' });
    await h.emit('message_end', { message: { content: [{ text: 'Report during consent.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('tool_result', { ...askReply(input), input, toolCallId: 'report-order', toolName: 'ask' });
    await expect(h.emit('message_end', { message: { content: [{ type: 'text' }], role: 'assistant', stopReason: 'stop' } })).resolves.toBeUndefined();
    await h.emit('message_end', { message: { content: [{ text: ' \n\t ', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    const continuation = await h.emit('session_stop');
    expect(continuation?.continue).toBeTruthy();
    expect(h.shutdowns()).toBe(0);
    await h.emit('message_end', { message: { content: [{ text: 'Delivery completed.', type: 'text' }], role: 'assistant', stopReason: 'stop' } });
    await h.emit('session_stop');
    expect(h.shutdowns()).toBe(1);
  });
});
