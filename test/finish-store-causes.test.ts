import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vite-plus/test';
import { run } from '../src/commands/finish.ts';
import { finishDirectory, finishNoticeIds, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import type { FinishCauseCode, FinishKept, FinishState } from '../src/finish-types.ts';
import { tempDir, useSandbox } from './helpers.ts';

const planId = 'a'.repeat(48);
const head = 'b'.repeat(40);
const diagnostic = 'Keep this diagnostic intact.\nIt belongs to this worktree.';

const diagnosticConditions = [
  'bad_args',
  'busy_tabs',
  'config_invalid',
  'dirty_worktree',
  'docker_missing',
  'gh_failed',
  'git_failed',
  'inspection_failed',
  'not_a_repo',
  'not_cloned',
  'not_managed',
  'omp_failed',
  'path_conflict',
  'service_failed',
  'setup_failed',
  'teardown_failed',
  'tern_failed',
  'worker_start_failed',
  'worktree_config_invalid',
  'worktree_exists_elsewhere',
] as const satisfies readonly FinishCauseCode[];

const structuredConditions = [
  'active_process',
  'caller_waiting',
  'interrupted',
  'not_merged',
  'path_identity_changed',
  'registration_changed',
  'retained',
] as const satisfies readonly FinishCauseCode[];

type CauseCollection = 'keep' | 'errors';

interface MalformedCause {
  path: string;
  code: string;
  detail?: unknown;
  reason?: string;
  retry?: boolean;
}

const completedPlan = (): StoredFinish => {
  const repo = tempDir('finish-cause-repo');
  const target = path.join(repo, 'worktree');
  return {
    caller: { block: null, identity: null, pid: null, session: null },
    candidates: [
      {
        branch: 'delivered',
        head,
        path: target,
        pr: { headRefOid: head, mergeCommit: head, mergedAt: '2026-11-01T10:00:00Z', number: 7, url: 'https://github.com/example/repo/pull/7' },
      },
    ],
    current: target,
    errors: [],
    excluded: [],
    id: planId,
    identities: { [repo]: { dev: 1, ino: 2 }, [target]: { dev: 1, ino: 3 } },
    inFlight: null,
    keep: [],
    notified: false,
    owned: [target],
    ready: true,
    removed: [],
    repo,
    selected: [target],
    status: 'completed',
    version: 2,
    warnings: [],
  };
};

const publicResult = (state: StoredFinish): FinishState => ({
  candidates: state.candidates,
  current: state.current,
  errors: state.errors,
  id: state.id,
  keep: state.keep,
  ready: state.ready,
  removed: state.removed,
  repo: state.repo,
  selected: state.selected,
  status: state.status,
  warnings: state.warnings,
});

const observeReportable = async (state: StoredFinish) => {
  writeFinish(state);
  const file = path.join(finishDirectory(state.id), 'state.json');
  const journal = readFileSync(file, 'utf-8');
  const result = {
    noticeIds: finishNoticeIds(),
    notices: await run(['notices']),
    state: readFinish(state.id),
    status: await run(['status', state.id]),
  };
  expect(readFileSync(file, 'utf-8')).toBe(journal);
  return result;
};

const reportableContract = (state: StoredFinish) => ({
  noticeIds: { completed: [state.id], pending: [] },
  notices: { completed: [publicResult(state)], pending: [] },
  state,
  status: publicResult(state),
});

const observeRejected = async (state: StoredFinish, field: CauseCollection, cause: MalformedCause) => {
  writeFinish(state);
  const file = path.join(finishDirectory(state.id), 'state.json');
  const journal = JSON.stringify({ ...state, [field]: [cause] });
  writeFileSync(file, journal);
  expect(() => readFinish(state.id)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  await expect(run(['status', state.id])).rejects.toMatchObject({ code: 'bad_args' });
  const noticeIds = finishNoticeIds();
  const notices = await run(['notices']);
  return {
    journal: readFileSync(file, 'utf-8'),
    noticeIds,
    notices,
  };
};

const rejectedContract = (state: StoredFinish, field: CauseCollection, cause: MalformedCause) => ({
  journal: JSON.stringify({ ...state, [field]: [cause] }),
  noticeIds: { completed: [], pending: [] },
  notices: { completed: [], pending: [] },
});

const withCause = (field: CauseCollection, code: FinishCauseCode) => {
  const state = completedPlan();
  const cause: FinishKept = { code, path: state.current ?? state.repo };
  state[field] = [cause];
  return { cause, state };
};

describe.each(['keep', 'errors'] as const)('durable %s causes through read, status and notices', field => {
  beforeEach(() => {
    useSandbox();
  });

  test.each(diagnosticConditions)('preserves the allowed string detail for %s in the complete public result', async code => {
    const { cause, state } = withCause(field, code);
    cause.detail = diagnostic;
    await expect(observeReportable(state)).resolves.toStrictEqual(reportableContract(state));
  });

  test.each(structuredConditions)('rejects a string detail for %s even though it has the correct diagnostic type', async code => {
    const { cause, state } = withCause(field, code);
    const malformed = { ...cause, detail: diagnostic };
    await expect(observeRejected(state, field, malformed)).resolves.toStrictEqual(rejectedContract(state, field, malformed));
  });

  test('accepts the condition when its optional detail is absent', async () => {
    const { state } = withCause(field, 'dirty_worktree');
    await expect(observeReportable(state)).resolves.toStrictEqual(reportableContract(state));
  });

  test.each([null, false, 0, [], {}])('rejects diagnostic detail %j independently of its valid code and path', async detail => {
    const { cause, state } = withCause(field, 'dirty_worktree');
    const malformed = { ...cause, detail };
    await expect(observeRejected(state, field, malformed)).resolves.toStrictEqual(rejectedContract(state, field, malformed));
  });

  test('preserves an allowed empty string detail rather than treating it as absent', async () => {
    const { cause, state } = withCause(field, 'dirty_worktree');
    cause.detail = '';
    await expect(observeReportable(state)).resolves.toStrictEqual(reportableContract(state));
  });

  test('rejects an unknown code with its path and all other state fields valid', async () => {
    const { cause, state } = withCause(field, 'dirty_worktree');
    const malformed = { ...cause, code: 'future_finish_condition' };
    await expect(observeRejected(state, field, malformed)).resolves.toStrictEqual(rejectedContract(state, field, malformed));
  });

  test('rejects a legacy reason field on an otherwise valid cause', async () => {
    const { cause, state } = withCause(field, 'dirty_worktree');
    const malformed = { ...cause, reason: diagnostic };
    await expect(observeRejected(state, field, malformed)).resolves.toStrictEqual(rejectedContract(state, field, malformed));
  });

  test('rejects an extra field on an otherwise valid cause', async () => {
    const { cause, state } = withCause(field, 'dirty_worktree');
    const malformed = { ...cause, retry: true };
    await expect(observeRejected(state, field, malformed)).resolves.toStrictEqual(rejectedContract(state, field, malformed));
  });
});
