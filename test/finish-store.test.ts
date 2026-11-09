import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { acknowledgeFinish, finishDirectory, finishNoticeIds, lockFinish, readFinish, writeFinish } from '../src/finish-store.ts';
import type { StoredFinish } from '../src/finish-store.ts';
import { CliError } from '../src/proc.ts';
import { tempDir, useSandbox } from './helpers.ts';

const planId = 'a'.repeat(48);
const head = 'b'.repeat(40);

const cliFailure = (action: () => void): CliError => {
  try {
    action();
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    return error;
  }
  throw new Error('Expected a public CLI failure');
};

const savedPlan = (): StoredFinish => {
  const repo = tempDir('finish-store-repo');
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
    errors: [{ code: 'teardown_failed', detail: 'Teardown command failed.', path: target }],
    excluded: [],
    id: planId,
    identities: { [repo]: { dev: 1, ino: 2 }, [target]: { dev: 1, ino: 3 } },
    inFlight: target,
    keep: [{ code: 'dirty_worktree', path: target }],
    notified: false,
    owned: [target],
    ready: true,
    removed: [{ branchDeleted: true, closedBlocks: [5], path: target }],
    repo,
    selected: [target],
    status: 'planned',
    version: 2,
    warnings: ['No teardown.'],
  };
};

const invalidStateFields = [
  ['version', { version: 1 }],
  ['id', { id: 'b'.repeat(48) }],
  ['repository type', { repo: 4 }],
  ['repository path', { repo: 'relative' }],
  ['current', { current: 7 }],
  ['status type', { status: 7 }],
  ['status value', { status: 'other' }],
  ['ready', { ready: null }],
  ['notified', { notified: null }],
  ['candidates array', { candidates: null }],
  ['candidate object', { candidates: [null] }],
  ['selected array', { selected: null }],
  ['selected item', { selected: [7] }],
  ['selected target', { selected: ['/unapproved'] }],
  ['owned array', { owned: null }],
  ['owned item', { owned: [7] }],
  ['excluded array', { excluded: null }],
  ['excluded item', { excluded: [7] }],
  ['caller object', { caller: null }],
  ['caller missing identity', { caller: { pid: null } }],
  ['caller session', { caller: { block: null, identity: null, pid: null, session: 7 } }],
  ['kept array', { keep: null }],
  ['kept object', { keep: [null] }],
  ['kept path type', { keep: [{ code: 'retained', path: 4 }] }],
  ['kept path', { keep: [{ code: 'retained', path: 'relative' }] }],
  ['kept code type', { keep: [{ code: 7, path: '/target' }] }],
  ['errors array', { errors: null }],
  ['errors item', { errors: [null] }],
  ['warnings array', { warnings: null }],
  ['warnings item', { warnings: [7] }],
  ['removed array', { removed: null }],
  ['removed object', { removed: [null] }],
  ['removed path type', { removed: [{ path: 7 }] }],
  ['removed target', { removed: [{ path: '/unapproved' }] }],
  ['identities object', { identities: null }],
  ['identities absent', { identities: {} }],
  ['in-flight target', { inFlight: '/unapproved' }],
  ['in-flight type', { inFlight: 5 }],
] as const;

// SAFETY: Test cases intentionally replace persisted fields before the public parser reads them.
const invalidFields = invalidStateFields;

