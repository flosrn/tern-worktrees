import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { postMergeReady } from '../src/finish-workflows.ts';
import { api, configure, merge, proof, repo, runs, workflowRun } from './finish-workflow-fixture.ts';
import { ghFixture, useSandbox } from './helpers.ts';

describe('workflow applicability', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('is ready when the exact merge tree contains no workflows', async () => {
    configure([]);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not require a push run for a pull-request-only workflow', async () => {
    configure(['name: Review\non: pull_request\njobs: {}']);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('accepts a GitHub-confirmed successful push on the exact merge commit', async () => {
    configure(['name: Build\non: push\njobs: {}']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not wait for push workflows explicitly excluding the merge branch', async () => {
    configure(["on:\n  push:\n    branches: ['**', '!main']\njobs: {}"]);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not wait for a path-filtered workflow when the merge changes only docs', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']\njobs: {}"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'docs/guide.md', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('accepts a completed deployment chained from the merge build by workflow name', async () => {
    configure(['name: Build\non: push\njobs: {}', 'name: Deploy\non:\n  workflow_run:\n    workflows: [Build]\n    types: [completed]\njobs: {}']);
    runs(workflowRun(), workflowRun(2, { event: 'workflow_run' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not require a branch push for a tags-only workflow', async () => {
    configure(["on:\n  push:\n    tags: ['v*']\njobs: {}"]);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('waits for an observed deployment even when it was dispatched rather than pushed', async () => {
    configure(['name: Deploy\non: workflow_dispatch\njobs: {}']);
    runs(workflowRun(1, { conclusion: null, event: 'workflow_dispatch', status: 'waiting' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not require schedule, release or dispatch workflows that GitHub has not run', async () => {
    configure(['on:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}', 'on: release\njobs: {}', 'on: workflow_dispatch\njobs: {}']);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it.each(['skipped', 'neutral'])('accepts only GitHub-confirmed %s conclusions', async conclusion => {
    configure(['on: push\njobs: {}']);
    runs(workflowRun(1, { conclusion }));
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });
});

describe('workflow run evidence', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('does not invent a skipped result for an absent applicable workflow', async () => {
    configure(['on: push\njobs: {}']);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each([
    { conclusion: null, status: 'queued' },
    { conclusion: null, status: 'in_progress' },
    { conclusion: 'failure', status: 'completed' },
    { conclusion: 'cancelled', status: 'completed' },
    { conclusion: 'unrecognized', status: 'completed' },
  ])('keeps the worktree for an unfinished or unsuccessful result: %j', async state => {
    configure(['on: push\njobs: {}']);
    runs(workflowRun(1, state));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('waits for a newly enabled workflow instead of trusting only the known successful build', async () => {
    configure(['name: Build\non: push\njobs: {}', 'name: Surprise\non: push\njobs: {}']);
    runs(workflowRun(), workflowRun(2, { conclusion: null, status: 'queued' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each([
    { downstream: [] },
    { downstream: [workflowRun(2, { conclusion: null, event: 'workflow_run', status: 'waiting' })] },
    { downstream: [workflowRun(2, { conclusion: 'failure', event: 'workflow_run' })] },
    { downstream: [workflowRun(2, { event: 'workflow_dispatch' })] },
  ])('requires the chained deployment event and result: %j', async ({ downstream }) => {
    configure(['name: Build\non: push\njobs: {}', 'name: Deploy\non:\n  workflow_run:\n    workflows: [Build]\n    types: [completed]\njobs: {}']);
    runs(workflowRun(), ...downstream);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not await a downstream excluded by its upstream branch filter', async () => {
    configure(['name: Build\non: push\njobs: {}', 'name: Deploy\non:\n  workflow_run:\n    workflows: [Build]\n    branches: [release]\njobs: {}']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not accept a successful PR event as proof for the push event', async () => {
    configure(['on: [push, pull_request]\njobs: {}']);
    runs(workflowRun(1, { event: 'pull_request' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not accept a successful run on the PR head instead of the merge commit', async () => {
    configure(['on: push\njobs: {}']);
    runs(workflowRun(1, { head_sha: proof.headRefOid }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow filters', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('keeps unsupported GitHub glob syntax unknown instead of claiming exclusion', async () => {
    configure(["on:\n  push:\n    branches: ['release/[0-9]+']\njobs: {}"]);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('re-includes a branch after an ordered negative pattern', async () => {
    configure(["on:\n  push:\n    branches: ['**', '!main', 'main']\njobs: {}"]);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('matches a root file with a zero-directory double-star glob', async () => {
    configure(["on:\n  push:\n    paths: ['**/README.md']\njobs: {}"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'README.md', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('honors ordered path exclusions without requiring an absent run', async () => {
    configure(["on:\n  push:\n    paths: ['**', '!docs/**']\njobs: {}"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'docs/guide.md', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not await a workflow when all changed paths match paths-ignore', async () => {
    configure(["on:\n  push:\n    paths-ignore: ['docs/**']\njobs: {}"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'docs/guide.md', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not mistake an unavailable tree API for a repository without workflows', async () => {
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow API evidence', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('does not mistake a truncated merge tree for a complete workflow inventory', async () => {
    configure([]);
    api(`git/trees/${merge}?recursive=1`, { tree: [], truncated: true });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not silently accept malformed YAML at the exact merge reference', async () => {
    configure(['on: [push']);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not treat an unknown workflow state as disabled', async () => {
    configure(['on: push\njobs: {}']);
    api('actions/workflows?per_page=100&page=1', {
      total_count: 1,
      workflows: [{ id: 1, path: '.github/workflows/workflow-0.yml', state: 'unrecognized' }],
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not require a disabled workflow to produce a run', async () => {
    configure(['on: push\njobs: {}']);
    api('actions/workflows?per_page=100&page=1', {
      total_count: 1,
      workflows: [{ id: 1, path: '.github/workflows/workflow-0.yml', state: 'disabled_manually' }],
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not accept missing workflow identity as an inactive configuration', async () => {
    configure(['on: push\njobs: {}']);
    api('actions/workflows?per_page=100&page=1', { total_count: 0, workflows: [] });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('fails closed when GitHub cannot provide run results', async () => {
    configure(['on: push\njobs: {}']);
    ghFixture(['api', `repos/${repo}/actions/runs?head_sha=${merge}&per_page=100&page=1`], 'not JSON');
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not treat an empty event configuration as proof of no applicable workflow', async () => {
    configure(['on: {}\njobs: {}']);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not treat an unknown trigger as a known non-merge event', async () => {
    configure(['on: surprise_event\njobs: {}']);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not claim a push configuration with unknown filters is applicable and complete', async () => {
    configure(['on:\n  push:\n    unexpected_filter: ignored\njobs: {}']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow inventories and pagination', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each([
    null,
    { tree: [null], truncated: false },
    { tree: [{ path: 3, type: 'blob' }], truncated: false },
    { tree: [{ path: '.github/workflows/unsafe.yml', type: 'tree' }], truncated: false },
    { tree: [{ path: '.github/workflows/unsafe.yml', type: 'blob' }], truncated: false },
  ])('rejects an invalid merge tree: %j', async tree => {
    api(`git/trees/${merge}?recursive=1`, tree);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each([
    null,
    { total_count: 1 },
    { total_count: 0, workflows: [{ id: 1, path: 'extra', state: 'active' }] },
    { total_count: 1, workflows: [] },
    { total_count: 1, workflows: [null] },
  ])('rejects an unavailable or incomplete workflow inventory: %j', async inventory => {
    configure(['on: push']);
    api('actions/workflows?per_page=100&page=1', inventory);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('follows workflow inventory pagination before deciding applicability', async () => {
    configure(['on: pull_request']);
    api('actions/workflows?per_page=100&page=1', { total_count: 2, workflows: [{ id: 8, path: 'old.yml', state: 'deleted' }] });
    api('actions/workflows?per_page=100&page=2', { total_count: 2, workflows: [{ id: 1, path: '.github/workflows/workflow-0.yml', state: 'active' }] });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not infer completion beyond the workflow search limit', async () => {
    configure(['on: push']);
    api('actions/workflows?per_page=100&page=1', {
      total_count: 1001,
      workflows: Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, path: `old-${index}.yml`, state: 'active' })),
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each([null, { encoding: 'none', type: 'file' }, { content: '', encoding: 'base64', path: 'other.yml', type: 'file' }])(
    'rejects an unproven workflow source: %j',
    async source => {
      configure(['on: push']);
      api(`contents/.github/workflows/workflow-0.yml?ref=${merge}`, source);
      await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
    },
  );

  it.each([null, { id: 'not-an-id' }, { conclusion: 'success', event: 'push', head_branch: 'main', head_sha: merge, id: 1, status: 1, workflow_id: 1 }])(
    'rejects malformed workflow executions: %j',
    async execution => {
      configure(['on: push']);
      api(`actions/runs?head_sha=${merge}&per_page=100&page=1`, { total_count: 1, workflow_runs: [execution] });
      await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
    },
  );
});

describe('workflow YAML contracts', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each([
    'null',
    'on: null',
    'jobs: {}',
    'on: []',
    'on: true',
    'on:\n  push: false',
    'on:\n  push:\n    branches: main',
    'on:\n  push:\n    branches-ignore: false',
    'on:\n  workflow_run: null',
    'on:\n  workflow_run:\n    workflows: []',
  ])('rejects a workflow without a valid trigger contract: %s', async source => {
    configure([source]);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not require an empty push mapping to contain filters', async () => {
    configure(['on:\n  push: {}']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not mistake a literal single-star branch filter for double-star', async () => {
    configure(["on:\n  push:\n    branches: ['release/*']"]);
    api('pulls/7', { base: { ref: 'release/team/main' } });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it.each([
    "branches: ['!main']",
    "branches: ['']",
    "branches-ignore: ['!main']",
    "branches: ['main']\n    branches-ignore: ['other']",
    "paths: ['**']\n    paths-ignore: ['docs/**']",
  ])('does not infer applicability from conflicting filters: %s', async filters => {
    configure([`on:\n  push:\n    ${filters}`]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'source.ts', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('honors a branch-ignore exclusion', async () => {
    configure(["on:\n  push:\n    branches-ignore: ['main']"]);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('rejects a PR response without its merge branch', async () => {
    configure(['on: push']);
    api('pulls/7', null);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow path evidence', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each([null, { files: [null], sha: merge }, { files: [{ filename: 'new.ts', status: 'renamed' }], sha: merge }, { files: [], sha: 'different' }])(
    'rejects missing or invalid commit file evidence: %j',
    async commit => {
      configure(["on:\n  push:\n    paths: ['src/**']"]);
      api(`commits/${merge}?per_page=100&page=1`, commit);
      await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
    },
  );

  it('includes a renamed source path when deciding whether to await a workflow', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'docs/moved.md', previous_filename: 'src/old.ts', status: 'renamed' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('follows commit file pagination before concluding path exclusion', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: Array.from({ length: 100 }, (_, index) => ({ filename: `docs/${index}.md`, status: 'modified' })), sha: merge });
    api(`commits/${merge}?per_page=100&page=2`, { files: [{ filename: 'src/app.ts', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not infer path exclusion from a commit diff at the API file limit', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: Array.from({ length: 3000 }, (_, index) => ({ filename: `docs/${index}.md`, status: 'modified' })), sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow chain evidence', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('rejects unsupported workflow_run activity types', async () => {
    configure(['name: Build\non: push', 'on:\n  workflow_run:\n    workflows: [Build]\n    types: [unknown]']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not require a chain whose upstream is not triggered on the merge commit', async () => {
    configure(['name: Review\non: pull_request', 'on:\n  workflow_run:\n    workflows: [Review]']);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('requires a chain when an upstream PR-only workflow was actually observed', async () => {
    configure(['name: Review\non: pull_request', 'on:\n  workflow_run:\n    workflows: [Review]']);
    runs(workflowRun(1, { event: 'pull_request' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not infer chain linkage from an observed upstream on another branch', async () => {
    configure(['name: Review\non: pull_request', 'on:\n  workflow_run:\n    workflows: [Review]']);
    runs(workflowRun(1, { event: 'pull_request', head_branch: 'topic' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('requires both push and workflow_run events for a workflow with both triggers', async () => {
    configure(['name: First\non: push', 'name: Both\non:\n  push:\n  workflow_run:\n    workflows: [First]']);
    runs(workflowRun(), workflowRun(2), workflowRun(2, { event: 'workflow_run', id: 21 }));
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not consider an unknown conclusion complete even when status says completed', async () => {
    configure(['on: push']);
    runs(workflowRun(1, { conclusion: null }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});
