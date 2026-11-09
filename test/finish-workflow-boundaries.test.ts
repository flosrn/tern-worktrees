import { writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { postMergeReady } from '../src/finish-workflows.ts';
import { api, configure, merge, proof, repo, runs, workflowRun } from './finish-workflow-fixture.ts';
import { ghFixture, tempDir, useSandbox } from './helpers.ts';

describe('workflow proof boundaries', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each(['prefix.github/workflows/build.yml', '.github/workflows/build.yml.backup', '.github/workflows/nested/build.yml', 'README.md'])(
    'does not treat a non-workflow tree path as an enabled workflow: %s',
    async path => {
      configure([]);
      api(`git/trees/${merge}?recursive=1`, { tree: [{ mode: '100644', path, type: 'blob' }], truncated: false });
      await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
    },
  );

  it.each([
    { mode: '100644', path: '.github/workflows/workflow-0.yml', type: 'tree' },
    { mode: '120000', path: '.github/workflows/workflow-0.yml', type: 'blob' },
    { path: 'README.md', type: 3 },
  ])('rejects an unproven tree entry even when the remaining APIs would permit teardown: %j', async entry => {
    configure(['on: pull_request']);
    api(`git/trees/${merge}?recursive=1`, { tree: [entry], truncated: false });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('reads executable workflow files as well as ordinary files', async () => {
    configure(['on: pull_request']);
    api(`git/trees/${merge}?recursive=1`, { tree: [{ mode: '100755', path: '.github/workflows/workflow-0.yml', type: 'blob' }], truncated: false });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it.each([
    { id: '2', path: 'old.yml', state: 'active' },
    { id: 1.5, path: 'old.yml', state: 'active' },
    { id: 2, path: 3, state: 'active' },
    { id: 2, path: 'old.yml', state: 3 },
  ])('does not ignore malformed extra workflow identities: %j', async identity => {
    configure(['on: pull_request']);
    api('actions/workflows?per_page=100&page=1', {
      total_count: 2,
      workflows: [{ id: 1, path: '.github/workflows/workflow-0.yml', state: 'active' }, identity],
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not choose one of two identities for the same workflow path', async () => {
    configure(['on: pull_request']);
    api('actions/workflows?per_page=100&page=1', {
      total_count: 2,
      workflows: [1, 2].map(id => ({ id, path: '.github/workflows/workflow-0.yml', state: 'active' })),
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each(['deleted', 'disabled_fork', 'disabled_inactivity'])('does not await a GitHub-confirmed inactive workflow: %s', async state => {
    configure(['on: push']);
    api('actions/workflows?per_page=100&page=1', { total_count: 1, workflows: [{ id: 1, path: '.github/workflows/workflow-0.yml', state }] });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it.each([
    { encoding: 'base64', type: 'symlink' },
    { encoding: 'none', type: 'file' },
  ])('rejects workflow content without its file and encoding contract: %j', async metadata => {
    configure(['on: pull_request']);
    api(`contents/.github/workflows/workflow-0.yml?ref=${merge}`, {
      content: Buffer.from('on: pull_request').toString('base64'),
      path: '.github/workflows/workflow-0.yml',
      ...metadata,
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each([{ id: '1' }, { id: 1.5 }, { workflow_id: '1' }, { workflow_id: 1.5 }, { event: 3 }, { head_branch: 3 }])(
    'rejects malformed observed executions even without an expected push: %j',
    async fields => {
      configure(['on: pull_request']);
      api(`actions/runs?head_sha=${merge}&per_page=100&page=1`, { total_count: 1, workflow_runs: [{ ...workflowRun(), ...fields }] });
      await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
    },
  );

  it('does not require unavailable workflow APIs when the merge tree contains no workflows', async () => {
    configure([]);
    ghFixture(['api', `repos/${repo}/actions/workflows?per_page=100&page=1`], 'not JSON');
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not require a merge branch for workflows that cannot be triggered by the merge', async () => {
    configure(['on: pull_request']);
    api('pulls/7', null);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });
});

describe('workflow applicability boundaries', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('accepts a sequence of non-merge events without inventing a push run', async () => {
    configure(['on: [pull_request, workflow_dispatch]']);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('keeps a mixed known and unknown event configuration unproven', async () => {
    configure(['on: [push, surprise_event]']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each(['tags: []', "tags: ['v*', 3]", "branches-ignore: ['**', '!release']"])('does not infer exclusion from an invalid push filter: %s', async filters => {
    configure([`on:\n  push:\n    ${filters}`]);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not infer exclusion from conflicting branch filters', async () => {
    configure(['on:\n  push:\n    branches: [release]\n    branches-ignore: [other]']);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each([
    { branch: 'release/stable', pattern: 'release/*' },
    { branch: 'release/team/main', pattern: 'release/**' },
  ])('awaits an applicable wildcard branch instead of declaring it excluded: %j', async ({ branch, pattern }) => {
    configure([`on:\n  push:\n    branches: ['${pattern}']`]);
    api('pulls/7', { base: { ref: branch } });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('matches a nested file with a double-star directory prefix', async () => {
    configure(["on:\n  push:\n    paths: ['**/README.md']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'docs/deep/README.md', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('awaits a paths-ignore workflow when any changed file is not ignored', async () => {
    configure(["on:\n  push:\n    paths-ignore: ['docs/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, {
      files: [
        { filename: 'docs/guide.md', status: 'modified' },
        { filename: 'src/app.ts', status: 'modified' },
      ],
      sha: merge,
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('reads changed files when only one of several workflows uses path filters', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']", 'on: pull_request']);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'src/app.ts', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow run and chain boundaries', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('requires a completed status even when a queued run claims success', async () => {
    configure(['on: push']);
    runs(workflowRun(1, { status: 'queued' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not reuse one workflow run for another workflow awaiting the same event', async () => {
    configure(['on: push', 'on: push']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not reuse a successful merge-commit run from another branch', async () => {
    configure(['on: push']);
    runs(workflowRun(1, { head_branch: 'topic' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each(['[unknown]', '[completed, unknown]', '[]'])('does not authorize teardown from a successful chain with invalid activity types: %s', async types => {
    configure(['name: Build\non: push', `on:\n  workflow_run:\n    workflows: [Build]\n    types: ${types}`]);
    runs(workflowRun(), workflowRun(2, { event: 'workflow_run' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each(['requested', 'in_progress'])('recognizes a completed chain triggered by the %s activity', async type => {
    configure(['name: Build\non: push', `on:\n  workflow_run:\n    workflows: [Build]\n    types: [${type}]`]);
    runs(workflowRun(), workflowRun(2, { event: 'workflow_run' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not link a deployment to a different workflow name', async () => {
    configure(['name: Build\non: push', 'on:\n  workflow_run:\n    workflows: [Other]']);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('waits for all chain stages regardless of workflow inventory order', async () => {
    configure(['name: Deploy\non:\n  workflow_run:\n    workflows: [Package]', 'name: Package\non:\n  workflow_run:\n    workflows: [Build]', 'name: Build\non: push']);
    runs(workflowRun(3), workflowRun(2, { event: 'workflow_run' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow pagination boundaries', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each([
    { total_count: 1, workflows: [] },
    { total_count: 0, workflows: [{ id: 1, path: '.github/workflows/workflow-0.yml', state: 'active' }] },
  ])('does not repair an inconsistent inventory using a later response: %j', async page => {
    configure(['on: pull_request']);
    api('actions/workflows?per_page=100&page=1', page);
    api('actions/workflows?per_page=100&page=2', {
      total_count: 1,
      workflows: page.workflows.length === 0 ? [{ id: 1, path: '.github/workflows/workflow-0.yml', state: 'active' }] : [],
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not continue past the workflow search limit even if another page would look complete', async () => {
    configure(['on: pull_request']);
    api('actions/workflows?per_page=100&page=1', {
      total_count: 1001,
      workflows: Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, path: index === 0 ? '.github/workflows/workflow-0.yml' : `old-${index}.yml`, state: 'active' })),
    });
    api('actions/workflows?per_page=100&page=2', { total_count: 1001, workflows: [{ id: 1001, path: 'old-1000.yml', state: 'active' }] });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('can prove path exclusion after a full page followed by an empty final page', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: Array.from({ length: 100 }, (_, index) => ({ filename: `docs/${index}.md`, status: 'modified' })), sha: merge });
    api(`commits/${merge}?per_page=100&page=2`, { files: [], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('does not accept a final empty page as proof beyond the commit file limit', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: Array.from({ length: 3000 }, (_, index) => ({ filename: `docs/${index}.md`, status: 'modified' })), sha: merge });
    api(`commits/${merge}?per_page=100&page=2`, { files: [], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow external contract regressions', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('rejects non-text workflow content even when its bytes decode to valid YAML', async () => {
    configure(['on: pull_request']);
    api(`contents/.github/workflows/workflow-0.yml?ref=${merge}`, {
      content: [...Buffer.from('on: pull_request')],
      encoding: 'base64',
      path: '.github/workflows/workflow-0.yml',
      type: 'file',
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('rejects valid workflow content returned for a different path', async () => {
    configure(['on: pull_request']);
    api(`contents/.github/workflows/workflow-0.yml?ref=${merge}`, {
      content: Buffer.from('on: pull_request').toString('base64'),
      encoding: 'base64',
      path: '.github/workflows/other.yml',
      type: 'file',
    });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not require a branch push for a tags-ignore-only workflow', async () => {
    configure(["on:\n  push:\n    tags-ignore: ['v*']"]);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it.each(['branches: false', 'branches-ignore: false'])('does not accept malformed chain branch filters just because every run succeeded: %s', async filters => {
    configure(['name: Build\non: push', `on:\n  workflow_run:\n    workflows: [Build]\n    ${filters}`]);
    runs(workflowRun(), workflowRun(2, { event: 'workflow_run' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not accept contradictory path filters just because the push succeeded', async () => {
    configure(["on:\n  push:\n    paths: ['src/**']\n    paths-ignore: ['docs/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'src/app.ts', status: 'modified' }], sha: merge });
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('can exclude files outside a double-star directory pattern', async () => {
    configure(["on:\n  push:\n    paths: ['**/README.md']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename: 'docs/guide.md', status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it.each([
    { filename: 'docs/guide.md', status: 3 },
    { filename: 3, status: 'modified' },
    { filename: 'docs/renamed.md', status: 'renamed' },
  ])('does not prove path exclusion with malformed changed-file metadata: %j', async file => {
    configure(["on:\n  push:\n    paths: ['src/**']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [file], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('does not infer a chain from a different observed workflow', async () => {
    configure(['name: Review\non: pull_request', 'name: Other\non: workflow_dispatch', 'on:\n  workflow_run:\n    workflows: [Review]']);
    runs(workflowRun(2, { event: 'workflow_dispatch' }));
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });

  it('returns a boolean refusal when GitHub proof is not JSON', async () => {
    ghFixture(['api', `repos/${repo}/git/trees/${merge}?recursive=1`], 'not JSON');
    const ready = await postMergeReady(repo, proof);
    expect({ allowed: ready }).toStrictEqual({ allowed: false });
  });
});

describe('workflow API failure responses', () => {
  it('rejects a nonzero GitHub response even when stdout contains a complete merge tree', async () => {
    const sandbox = useSandbox();
    const endpoint = `repos/${repo}/git/trees/${merge}?recursive=1`;
    const key = ['api', endpoint].join('_').replaceAll(/[/ ]/gu, '_');
    api(`git/trees/${merge}?recursive=1`, { tree: [], truncated: false });
    writeFileSync(nodePath.join(sandbox.ghDir, `${key}.status`), '1');
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('recognized non-merge workflow events', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each([
    'branch_protection_rule',
    'check_run',
    'check_suite',
    'create',
    'delete',
    'deployment',
    'deployment_status',
    'discussion',
    'discussion_comment',
    'fork',
    'gollum',
    'image_version',
    'issue_comment',
    'issues',
    'label',
    'merge_group',
    'milestone',
    'page_build',
    'public',
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'pull_request_target',
    'registry_package',
    'release',
    'repository_dispatch',
    'schedule',
    'status',
    'watch',
    'workflow_call',
    'workflow_dispatch',
  ])('does not require an absent run for the recognized %s event', async event => {
    configure([`on: ${event}`]);
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });
});

describe('workflow directory glob boundaries', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each(['prefixREADME.md', 'docs/prefixREADME.md'])('does not treat a filename prefix as a directory matched by **/: %s', async filename => {
    configure(["on:\n  push:\n    paths: ['**/README.md']"]);
    api(`commits/${merge}?per_page=100&page=1`, { files: [{ filename, status: 'modified' }], sha: merge });
    await expect(postMergeReady(repo, proof)).resolves.toBeTruthy();
  });
});

describe('workflow primitive payload refusals', () => {
  beforeEach(() => {
    useSandbox();
  });

  it.each([3, false, 'not-an-entry'])('does not treat a primitive tree entry as proof that no workflows exist: %j', async entry => {
    api(`git/trees/${merge}?recursive=1`, { tree: [entry], truncated: false });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it.each(['true', 'false', '[]'])('rejects a primitive push configuration even with a successful push run: %s', async push => {
    configure([`on:\n  push: ${push}`]);
    runs(workflowRun());
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });

  it('rejects malformed pull base evidence even when a tags-only workflow excludes branch pushes', async () => {
    configure(["on:\n  push:\n    tags: ['v*']"]);
    api('pulls/7', { base: 3 });
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});

describe('workflow parser process failures', () => {
  it('rejects successful-looking workflow JSON when the parser process fails after writing stdout', async () => {
    useSandbox();
    configure(['on: pull_request']);
    const bin = tempDir('finish-workflow-parser');
    writeFileSync(nodePath.join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' \'{"on":"pull_request"}\'\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    await expect(postMergeReady(repo, proof)).resolves.toBeFalsy();
  });
});