describe('finish state validation', () => {
  beforeEach(() => {
    useSandbox();
  });

  test('round-trips a valid durable result and caller identity', () => {
    const state = savedPlan();
    state.caller = { block: 8, identity: { command: 'omp', cwd: state.repo, group: 20, parent: 1, pid: 20, start: '100' }, pid: 20, session: 'session' };
    writeFinish(state);
    expect(readFinish(planId)).toStrictEqual(state);
  });

  test.each(invalidFields)('rejects invalid %s before it can authorize teardown', (_label, fields) => {
    const state = savedPlan();
    writeFinish(state);
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, ...fields }));
    const failure = cliFailure(() => {
      readFinish(planId);
    });
    expect(failure.code).toBe('bad_args');
    expect(failure.message).toMatch(/\S/u);
  });

  test.each([
    ['path type', { path: 4 }],
    ['relative path', { path: 'relative' }],
    ['branch type', { branch: 4 }],
    ['empty branch', { branch: '' }],
    ['head type', { head: 5 }],
    ['head format', { head: 'invalid' }],
    ['head prefix', { head: `x${head}` }],
    ['head suffix', { head: `${head}x` }],
    ['invalid proof', { pr: null }],
  ])('rejects a candidate with only its %s invalid', (_label, fields) => {
    const state = savedPlan();
    writeFinish(state);
    const candidates = state.candidates.map(candidate => ({ ...candidate, ...fields }));
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, candidates }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test('rejects a candidate whose proof is absent', () => {
    const state = savedPlan();
    writeFinish(state);
    const candidates = state.candidates.map(candidate => {
      const fields = { ...candidate };
      Reflect.deleteProperty(fields, 'pr');
      return fields;
    });
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, candidates }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each([`x${head}`, `${head}x`, 'invalid', 'b'.repeat(39), 'b'.repeat(65)])('rejects malformed head %s even when the proof repeats it', invalidHead => {
    const state = savedPlan();
    writeFinish(state);
    const candidates = state.candidates.map(candidate => ({ ...candidate, head: invalidHead, pr: { ...candidate.pr, headRefOid: invalidHead } }));
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, candidates }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });
});

