import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { ghFixture, ghLog, ghPrView, git, gitShim, managedPath, tempDir, tmpRepo, useGithubOrigin, useSandbox } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

let repo: RepoFixture;
let configFile = '';
let cloneRoot = '';
const url = 'https://github.com/virtusize/aoyama/issues/342';
const view = (extra = {}): void => {
  ghFixture(
    ['issue', 'view', '342', '--repo', 'virtusize/aoyama', '--json', 'number,title,labels,issueType,state'],
    JSON.stringify({ issueType: null, labels: [{ name: 'BUG' }], number: 342, state: 'OPEN', title: 'Fix the broken picker', ...extra }),
  );
};

describe('issue creation CLI', () => {
  beforeEach(async () => {
    configFile = path.join(useSandbox().pluginData, 'config.json');
    cloneRoot = tempDir('clones');
    writeFileSync(configFile, JSON.stringify({ cloneRoot }));
    repo = await tmpRepo('aoyama');
    await useGithubOrigin();
    view();
  });

  describe('create from an issue', () => {
    it('suggests a branch without making a branch or worktree', async () => {
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({
        branch: 'fix/342-fix-broken-picker',
        issue: { number: 342, title: 'Fix the broken picker', url },
        warnings: [],
      });
      expect(existsSync(managedPath('fix-342-fix-broken-picker'))).toBeFalsy();
      await expect(git(repo.dir, 'branch', '--list', 'fix/342-*')).resolves.toBe('');
      expect(ghLog()).toHaveLength(1);
    });

    it('creates the derived worktree and records ternIssue', async () => {
      const created = await run(['--repo', repo.dir, '--issue', url, '--no-tab']);
      expect(created).toMatchObject({ branch: 'fix/342-fix-broken-picker', issue: { number: 342, url }, status: 'created', warnings: [] });
      await expect(git(repo.dir, 'config', '--get', 'branch.fix/342-fix-broken-picker.ternIssue')).resolves.toBe(`${url}\n`);
      expect(ghLog()).toStrictEqual(['issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state']);
    });

    it('reuses the same branch and worktree on a second run', async () => {
      const first = await run(['--repo', repo.dir, '--issue', url, '--no-tab']);
      const second = await run(['--repo', repo.dir, '--issue', `${url}?tab=comments`, '--no-tab']);
      expect(second).toMatchObject({ branch: first.branch, path: managedPath('fix-342-fix-broken-picker'), status: 'reused' });
    });

    it('accepts a short issue number with a repo and an edited branch', async () => {
      await expect(run(['--repo', repo.dir, '--issue', '#342', '--branch', 'custom/name', '--no-tab'])).resolves.toMatchObject({ branch: 'custom/name', status: 'created' });
    });

    it('reuses an existing local branch even when its title differs', async () => {
      await git(repo.dir, 'branch', 'feat/342-old-title');
      await expect(run(['--repo', repo.dir, '--issue', '342', '--no-tab'])).resolves.toMatchObject({ branch: 'feat/342-old-title' });
    });

    it('prefers the linked issue branch over an earlier unlinked branch for suggestions and repeated creation', async () => {
      await git(repo.dir, 'branch', 'fix/342-mine');
      await git(repo.dir, 'config', 'branch.fix/342-mine.ternIssue', url);
      await git(repo.dir, 'branch', 'feat/342-colleague');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-mine' });
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ branch: 'fix/342-mine', status: 'created' });
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({
        branch: 'fix/342-mine',
        path: managedPath('fix-342-mine'),
        status: 'reused',
      });
    });

    it('reuses an explicitly selected existing branch', async () => {
      await git(repo.dir, 'branch', 'custom/existing');
      await expect(run(['--repo', repo.dir, '--issue', url, '--branch', 'custom/existing', '--no-tab'])).resolves.toMatchObject({ branch: 'custom/existing', status: 'created' });
      await expect(git(repo.dir, 'config', '--get', 'branch.custom/existing.ternIssue')).resolves.toBe(`${url}\n`);
    });

    it('reuses an issue branch that exists only on origin', async () => {
      await repo.pushBranch('feat/342-remote-title');
      await git(repo.dir, 'fetch', 'origin');
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ branch: 'feat/342-remote-title', status: 'created' });
      await expect(git(repo.dir, 'config', '--get', 'branch.feat/342-remote-title.merge')).resolves.toBe('refs/heads/feat/342-remote-title\n');
    });

    it('reuses a newly published issue branch before its first local fetch', async () => {
      await git(repo.origin, 'branch', 'feat/342-newly-published', 'main');
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ branch: 'feat/342-newly-published', status: 'created' });
      await expect(git(repo.dir, 'config', '--get', 'branch.feat/342-newly-published.merge')).resolves.toBe('refs/heads/feat/342-newly-published\n');
    });

    it('reuses the issue association when the repository URL casing changes', async () => {
      await run(['--repo', repo.dir, '--issue', url, '--no-tab']);
      ghFixture(
        ['issue', 'view', '342', '--repo', 'Virtusize/Aoyama', '--json', 'number,title,labels,issueType,state'],
        JSON.stringify({ issueType: null, labels: [{ name: 'BUG' }], number: 342, state: 'OPEN', title: 'Fix the broken picker' }),
      );
      await expect(run(['--repo', repo.dir, '--issue', 'https://github.com/Virtusize/Aoyama/issues/342', '--no-tab'])).resolves.toMatchObject({
        branch: 'fix/342-fix-broken-picker',
        path: managedPath('fix-342-fix-broken-picker'),
        status: 'reused',
      });
    });

    it('reuses an explicitly selected remote branch', async () => {
      await repo.pushBranch('custom/remote');
      await git(repo.dir, 'fetch', 'origin');
      await expect(run(['--repo', repo.dir, '--issue', url, '--branch', 'custom/remote', '--no-tab'])).resolves.toMatchObject({ branch: 'custom/remote', status: 'created' });
    });

    it('reuses an empty-slug branch on the next run', async () => {
      view({ title: 'the and !!!' });
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ branch: 'fix/342', status: 'created' });
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ branch: 'fix/342', path: managedPath('fix-342'), status: 'reused' });
    });

    it('does not confuse a longer issue number with the requested issue', async () => {
      await git(repo.dir, 'branch', 'fix/3420-unrelated');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-fix-broken-picker' });
    });

    it('warns for a closed issue in suggestions and creation', async () => {
      view({ state: 'CLOSED' });
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ warnings: ['This issue is closed.'] });
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ warnings: ['This issue is closed.'] });
    });
  });

  describe('issue branch collisions and GitHub development', () => {
    it('suffixes a collision whose branch records a different issue', async () => {
      await git(repo.dir, 'branch', 'fix/342-fix-broken-picker');
      await git(repo.dir, 'config', 'branch.fix/342-fix-broken-picker.ternIssue', 'https://github.com/elsewhere/repo/issues/342');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-fix-broken-picker-2' });
    });

    it.each(['garbage', '342', 'https://github.com/virtusize/aoyama/pull/342', 'https://github.com/virtusize/aoyama/issues/343'])(
      'does not reuse an association to %s',
      async association => {
        await git(repo.dir, 'branch', 'fix/342-fix-broken-picker');
        await git(repo.dir, 'config', 'branch.fix/342-fix-broken-picker.ternIssue', association);
        await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-fix-broken-picker-2' });
      },
    );

    it('skips every collision linked to a different issue', async () => {
      await git(repo.dir, 'branch', 'fix/342-fix-broken-picker');
      await git(repo.dir, 'config', 'branch.fix/342-fix-broken-picker.ternIssue', 'https://github.com/elsewhere/repo/issues/342');
      await git(repo.dir, 'branch', 'fix/342-fix-broken-picker-2');
      await git(repo.dir, 'config', 'branch.fix/342-fix-broken-picker-2.ternIssue', 'https://github.com/elsewhere/repo/issues/342');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-fix-broken-picker-3' });
    });

    it('finds a matching association after an unrelated issue branch', async () => {
      await git(repo.dir, 'branch', 'fix/342-a-unrelated');
      await git(repo.dir, 'config', 'branch.fix/342-a-unrelated.ternIssue', 'https://github.com/elsewhere/repo/issues/342');
      await git(repo.dir, 'branch', 'fix/342-z-linked');
      await git(repo.dir, 'config', 'branch.fix/342-z-linked.ternIssue', url);
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-z-linked' });
    });

    it('creates a named GitHub development branch only when enabled', async () => {
      writeFileSync(configFile, JSON.stringify({ cloneRoot, issueBranch: { linkOnGitHub: true } }));
      ghFixture(['issue', 'develop', '342', '--repo', 'virtusize/aoyama', '--name', 'fix/342-fix-broken-picker'], 'github.com/virtusize/aoyama/tree/fix/342-fix-broken-picker\n');
      await run(['--repo', repo.dir, '--issue', url, '--suggest']);
      expect(ghLog()).toStrictEqual(['issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state']);
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({ status: 'created' });
      expect(ghLog()).toStrictEqual([
        'issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state',
        'issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state',
        'issue develop 342 --repo virtusize/aoyama --name fix/342-fix-broken-picker',
      ]);
    });

    it('reuses a GitHub-linked branch and worktree on a second opt-in run', async () => {
      writeFileSync(configFile, JSON.stringify({ cloneRoot, issueBranch: { linkOnGitHub: true } }));
      // gh reuses a linked branch with the same --name.
      ghFixture(['issue', 'develop', '342', '--repo', 'virtusize/aoyama', '--name', 'fix/342-fix-broken-picker'], 'github.com/virtusize/aoyama/tree/fix/342-fix-broken-picker\n');
      const first = await run(['--repo', repo.dir, '--issue', url, '--no-tab']);
      expect(first).toMatchObject({ branch: 'fix/342-fix-broken-picker', status: 'created' });
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).resolves.toMatchObject({
        branch: first.branch,
        issue: { number: 342, url },
        path: managedPath('fix-342-fix-broken-picker'),
        status: 'reused',
      });
      await expect(git(repo.dir, 'config', '--get', 'branch.fix/342-fix-broken-picker.ternIssue')).resolves.toBe(`${url}\n`);
      expect(ghLog()).toStrictEqual([
        'issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state',
        'issue develop 342 --repo virtusize/aoyama --name fix/342-fix-broken-picker',
        'issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state',
        'issue develop 342 --repo virtusize/aoyama --name fix/342-fix-broken-picker',
      ]);
    });

    it('reports GitHub development branch failures instead of claiming a link', async () => {
      writeFileSync(configFile, JSON.stringify({ cloneRoot, issueBranch: { linkOnGitHub: true } }));
      await expect(run(['--repo', repo.dir, '--issue', url, '--no-tab'])).rejects.toMatchObject({ code: 'gh_failed' });
      await expect(git(repo.dir, 'config', '--get', 'branch.fix/342-fix-broken-picker.ternIssue')).resolves.toBe(`${url}\n`);
    });

    it('rejects a derived branch that git does not accept', async () => {
      await gitShim('if [ "$3 $4 $5" = "check-ref-format --branch fix/342-fix-broken-picker" ]; then exit 1; fi');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).rejects.toMatchObject({ code: 'bad_args', message: 'bad branch name fix/342-fix-broken-picker' });
      await expect(git(repo.dir, 'branch', '--list', 'fix/342-*')).resolves.toBe('');
    });

    it('rejects an invalid branch override even for a read-only suggestion', async () => {
      await expect(run(['--repo', repo.dir, '--issue', url, '--branch', 'bad..branch', '--suggest'])).rejects.toMatchObject({
        code: 'bad_args',
        message: 'bad branch name bad..branch',
      });
      await expect(git(repo.dir, 'branch', '--list', 'fix/342-*')).resolves.toBe('');
    });

    it('suggests a new branch when no existing refs are listed', async () => {
      await gitShim('if [ "$3" = "for-each-ref" ]; then exit 0; fi');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ branch: 'fix/342-fix-broken-picker' });
    });
  });

  describe('issue reference resolution', () => {
    it('maps a pull request URL to the existing PR flow', async () => {
      await repo.pushBranch('feature/x');
      ghPrView();
      await expect(run(['--repo', repo.dir, '--issue', 'https://github.com/virtusize/aoyama/pull/7', '--no-tab'])).resolves.toMatchObject({
        branch: 'feature/x',
        status: 'created',
        warnings: [],
      });
    });

    it.each([[['--suggest']], [['--branch', 'custom/name']]])('rejects PR-only incompatible flags %j', async flags => {
      await expect(run(['--repo', repo.dir, '--issue', 'https://github.com/virtusize/aoyama/pull/7', ...flags])).rejects.toMatchObject({
        code: 'bad_args',
        message: '--branch and --suggest do not apply to a pull request URL',
      });
      expect(ghLog()).toStrictEqual([]);
    });

    it.each([
      [['--issue', '342'], 'an issue number needs --repo'],
      [['--issue', 'garbage'], 'bad issue reference garbage'],
      [['--suggest'], '--suggest needs --issue'],
      [['--issue', url, '--new'], '--issue does not combine with --pr or --new'],
      [['--issue', url, '--pr', '7'], '--issue does not combine with --pr or --new'],
    ])('rejects invalid issue arguments %j', async (args, message) => {
      await expect(run(args)).rejects.toMatchObject({ code: 'bad_args', message });
      expect(ghLog()).toStrictEqual([]);
    });

    it('reports a missing clone without cloning it', async () => {
      await expect(run(['--issue', url, '--suggest'])).rejects.toMatchObject({
        code: 'not_cloned',
        extra: { path: path.join(cloneRoot, 'virtusize', 'aoyama'), repo: 'virtusize/aoyama' },
        message: `virtusize/aoyama is not cloned at ${path.join(cloneRoot, 'virtusize', 'aoyama')}`,
      });
      expect(ghLog()).toStrictEqual([]);
      expect(existsSync(path.join(cloneRoot, 'virtusize', 'aoyama'))).toBeFalsy();
    });

    it('uses the matching --repo even when the configured clone path is absent', async () => {
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).resolves.toMatchObject({ repo: repo.dir });
      expect(existsSync(path.join(cloneRoot, 'virtusize', 'aoyama'))).toBeFalsy();
    });

    it.each(['absent', 'mismatched', 'non-github'])('finds a configured clone when --repo is %s', async source => {
      const cloned = path.join(cloneRoot, 'virtusize', 'aoyama');
      mkdirSync(path.dirname(cloned), { recursive: true });
      await git(cloneRoot, 'clone', '--quiet', repo.origin, cloned);
      if (source !== 'absent') {
        const origin = source === 'mismatched' ? 'https://github.com/elsewhere/repo.git' : 'https://gitlab.com/virtusize/aoyama.git';
        await gitShim(`if [ "$2" = "${repo.dir}" ] && [ "$3 $4 $5" = "remote get-url origin" ]; then echo '${origin}'; exit 0; fi`);
      }
      await expect(run([...(source === 'absent' ? [] : ['--repo', repo.dir]), '--issue', url, '--suggest'])).resolves.toMatchObject({ repo: cloned });
      expect(ghLog()).toStrictEqual(['issue view 342 --repo virtusize/aoyama --json number,title,labels,issueType,state']);
    });

    it('reports not_cloned for a mismatched repo without silently cloning', async () => {
      await useGithubOrigin('https://github.com/elsewhere/repo.git');
      await expect(run(['--repo', repo.dir, '--issue', url, '--suggest'])).rejects.toMatchObject({
        code: 'not_cloned',
        extra: { path: path.join(cloneRoot, 'virtusize', 'aoyama'), repo: 'virtusize/aoyama' },
        message: `virtusize/aoyama is not cloned at ${path.join(cloneRoot, 'virtusize', 'aoyama')}`,
      });
      expect(ghLog()).toStrictEqual([]);
    });

    it('does not replace a conflicting clone path', async () => {
      const cloned = path.join(cloneRoot, 'virtusize', 'aoyama');
      mkdirSync(cloned, { recursive: true });
      await expect(run(['--issue', url, '--suggest'])).rejects.toMatchObject({ code: 'not_cloned', extra: { path: cloned } });
      expect(ghLog()).toStrictEqual([]);
      expect(existsSync(cloned)).toBeTruthy();
    });

    it.each(['', 'https://gitlab.com/virtusize/aoyama.git'])('rejects short references without a GitHub origin: %s', async origin => {
      await gitShim(`if [ "$3 $4 $5" = "remote get-url origin" ]; then printf '%s' '${origin}'; exit 0; fi`);
      await expect(run(['--repo', repo.dir, '--issue', '342', '--suggest'])).rejects.toMatchObject({ code: 'bad_args', message: '--issue needs a GitHub origin' });
      expect(ghLog()).toStrictEqual([]);
    });
  });
});
