import { beforeEach, describe, expect, test } from 'vite-plus/test';
import { mergedProof } from '../src/finish-proof.ts';
import { CliError } from '../src/proc.ts';
import { ghFixture, useSandbox } from './helpers.ts';

const head = 'b'.repeat(40);
const branch = 'delivered';
const repo = 'example/repo';
const args = [
  'pr',
  'list',
  '--repo',
  repo,
  '--head',
  branch,
  '--state',
  'merged',
  '--limit',
  '100',
  '--json',
  'number,url,headRefName,headRefOid,mergeCommit,mergedAt,state,isCrossRepository',
];
const pullRequest = {
  headRefName: branch,
  headRefOid: head,
  isCrossRepository: false,
  mergeCommit: { oid: head },
  mergedAt: '2026-11-01T10:00:00Z',
  number: 7,
  state: 'MERGED',
  url: 'https://github.com/example/repo/pull/7',
};

// SAFETY: Read-only tuples keep each invalid response and its test name as a pair.
const invalidEntries = [
  ['non-object', null],
  ['array', []],
  ['state', { ...pullRequest, state: 'OPEN' }],
  ['fork', { ...pullRequest, isCrossRepository: true }],
  ['branch', { ...pullRequest, headRefName: 'other' }],
  ['head', { ...pullRequest, headRefOid: 'c'.repeat(40) }],
  ['commit object', { ...pullRequest, mergeCommit: null }],
  ['commit missing oid', { ...pullRequest, mergeCommit: {} }],
  ['number type', { ...pullRequest, number: '7' }],
  ['number zero', { ...pullRequest, number: 0 }],
  ['number fraction', { ...pullRequest, number: 1.5 }],
  ['url type', { ...pullRequest, url: 7 }],
  ['url protocol', { ...pullRequest, url: 'ssh://github.com/example/repo/pull/7' }],
  ['commit oid type', { ...pullRequest, mergeCommit: { oid: 4 } }],
  ['commit oid value', { ...pullRequest, mergeCommit: { oid: 'invalid' } }],
  ['merge date type', { ...pullRequest, mergedAt: 7 }],
  ['merge date value', { ...pullRequest, mergedAt: 'invalid' }],
] as const;

const proofFailure = async (): Promise<{ code: string | null; hasDiagnostic: boolean }> => {
  try {
    await mergedProof(repo, branch, head);
    return { code: null, hasDiagnostic: false };
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    return { code: error.code, hasDiagnostic: error.message.trim().length > 0 };
  }
};

describe('finish merge proof boundary', () => {
  beforeEach(() => {
    useSandbox();
  });

  test('returns a merged non-fork proof for the pinned branch and head', async () => {
    ghFixture(args, JSON.stringify([pullRequest]));
    await expect(mergedProof(repo, branch, head)).resolves.toStrictEqual({
      headRefOid: head,
      mergeCommit: head,
      mergedAt: '2026-11-01T10:00:00Z',
      number: 7,
      url: 'https://github.com/example/repo/pull/7',
    });
  });

  test.each(invalidEntries)('does not authorize teardown for %s', async (_label, value) => {
    ghFixture(args, JSON.stringify([value]));
    await expect(mergedProof(repo, branch, head)).resolves.toBeNull();
  });

  test('rejects an invalid head even when GitHub returns the requested value', async () => {
    ghFixture(args, JSON.stringify([{ ...pullRequest, headRefOid: 'invalid' }]));
    await expect(mergedProof(repo, branch, 'invalid')).resolves.toBeNull();
  });

  test.each([`prefix-${head}`, `${head}-suffix`])('rejects a matching requested and reported non-hex head %s', async invalidHead => {
    ghFixture(args, JSON.stringify([{ ...pullRequest, headRefOid: invalidHead }]));
    await expect(mergedProof(repo, branch, invalidHead)).resolves.toBeNull();
  });

  test('continues after invalid entries to find a matching proof', async () => {
    ghFixture(args, JSON.stringify([null, { ...pullRequest, state: 'OPEN' }, pullRequest]));
    await expect(mergedProof(repo, branch, head)).resolves.toMatchObject({ headRefOid: head, number: 7 });
  });

  test('does not invent proof when no pull request matches', async () => {
    ghFixture(args, '[]');
    await expect(mergedProof(repo, branch, head)).resolves.toBeNull();
  });

  test.each(['null', '{}', '7'])('rejects a non-array GitHub response %s', async body => {
    ghFixture(args, body);
    await expect(proofFailure()).resolves.toStrictEqual({ code: 'gh_failed', hasDiagnostic: true });
  });

  test('reports a public failure with a diagnostic when the GitHub CLI exits nonzero', async () => {
    await expect(proofFailure()).resolves.toStrictEqual({ code: 'gh_failed', hasDiagnostic: true });
  });

  test('propagates malformed GitHub JSON', async () => {
    ghFixture(args, '{');
    await expect(mergedProof(repo, branch, head)).rejects.toThrow(SyntaxError);
  });
});
