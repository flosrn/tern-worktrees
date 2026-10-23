import { loadConfig } from './config.ts';
import { gitMust, gitRun, gitSucceeds, requireRepoRoot } from './git.ts';
import { clonePath, ghMust, readOrigin } from './github.ts';
import { issueBranchName } from './issue.ts';
import { CliError } from './proc.ts';
import { nameWithOwner, parseIssueRef, repoKey } from './repo-ref.ts';
import type { GithubRepoRef } from './repo-ref.ts';

/** The issue identity recorded on a branch and returned by create. */
export interface CreatedIssue {
  number: number;
  url: string;
  title: string;
}
interface IssueView {
  number: number;
  title: string;
  labels: { name: string }[];
  issueType?: { name: string } | null;
  state: string;
}

/** The issue identity and the GitHub fields used to select its branch. */
export interface IssueData {
  issue: CreatedIssue;
  view: IssueView;
}

/** A read-only issue branch suggestion. */
export interface SuggestedIssue {
  branch: string;
  issue: CreatedIssue;
  repo: string;
  warnings: string[];
}
/** A resolved issue or pull request, without checkout changes. */
export interface IssueInput {
  root: string;
  repo: GithubRepoRef;
  number: string;
  kind: 'issue' | 'pr';
}

/** Resolves an issue reference to a checkout. Does not clone. */
export const resolveIssue = async (text: string, dir?: string): Promise<IssueInput> => {
  const ref = parseIssueRef(text);
  if (ref === null) {
    throw new CliError('bad_args', `bad issue reference ${text}`);
  }
  if (ref.repo === null && dir === undefined) {
    throw new CliError('bad_args', 'an issue number needs --repo');
  }
  let { repo } = ref;
  if (dir !== undefined) {
    const root = await requireRepoRoot(dir);
    const { github: origin } = await readOrigin(root);
    if (origin !== null) {
      repo ??= origin;
      if (repoKey(origin) === repoKey(repo)) {
        return { ...ref, repo, root };
      }
    }
  }
  if (repo === null) {
    throw new CliError('bad_args', '--issue needs a GitHub origin');
  }
  const found = await clonePath(repo);
  if (found.state !== 'clone') {
    throw new CliError('not_cloned', `${nameWithOwner(repo)} is not cloned at ${found.root}`, { path: found.root, repo: nameWithOwner(repo) });
  }
  return { ...ref, repo, root: found.root };
};

/** Reads the issue fields needed for its branch and warning. */
export const readIssue = async (input: IssueInput): Promise<IssueData> => {
  const json = await ghMust('issue', 'view', input.number, '--repo', nameWithOwner(input.repo), '--json', 'number,title,labels,issueType,state');
  // SAFETY: gh issue view prints the fields requested by --json.
  const view = JSON.parse(json) as IssueView;
  return { issue: { number: view.number, title: view.title, url: `https://github.com/${nameWithOwner(input.repo)}/issues/${input.number}` }, view };
};

/** Selects an issue branch to reuse or a derived branch to make, respecting an explicit override. */
export const chooseIssueBranch = async (input: IssueInput, view: IssueView, override?: string): Promise<{ branch: string; isNew: boolean }> => {
  const output = await gitMust(input.root, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin');
  const branches = [...new Set(output.split('\n').map(ref => ref.replace(/refs\/(?:heads\/|remotes\/origin\/)/u, '')))];
  if (override !== undefined) {
    if (!(await gitSucceeds(input.root, 'check-ref-format', '--branch', override))) {
      throw new CliError('bad_args', `bad branch name ${override}`);
    }
    return { branch: override, isNew: !branches.includes(override) };
  }
  const related = branches.filter(branch => ['fix', 'feat'].some(prefix => branch === `${prefix}/${input.number}` || branch.startsWith(`${prefix}/${input.number}-`)));
  const base = issueBranchName(view.number, view.title, view.issueType, view.labels, loadConfig().issueBranch.fixLabels);
  const links = await Promise.all(
    related.map(async branch => {
      const result = await gitRun(input.root, 'config', '--get', `branch.${branch}.ternIssue`);
      return { branch, result };
    }),
  );
  const existing =
    links.find(({ result }) => {
      const linked = parseIssueRef(result.stdout.trim());
      if (linked === null || linked.kind !== 'issue' || linked.repo === null) {
        return false;
      }
      return linked.number === input.number && repoKey(linked.repo) === repoKey(input.repo);
    }) ?? links.find(({ result }) => result.status !== 0);
  if (existing !== undefined) {
    return { branch: existing.branch, isNew: false };
  }
  let branch = base;
  let suffix = 2;
  while (branches.includes(branch)) {
    branch = `${base}-${suffix}`;
    suffix += 1;
  }
  if (!(await gitSucceeds(input.root, 'check-ref-format', '--branch', branch))) {
    throw new CliError('bad_args', `bad branch name ${branch}`);
  }
  return { branch, isNew: true };
};

/** Records the issue locally and links it remotely only when explicitly enabled. */
export const recordIssue = async (root: string, branch: string, issue: CreatedIssue, repo: GithubRepoRef): Promise<void> => {
  await gitMust(root, 'config', `branch.${branch}.ternIssue`, issue.url);
  if (loadConfig().issueBranch.linkOnGitHub) {
    await ghMust('issue', 'develop', String(issue.number), '--repo', nameWithOwner(repo), '--name', branch);
  }
};
