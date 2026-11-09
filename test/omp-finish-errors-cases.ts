import type { FinishEvent } from '../src/omp-finish-types.ts';

type NativeAnswerJson = Record<string, string | string[]>;

interface NativeAnswerCase {
  label: string;
  mutate: (event: FinishEvent, name: string) => void;
}

const nativeAnswer = (name: string) => ({
  answer: 'Supprimer seulement mes worktrees',
  name,
  question: 'La livraison est terminée. Quels worktrees souhaitez-vous supprimer après le bilan final ?',
});

const answerContent = (value: NativeAnswerJson): NonNullable<FinishEvent['content']> => [{ text: `User answers:\n${JSON.stringify(value, null, 2)}`, type: 'text' }];

export const invalidNativeAnswers: NativeAnswerCase[] = [
  {
    label: 'cancelled',
    mutate: event => {
      event.isError = true;
      delete event.details;
    },
  },
  {
    label: 'missing details',
    mutate: event => {
      delete event.details;
    },
  },
  {
    label: 'changed input',
    mutate: event => {
      event.input = {};
    },
  },
  {
    label: 'missing content',
    mutate: event => {
      delete event.content;
    },
  },
  {
    label: 'empty content',
    mutate: event => {
      event.content = [];
    },
  },
  {
    label: 'non-text content',
    mutate: event => {
      event.content = [{ type: 'image' }];
    },
  },
  {
    label: 'missing text',
    mutate: event => {
      event.content = [{ type: 'text' }];
    },
  },
  {
    label: 'malformed JSON',
    mutate: event => {
      event.content = [{ text: 'User answers:\n{', type: 'text' }];
    },
  },
  {
    label: 'free prose',
    mutate: (event, name) => {
      event.content = [{ text: nativeAnswer(name).answer, type: 'text' }];
    },
  },
  {
    label: 'wrong prefix',
    mutate: (event, name) => {
      event.content = [{ text: `Answers:\n${JSON.stringify({ [name]: 'current' })}`, type: 'text' }];
    },
  },
  {
    label: 'duplicate JSON field',
    mutate: (event, name) => {
      event.content = [{ text: `User answers:\n{"${name}":"none","${name}":"current"}`, type: 'text' }];
    },
  },
  {
    label: 'unexpected JSON field',
    mutate: (event, name) => {
      event.content = answerContent({ [name]: 'current', unrelated: 'none' });
    },
  },
  {
    label: 'missing JSON field',
    mutate: event => {
      event.content = answerContent({});
    },
  },
  {
    label: 'unknown choice',
    mutate: (event, name) => {
      event.content = answerContent({ [name]: 'unknown' });
    },
  },
  {
    label: 'label instead of choice',
    mutate: (event, name) => {
      event.content = answerContent({ [name]: nativeAnswer(name).answer });
    },
  },
  {
    label: 'array choice',
    mutate: (event, name) => {
      event.content = answerContent({ [name]: ['current'] });
    },
  },
  {
    label: 'missing answers',
    mutate: event => {
      event.details = {};
    },
  },
  {
    label: 'empty answers',
    mutate: event => {
      event.details = { answers: [] };
    },
  },
  {
    label: 'duplicate answers',
    mutate: (event, name) => {
      const answer = nativeAnswer(name);
      event.details = { answers: [answer, answer] };
    },
  },
  {
    label: 'changed answer name',
    mutate: (event, name) => {
      event.details = { answers: [{ ...nativeAnswer(name), name: `${name}-other` }] };
    },
  },
  {
    label: 'changed answer question',
    mutate: (event, name) => {
      event.details = { answers: [{ ...nativeAnswer(name), question: 'Unrelated approval' }] };
    },
  },
  {
    label: 'unknown answer label',
    mutate: (event, name) => {
      event.details = { answers: [{ ...nativeAnswer(name), answer: 'Other: current' }] };
    },
  },
  {
    label: 'mismatched answer label',
    mutate: (event, name) => {
      event.details = { answers: [{ ...nativeAnswer(name), answer: 'Ne rien supprimer' }] };
    },
  },
];
