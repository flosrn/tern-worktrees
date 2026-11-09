import { ghMust } from './github.ts';
import { isJsonObject, isString } from './json.ts';
import { CliError } from './proc.ts';
import type { FinishPullRequest } from './finish-types.ts';

const oid = /^[a-f\d]{40,64}$/u;

export interface RawFinishPullRequest {
  number?: unknown;
  url?: unknown;
  headRefOid?: unknown;
  mergeCommit?: unknown;
  mergedAt?: unknown;
}

interface RawMergedPullRequest extends RawFinishPullRequest {
  state?: unknown;
  isCrossRepository?: unknown;
  headRefName?: unknown;
}

/** Validates a saved or remote merge proof before it can authorize teardown. */
export const isFinishPullRequest = (value: RawFinishPullRequest): value is FinishPullRequest => {
  if (!isJsonObject(value) || !Number.isSafeInteger(value.number) || Number(value.number) <= 0) {
    return false;
  }
  if (!isString(value.url) || !value.url.startsWith('https://')) {
    return false;
  }
  if (!isString(value.headRefOid) || !oid.test(value.headRefOid)) {
    return false;
  }
  if (!isString(value.mergeCommit) || !oid.test(value.mergeCommit)) {
    return false;
  }
  return isString(value.mergedAt) && Number.isFinite(Date.parse(value.mergedAt));
};

const parseMergedPullRequest = (value: RawMergedPullRequest, branch: string, head: string): FinishPullRequest | null => {
  if (!isJsonObject(value) || value.state !== 'MERGED' || value.isCrossRepository !== false) {
    return null;
  }
  if (value.headRefName !== branch || value.headRefOid !== head || !isJsonObject(value.mergeCommit)) {
    return null;
  }
  if (!('oid' in value.mergeCommit)) {
    return null;
  }
  const proof = {
    headRefOid: value.headRefOid,
    mergeCommit: value.mergeCommit.oid,
    mergedAt: value.mergedAt,
    number: value.number,
    url: value.url,
  };
  return isFinishPullRequest(proof) ? proof : null;
};

/** Requires MERGED on a non-fork PR with a matching branch and full HEAD. */
export const mergedProof = async (repo: string, branch: string, head: string): Promise<FinishPullRequest | null> => {
  const raw: unknown = JSON.parse(
    await ghMust(
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
    ),
  );
  if (!Array.isArray(raw)) {
    throw new CliError('gh_failed', 'Invalid merged pull request response');
  }
  for (const item of raw) {
    if (!isJsonObject(item)) {
      continue;
    }
    const proof = parseMergedPullRequest(item, branch, head);
    if (proof !== null) {
      return proof;
    }
  }
  return null;
};
