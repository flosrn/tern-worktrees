import { describe, expect, it } from 'vite-plus/test';
import type { FinishEvent } from '../src/omp-finish-types.ts';
import { askInput, askReply, host } from './omp-finish-host.ts';
import type { TestAskInput } from './omp-finish-host.ts';

interface NativeAnswer {
  answer: string;
  name: string;
  question: string;
}

interface NativeRefusal {
  name: string;
  mutate: (reply: FinishEvent, input: TestAskInput, answer: NativeAnswer) => void;
}

const nativeRefusals: NativeRefusal[] = [
  {
    mutate: (reply, input, answer) => {
      Object.assign(reply, askReply(input, 'none'));
      reply.content = [{ text: `No answer before the timeout; submitted the form's current values:\n${JSON.stringify({ [answer.name]: 'none' }, null, 2)}`, type: 'text' }];
      reply.details = { ...reply.details, timedOut: true };
    },
    name: 'native timeout',
  },
  {
    mutate: reply => {
      reply.content = [{ text: 'User cancelled the form.', type: 'text' }];
      reply.isError = true;
      delete reply.details;
    },
    name: 'cancelled form',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.content = [{ text: `User answers:\n${JSON.stringify({ [answer.name]: 'Please remove everything.' }, null, 2)}`, type: 'text' }];
    },
    name: 'free prose',
  },
  {
    mutate: reply => {
      reply.content = [{ text: 'User answers:\n{invalid json', type: 'text' }];
    },
    name: 'invalid JSON',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.content = [{ text: `User answers:\n{${JSON.stringify(answer.name)}:"\\q"}`, type: 'text' }];
    },
    name: 'invalid JSON string escape in a single answer field',
  },
  {
    mutate: reply => {
      reply.content = [{ text: 'User answers:\n["current"]', type: 'text' }];
    },
    name: 'array JSON',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.content = [{ text: `User answers:\n${JSON.stringify({ [answer.name]: 'everything' }, null, 2)}`, type: 'text' }];
    },
    name: 'unknown choice',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.content = [{ text: `User answers:\n${JSON.stringify({ [answer.name]: answer.answer }, null, 2)}`, type: 'text' }];
    },
    name: 'label instead of choice',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.details = { answers: [{ ...answer, answer: 'Other: current' }] };
    },
    name: 'Other current',
  },
  {
    mutate: reply => {
      reply.content = [{ text: 'User answers:\n{"another-form":"current"}', type: 'text' }];
    },
    name: 'another form',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.content = [{ text: `User answers:\n${JSON.stringify({ [answer.name]: 'current', extra: 'current' }, null, 2)}`, type: 'text' }];
    },
    name: 'extra field',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.content = [{ text: `User answers:\n${JSON.stringify({ [answer.name]: ['current', 'merged'] }, null, 2)}`, type: 'text' }];
    },
    name: 'multiple choices',
  },
  {
    mutate: (reply, input) => {
      reply.content = askReply(input, 'merged').content;
    },
    name: 'contradictory choice',
  },
  {
    mutate: reply => {
      delete reply.content;
    },
    name: 'missing content',
  },
  {
    mutate: reply => {
      reply.content?.push({ text: 'Please remove everything.', type: 'text' });
    },
    name: 'multiple content blocks',
  },
  {
    mutate: reply => {
      reply.content = [{ text: 'User answers:\n{}', type: 'image' }];
    },
    name: 'non-text content',
  },
  {
    mutate: reply => {
      delete reply.details;
    },
    name: 'missing answers',
  },
  {
    mutate: reply => {
      reply.details = { answers: [] };
    },
    name: 'empty answers',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.details = { answers: [answer, answer] };
    },
    name: 'multiple answers',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.details = { answers: [{ ...answer, name: 'tern-wt-finish:another-plan' }] };
    },
    name: 'forged name',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.details = { answers: [{ ...answer, question: 'A different approval scope?' }] };
    },
    name: 'forged legend',
  },
  {
    mutate: (reply, _input, answer) => {
      reply.details = { answers: [{ ...answer, extra: true }] };
    },
    name: 'extra answer field',
  },
  {
    mutate: reply => {
      reply.details = { ...reply.details, note: 'Do not delete anything' };
    },
    name: 'extra result field',
  },
];

describe('OMP finish explicit native consent', () => {
  it.each(nativeRefusals)('never arms a native form result without unambiguous explicit consent: $name', async ({ mutate }) => {
    const h = await host();
    await h.tool({ action: 'ready' });
    const input = askInput(await h.emit('session_stop'));
    const answer = {
      answer: 'Supprimer seulement mes worktrees',
      name: `tern-wt-finish:${h.plan.id}`,
      question: /<legend>(?<legend>.*?)<\/legend>/u.exec(input.html)?.groups?.legend ?? '',
    };
    const reply: FinishEvent = { ...askReply(input, 'current') };
    mutate(reply, input, answer);
    await h.emit('tool_call', { input, toolCallId: 'ask-invalid', toolName: 'ask' });
    await h.emit('tool_result', {
      ...reply,
      input,
      toolCallId: 'ask-invalid',
      toolName: 'ask',
    });
    expect(h.calls().filter(args => args[1] === 'arm')).toStrictEqual([]);
    await expect(h.emit('session_stop')).resolves.toBeUndefined();
    expect(h.shutdowns()).toBe(0);
  });
});