describe('finish caller and target validation', () => {
  beforeEach(() => {
    useSandbox();
  });

  test.each([0, -1, 1.5, '20', Number.MAX_SAFE_INTEGER + 1])('rejects caller pid %j independently of a process identity', pid => {
    const state = savedPlan();
    writeFinish(state);
    const caller = { ...state.caller, pid };
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, caller }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each([0, -1, 1.5, '8', Number.MAX_SAFE_INTEGER + 1])('rejects caller block %j with all other caller fields valid', block => {
    const state = savedPlan();
    writeFinish(state);
    const caller = { ...state.caller, block };
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, caller }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each([null, 1, 20, Number.MAX_SAFE_INTEGER])('accepts nullable or positive caller identifiers %j without an identity', identifier => {
    const state = savedPlan();
    state.caller = { block: identifier, identity: null, pid: identifier, session: null };
    writeFinish(state);
    expect(readFinish(planId)).toStrictEqual(state);
  });

  test('rejects an unapproved selection even with valid identities and no completed or in-flight results', () => {
    const state = savedPlan();
    writeFinish(state);
    const target = path.join(state.repo, 'unapproved');
    const invalid = { ...state, identities: { ...state.identities, [target]: { dev: 1, ino: 4 } }, inFlight: null, removed: [], selected: [target] };
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify(invalid));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test('rejects a saved state with no caller field', () => {
    const state = savedPlan();
    writeFinish(state);
    const fields = { ...state };
    Reflect.deleteProperty(fields, 'caller');
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify(fields));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each([null, [], 4, 'state'])('rejects a non-object state document %j', value => {
    writeFinish(savedPlan());
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify(value));
    const failure = cliFailure(() => {
      readFinish(planId);
    });
    expect(failure.code).toBe('bad_args');
    expect(failure.message).toMatch(/\S/u);
  });

  test('does not accept malformed JSON', () => {
    writeFinish(savedPlan());
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), '{');
    expect(() => readFinish(planId)).toThrow(SyntaxError);
  });

  test.each(['duplicate', 'excluded', 'proof', 'removed boolean', 'removed blocks', 'removed block item', 'device', 'inode'])('rejects invalid target relations: %s', kind => {
    const state = savedPlan();
    const target = state.selected[0] ?? '';
    writeFinish(state);
    const fields = {
      'device': { identities: { ...state.identities, [target]: { dev: '1', ino: 3 } } },
      'duplicate': { selected: [target, target] },
      'excluded': { excluded: [target] },
      'inode': { identities: { ...state.identities, [target]: { dev: 1, ino: '3' } } },
      'proof': { candidates: [{ ...state.candidates[0], pr: { ...state.candidates[0]?.pr, headRefOid: 'c'.repeat(40) } }] },
      'removed block item': { removed: [{ branchDeleted: false, closedBlocks: [1.5], path: target }] },
      'removed blocks': { removed: [{ branchDeleted: false, closedBlocks: null, path: target }] },
      'removed boolean': { removed: [{ branchDeleted: 'yes', closedBlocks: [], path: target }] },
    };
    // SAFETY: The table above defines each key passed by this test case.
    const patch = fields[kind as keyof typeof fields];
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, ...patch }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each([
    ['object', null],
    ['pid', { pid: 0 }],
    ['parent', { parent: 1.5 }],
    ['group', { group: 1.5 }],
    ['start type', { start: 7 }],
    ['empty start', { start: '' }],
    ['cwd type', { cwd: 7 }],
    ['cwd path', { cwd: 'relative' }],
    ['command', { command: 7 }],
    ['caller mismatch', { pid: 21 }],
  ])('rejects invalid caller identity %s', (_label, fields) => {
    const state = savedPlan();
    const identity = { command: 'omp', cwd: state.repo, group: 20, parent: 1, pid: 20, start: '100' };
    writeFinish(state);
    const caller = { block: 8, identity: fields === null ? 'invalid' : { ...identity, ...fields }, pid: 20, session: 'session' };
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, caller }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each([
    ['nullable pid', null, null],
    ['non-coercible pid', 20, { toString: null }],
    ['negative pid', -1, -1],
    ['fractional pid', 1.5, 1.5],
    ['string pid', '20', '20'],
    ['zero pid', 0, 0],
  ])('rejects an identity with %s and preserves the saved journal', (_label, pid, identityPid) => {
    const state = savedPlan();
    writeFinish(state);
    const identity = { command: 'omp', cwd: state.repo, group: 20, parent: 1, pid: identityPid, start: '100' };
    const caller = { block: null, identity, pid, session: null };
    const file = path.join(finishDirectory(planId), 'state.json');
    const journal = JSON.stringify({ ...state, caller });
    writeFileSync(file, journal);
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(readFileSync(file, 'utf-8')).toBe(journal);
  });

  test('accepts empty target sets, nullable current and no in-flight target', () => {
    const state = savedPlan();
    Object.assign(state, { candidates: [], current: null, inFlight: null, removed: [], selected: [] });
    writeFinish(state);
    expect(readFinish(planId)).toStrictEqual(state);
  });
});

describe('finish durable collection boundaries', () => {
  beforeEach(() => {
    useSandbox();
  });

  test.each([40, 64])('accepts numeric hexadecimal plan and head identifiers with a %i-character head', length => {
    const state = savedPlan();
    state.id = '1'.repeat(48);
    const numericHead = '2'.repeat(length);
    state.candidates = state.candidates.map(candidate => ({ ...candidate, head: numericHead, pr: { ...candidate.pr, headRefOid: numericHead } }));
    writeFinish(state);
    expect(readFinish(state.id)).toStrictEqual(state);
  });

  test('accepts a selected candidate alongside another valid unselected candidate', () => {
    const state = savedPlan();
    const target = path.join(state.repo, 'other-worktree');
    const additional = state.candidates.map(candidate => ({ ...candidate, branch: 'other-delivered', path: target }));
    state.candidates.push(...additional);
    state.identities[target] = { dev: 1, ino: 4 };
    writeFinish(state);
    expect(readFinish(planId)).toStrictEqual(state);
  });

  test.each([{ closedBlocks: [] }, { closedBlocks: [2, 3] }])('accepts a result without branch deletion and closed blocks $closedBlocks', ({ closedBlocks }) => {
    const state = savedPlan();
    state.ready = false;
    state.removed = state.selected.map(target => ({ branchDeleted: false, closedBlocks, path: target }));
    writeFinish(state);
    expect(readFinish(planId)).toStrictEqual(state);
  });

  test.each([{ closedBlocks: [2, 1.5] }, { closedBlocks: [1.5, 2] }])('rejects mixed valid and invalid closed blocks $closedBlocks', ({ closedBlocks }) => {
    const state = savedPlan();
    writeFinish(state);
    const removed = state.selected.map(target => ({ branchDeleted: true, closedBlocks, path: target }));
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), JSON.stringify({ ...state, removed }));
    expect(() => readFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });
});

describe('private finish storage and locking', () => {
  beforeEach(() => {
    useSandbox();
  });

  test('rejects plan ids with path components', () => {
    const failure = cliFailure(() => {
      finishDirectory('../state');
    });
    expect(failure.code).toBe('bad_args');
    expect(failure.message).toMatch(/\S/u);
  });

  test('requires a private directory for storage', () => {
    const base = finishDirectory();
    chmodSync(base, 0o755);
    const failure = cliFailure(() => {
      finishDirectory();
    });
    expect(failure.code).toBe('bad_args');
    expect(failure.message).toMatch(/\S/u);
  });

  test('rejects storage owned by another user', () => {
    const directory = finishDirectory();
    const owner = process.getuid?.() ?? 0;
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    try {
      expect(() => finishDirectory()).toThrow(expect.objectContaining({ code: 'bad_args' }));
    } finally {
      getuid.mockRestore();
      chmodSync(directory, 0o700);
    }
  });

  test('rejects a storage link even when its target is private', () => {
    const base = finishDirectory();
    rmSync(base, { recursive: true });
    const target = tempDir('finish-store-link');
    chmodSync(target, 0o700);
    symlinkSync(target, base);
    expect(() => finishDirectory()).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  test.each(['public file', 'directory', 'symbolic link'])('rejects a state saved as %s', kind => {
    writeFinish(savedPlan());
    const file = path.join(finishDirectory(planId), 'state.json');
    if (kind === 'public file') {
      chmodSync(file, 0o644);
    } else {
      const body = readFileSync(file);
      rmSync(file);
      if (kind === 'directory') {
        mkdirSync(file, { mode: 0o700 });
      } else {
        const target = path.join(tempDir('finish-state-link'), 'state.json');
        writeFileSync(target, body, { mode: 0o600 });
        symlinkSync(target, file);
      }
    }
    const failure = cliFailure(() => {
      readFinish(planId);
    });
    expect(failure.code).toBe('bad_args');
    expect(failure.message).toMatch(/\S/u);
  });

  test('serializes executors and releases a successful lock', () => {
    writeFinish(savedPlan());
    const release = lockFinish(planId);
    expect(release).not.toBeNull();
    expect(lockFinish(planId)).toBeNull();
    release?.();
    expect(existsSync(path.join(finishDirectory(planId), 'executor.lock'))).toBeFalsy();
  });

  test('propagates lock errors other than an existing lock', () => {
    finishDirectory();
    expect(() => lockFinish(planId)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('finish notices and acknowledgement', () => {
  beforeEach(() => {
    useSandbox();
  });

  test('lists pending and unshown completed results but not invalid plans', () => {
    const state = savedPlan();
    state.status = 'armed';
    writeFinish(state);
    const completed = { ...state, id: 'b'.repeat(48), status: 'completed' } satisfies StoredFinish;
    writeFinish(completed);
    mkdirSync(path.join(finishDirectory(), 'c'.repeat(48)), { mode: 0o700 });
    mkdirSync(path.join(finishDirectory(), 'not-a-plan'));
    expect(finishNoticeIds()).toStrictEqual({ completed: [completed.id], pending: [state.id] });
  });

  test.each(['planned', 'declined'] as const)('does not announce an unnotified %s plan as completed', status => {
    const state = savedPlan();
    state.status = status;
    writeFinish(state);
    expect(finishNoticeIds()).toStrictEqual({ completed: [], pending: [] });
  });

  test.each(['planned', 'declined', 'completed', 'running'] as const)('lists only reportable %s results', status => {
    const state = savedPlan();
    state.status = status;
    state.notified = true;
    writeFinish(state);
    expect(finishNoticeIds()).toStrictEqual({ completed: [], pending: status === 'running' ? [planId] : [] });
  });

  test('acknowledges a completed result without adding teardown targets', () => {
    const state = savedPlan();
    state.status = 'completed';
    writeFinish(state);
    expect(acknowledgeFinish(planId)).toStrictEqual({ acknowledged: true, id: planId });
    expect(readFinish(planId)).toStrictEqual({ ...state, notified: true });
    expect(finishNoticeIds()).toStrictEqual({ completed: [], pending: [] });
  });

  test('does not acknowledge a non-completed result or a locked executor', () => {
    writeFinish(savedPlan());
    expect(acknowledgeFinish(planId)).toStrictEqual({ acknowledged: false, id: planId });
    const release = lockFinish(planId);
    expect(acknowledgeFinish(planId)).toStrictEqual({ acknowledged: false, id: planId });
    release?.();
  });

  test('releases the acknowledgement lock after an invalid state', () => {
    writeFinish(savedPlan());
    writeFileSync(path.join(finishDirectory(planId), 'state.json'), 'null');
    expect(() => acknowledgeFinish(planId)).toThrow(expect.objectContaining({ code: 'bad_args' }));
    expect(existsSync(path.join(finishDirectory(planId), 'executor.lock'))).toBeFalsy();
  });
});
