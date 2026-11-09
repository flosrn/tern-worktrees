import { describe, expect, it } from 'vite-plus/test';
import { askInput, askReply, host } from './omp-finish-host.ts';

describe('OMP finish native form contract', () => {
  it('requires a real ask with the exact saved targets when explicitly ready', async () => {
    const h = await host();
    h.plan.keep = [{ code: 'active_process', path: '/work/busy' }];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const stop = await h.emit('session_stop');
    expect(stop?.continue).toBeTruthy();

    const input = askInput(stop);
    expect(input.html).toContain(`<form id="tern-wt-finish:${h.plan.id}" name="tern-wt-finish:${h.plan.id}">`);
    const radios = input.html.match(/<input\b[^>]*>/gu) ?? [];
    expect({
      checked: radios.map(radio => /\schecked(?:\s|>)/u.test(radio)),
      descriptions: radios.map(radio => /aria-describedby="(?<id>[^"]+)"/u.exec(radio)?.groups?.id),
      fieldsets: input.html.match(/<fieldset>/gu)?.length ?? 0,
      legends: input.html.match(/<legend>/gu)?.length ?? 0,
      namedRadios: radios.every(radio => radio.includes('type="radio"') && radio.includes(`name="tern-wt-finish:${h.plan.id}"`)),
      preview: [h.ctx.cwd, 'https://github.com/test/repo/pull/42', 'PR #42', 'a'.repeat(40), '/work/busy', 'active_process'].map(text => input.html.includes(text)),
      scopeDescriptions: ['current', 'merged', 'none'].map(choice => input.html.includes(`id="tern-wt-finish:${h.plan.id}:${choice}-scope"`)),
      values: radios.map(radio => /value="(?<value>[^"]+)"/u.exec(radio)?.groups?.value),
    }).toStrictEqual({
      checked: [false, false, true],
      descriptions: ['current', 'merged', 'none'].map(choice => `tern-wt-finish:${h.plan.id}:${choice}-scope`),
      fieldsets: 1,
      legends: 1,
      namedRadios: true,
      preview: [true, true, true, true, true, true],
      scopeDescriptions: [true, true, true],
      values: ['current', 'merged', 'none'],
    });
    expect({ arms: h.calls().filter(args => args[1] === 'arm'), shutdowns: h.shutdowns() }).toStrictEqual({ arms: [], shutdowns: 0 });
  });

  it('offers a plan without retained worktrees and arms exactly the current consent', async () => {
    const h = await host();
    h.plan.keep = [];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    expect({
      hiddenKeep: input.html.includes('/work/busy'),
      retained: h.entries.at(-1)?.data?.pending?.plan.keep,
      target: input.html.includes(`<p>${h.ctx.cwd}</p>`),
    }).toStrictEqual({ hiddenKeep: false, retained: [], target: true });
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
    await h.emit('tool_call', { input, toolCallId: 'ask-no-retained', toolName: 'ask' });
    await h.emit('tool_result', {
      ...askReply(input, 'current'),
      input,
      toolCallId: 'ask-no-retained',
      toolName: 'ask',
    });
    expect({
      arms: h.calls().filter(args => args[1] === 'arm'),
      shutdowns: h.shutdowns(),
      status: h.entries.at(-1)?.data?.pending?.status,
    }).toStrictEqual({
      arms: [['finish', 'arm', h.plan.id, '--choice', 'current', '--selected', h.ctx.cwd]],
      shutdowns: 0,
      status: 'armed',
    });
  });

  it('escapes plan data and lists each immutable target once in its approval section', async () => {
    const h = await host();
    const current = `${h.ctx.cwd}/owned-&<>"'`;
    const other = '/work/other-&<>"\'';
    const kept = '/work/kept-&<>"\'';
    const url = 'https://github.com/test/repo/pull/71?proof=&<>"\'';
    const detail = 'kept detail &<>"\'';
    const warning = 'warning &<>"\'';
    const [candidate] = h.plan.candidates;
    h.plan.current = current;
    h.plan.candidates = [
      { ...candidate, head: 'c'.repeat(40), path: current, pr: { ...candidate.pr, headRefOid: 'd'.repeat(40), number: 71, url } },
      { ...candidate, head: 'e'.repeat(40), path: other, pr: { ...candidate.pr, headRefOid: 'f'.repeat(40), number: 72, url: 'https://github.com/test/repo/pull/72' } },
    ];
    h.plan.keep = [{ code: 'inspection_failed', detail, path: kept }];
    h.plan.warnings = [warning];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const sections = input.html.match(/<section>[\s\S]*?<\/section>/gu) ?? [];
    const [currentPreview = '', otherPreview = '', keptPreview = '', warningPreview = ''] = sections;
    const escapedCurrent = `${h.ctx.cwd}/owned-&amp;&lt;&gt;&quot;&#39;`;
    const escapedOther = '/work/other-&amp;&lt;&gt;&quot;&#39;';
    expect({
      currentHasOther: currentPreview.includes(escapedOther),
      currentProof: currentPreview.includes(
        `<p>${escapedCurrent}</p>\n<p>PR #71 https://github.com/test/repo/pull/71?proof=&amp;&lt;&gt;&quot;&#39;</p>\n<p>HEAD ${'c'.repeat(40)}</p>\n<p>PR HEAD ${'d'.repeat(40)}</p>`,
      ),
      keptProof: keptPreview.includes('<p>/work/kept-&amp;&lt;&gt;&quot;&#39;</p>\n<p>inspection_failed</p>\n<p>kept detail &amp;&lt;&gt;&quot;&#39;</p>'),
      otherHasCurrent: otherPreview.includes(escapedCurrent),
      otherProof: otherPreview.includes(
        `<p>${escapedOther}</p>\n<p>PR #72 https://github.com/test/repo/pull/72</p>\n<p>HEAD ${'e'.repeat(40)}</p>\n<p>PR HEAD ${'f'.repeat(40)}</p>`,
      ),
      sections: sections.length,
      warning: warningPreview.includes('<p>warning &amp;&lt;&gt;&quot;&#39;</p>'),
    }).toStrictEqual({ currentHasOther: false, currentProof: true, keptProof: true, otherHasCurrent: false, otherProof: true, sections: 4, warning: true });
    expect([current, other, kept, url, detail, warning].map(value => input.html.includes(value))).toStrictEqual([false, false, false, false, false, false]);
    expect([escapedCurrent, escapedOther, '/work/kept-&amp;&lt;&gt;&quot;&#39;'].map(value => input.html.split(value).length)).toStrictEqual([2, 2, 2]);
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
  });

  it('keeps long approval paths intact in native wrapping paragraphs', async () => {
    const h = await host();
    const current = `/work/${'long-directory-'.repeat(18)}current`;
    const kept = `/work/${'long-directory-'.repeat(18)}kept`;
    h.plan.current = current;
    h.plan.candidates[0].path = current;
    h.plan.keep = [{ code: 'active_process', path: kept }];
    h.savePlan();
    await h.tool({ action: 'ready' });
    const { html } = askInput(await h.emit('session_stop'));
    expect(html).toContain(`<p>${current}</p>`);
    expect(html).toContain(`<p>${kept}</p>`);
    expect(html).not.toContain('<pre>');
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
  });
});
