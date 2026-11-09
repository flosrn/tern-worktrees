import { parseArgs } from 'node:util';
import { planFinish } from '../finish.ts';
import { armFinish, executeFinish, finishStatus } from '../finish-execute.ts';
import { CliError } from '../proc.ts';
import { acknowledgeFinish, finishNoticeIds } from '../finish-store.ts';

const plan = async (args: string[]): Promise<object> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      block: { type: 'string' },
      current: { type: 'string' },
      exclude: { multiple: true, type: 'string' },
      owned: { multiple: true, type: 'string' },
      pid: { type: 'string' },
      repo: { type: 'string' },
      session: { type: 'string' },
    },
  });
  const invalidNumber = [values.pid, values.block].some(value => value !== undefined && (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))));
  if (values.repo === undefined || positionals.length !== 0 || invalidNumber) {
    throw new CliError('bad_args', 'finish plan needs --repo <dir> and positive numeric --pid/--block values');
  }
  return await planFinish({
    block: values.block === undefined ? undefined : Number(values.block),
    current: values.current,
    excluded: values.exclude ?? [],
    owned: values.owned ?? [],
    pid: values.pid === undefined ? undefined : Number(values.pid),
    repo: values.repo,
    session: values.session,
  });
};

const arm = async (args: string[]): Promise<object> => {
  const { values, positionals } = parseArgs({ allowPositionals: true, args, options: { choice: { type: 'string' }, selected: { multiple: true, type: 'string' } } });
  const [id] = positionals;
  const { choice } = values;
  if (positionals.length !== 1 || (choice !== 'current' && choice !== 'merged' && choice !== 'none')) {
    throw new CliError('bad_args', 'finish arm needs <id> --choice current|merged|none');
  }
  return await armFinish(id, choice, values.selected ?? []);
};

/** Plans a teardown, records the selection, or reads the result. */
export const run = async (args: string[]): Promise<object> => {
  const [action, ...rest] = args;
  if (action === 'plan') {
    return await plan(rest);
  }
  if (action === 'arm') {
    return await arm(rest);
  }
  const { positionals } = parseArgs({ allowPositionals: true, args: action?.startsWith('-') ? args : rest });
  if (action === 'notices' && positionals.length === 0) {
    const { pending, completed } = finishNoticeIds();
    return { completed: completed.map(finishStatus), pending };
  }
  if (positionals.length !== 1) {
    throw new CliError('bad_args', 'finish needs plan, arm, status, execute, notices or acknowledge');
  }
  const [id] = positionals;
  switch (action) {
    case 'status': {
      return finishStatus(id);
    }
    case 'execute': {
      return await executeFinish(id);
    }
    case 'acknowledge': {
      return acknowledgeFinish(id);
    }
    default: {
      throw new CliError('bad_args', 'finish needs plan, arm, status, execute, notices or acknowledge');
    }
  }
};
