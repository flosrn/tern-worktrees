import type { FinishPullRequest } from '../src/finish-types.ts';
import { ghFixture } from './helpers.ts';

export const repo = 'owner/name';
export const merge = 'a'.repeat(40);
export const proof: FinishPullRequest = {
  headRefOid: 'b'.repeat(40),
  mergeCommit: merge,
  mergedAt: '2026-11-08T12:00:00Z',
  number: 7,
  url: 'https://github.com/owner/name/pull/7',
};

type FixtureValue = string | number | boolean | null | FixtureValue[] | { [key: string]: FixtureValue | undefined };

/** Records a GitHub API fixture. */
export const api = (endpoint: string, value: FixtureValue): void => {
  ghFixture(['api', `repos/${repo}/${endpoint}`], JSON.stringify(value));
};

/** Records workflows and their source files for the merge commit. */
export const configure = (sources: string[]): void => {
  api(`git/trees/${merge}?recursive=1`, {
    sha: merge,
    tree: sources.map((_, index) => ({ mode: '100644', path: `.github/workflows/workflow-${index}.yml`, sha: 'c'.repeat(40), type: 'blob' })),
    truncated: false,
  });
  api('actions/workflows?per_page=100&page=1', {
    total_count: sources.length,
    workflows: sources.map((_, index) => ({ id: index + 1, name: `Workflow ${index}`, path: `.github/workflows/workflow-${index}.yml`, state: 'active' })),
  });
  for (const [index, source] of sources.entries()) {
    api(`contents/.github/workflows/workflow-${index}.yml?ref=${merge}`, {
      content: Buffer.from(source).toString('base64'),
      encoding: 'base64',
      path: `.github/workflows/workflow-${index}.yml`,
      type: 'file',
    });
  }
  api('pulls/7', { base: { ref: 'main' } });
  api(`actions/runs?head_sha=${merge}&per_page=100&page=1`, { total_count: 0, workflow_runs: [] });
};

interface RunFixture {
  conclusion: string | null;
  created_at: string;
  event: string;
  head_branch: string;
  head_sha: string;
  id: number;
  run_attempt: number;
  run_number: number;
  status: string;
  workflow_id: number;
}

/** Builds a successful workflow run with optional field overrides. */
export const workflowRun = (workflowId = 1, overrides: Partial<RunFixture> = {}): RunFixture => ({
  conclusion: 'success',
  created_at: '2026-11-08T12:00:01Z',
  event: 'push',
  head_branch: 'main',
  head_sha: merge,
  id: workflowId * 10,
  run_attempt: 1,
  run_number: 1,
  status: 'completed',
  workflow_id: workflowId,
  ...overrides,
});

/** Records workflow runs for the merge commit. */
export const runs = (...values: RunFixture[]): void => {
  api(`actions/runs?head_sha=${merge}&per_page=100&page=1`, { total_count: values.length, workflow_runs: values.map(value => ({ ...value })) });
};
