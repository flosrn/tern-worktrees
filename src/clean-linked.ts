import path from 'node:path';
import { gitMust, gitRun } from './git.ts';
import type { Worktree } from './git.ts';
import { ghTry } from './github.ts';
import { parseIssueRef, repoKey } from './repo-ref.ts';
import type { GithubRepoRef } from './repo-ref.ts';

interface LinkedRef {
  repo: GithubRepoRef;
  number: string;
}

/** Shared GitHub evidence for local branches and worktrees. Open or unknown links do not authorize force delete. */
export interface CleanLinks {
  branches: Map<string, string>;
  worktrees: Map<string, string>;
  mergedHeads: string[];
}

interface LinkedNode {
  __typename: 'Issue' | 'PullRequest';
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

interface RawLinkedNode {
  __typename: LinkedNode['__typename'];
  number: number;
  issueState?: LinkedNode['state'];
  prState?: LinkedNode['state'];
}

interface GraphRepository {
  merged?: { nodes: { headRefOid: string }[] };
  [alias: `n${string}`]: RawLinkedNode | null | undefined;
}

interface GraphPage {
  data?: Record<string, GraphRepository | null>;
  errors?: { message: string }[];
}

interface LinkedRefs {
  branches: Map<string, LinkedRef[]>;
  worktrees: Map<string, LinkedRef[]>;
}

interface RepoGroup {
  repo: GithubRepoRef;
  refs: Map<string, LinkedRef>;
}

const keyOf = (ref: LinkedRef): string => `${repoKey(ref.repo)}#${ref.number}`;

const numbered = (name: string, worktree: boolean): string | undefined =>
  (worktree ? /^(?<number>[1-9][0-9]*)-/u : /^(?:[^/]+\/|pr-)(?<number>[1-9][0-9]*)(?:-.*)?$/u).exec(name)?.groups?.number;

const append = (items: Map<string, LinkedRef[]>, id: string, ref: LinkedRef): void => {
  const refs = items.get(id) ?? [];
  if (!refs.some(existing => keyOf(existing) === keyOf(ref))) {
    refs.push(ref);
  }
  items.set(id, refs);
};

const configuredRefs = async (root: string, github: GithubRepoRef, branches: string[], refs: LinkedRefs): Promise<void> => {
  const config = await gitRun(root, 'config', '--null', '--get-regexp', String.raw`^branch\..*\.ternissue$`);
  if (config.status !== 0 && config.status !== 1) {
    throw new Error(config.stderr.trim());
  }
  for (const record of config.stdout.split('\0').filter(Boolean)) {
    const split = record.indexOf('\n');
    const branch = record.slice('branch.'.length, split - '.ternIssue'.length);
    const ref = parseIssueRef(record.slice(split + 1));
    if (branches.includes(branch) && ref !== null) {
      append(refs.branches, branch, { number: ref.number, repo: ref.repo ?? github });
    }
  }
};

const worktreeRefs = (github: GithubRepoRef, entries: Worktree[], refs: LinkedRefs): void => {
  for (const entry of entries) {
    const number = numbered(path.basename(entry.path), true);
    if (!entry.main && number !== undefined) {
      const ref = { number, repo: github };
      append(refs.worktrees, entry.path, ref);
      if (entry.branch !== null) {
        append(refs.branches, entry.branch, ref);
      }
    }
  }
  for (const entry of entries) {
    const branch = entry.branch === null ? [] : (refs.branches.get(entry.branch) ?? []);
    for (const ref of branch) {
      append(refs.worktrees, entry.path, ref);
    }
  }
};

const collectRefs = async (root: string, github: GithubRepoRef, branches: string[], entries: Worktree[]): Promise<LinkedRefs> => {
  const refs: LinkedRefs = { branches: new Map(), worktrees: new Map() };
  for (const branch of branches) {
    const number = numbered(branch, false);
    if (number !== undefined) {
      append(refs.branches, branch, { number, repo: github });
    }
  }
  await configuredRefs(root, github, branches, refs);
  worktreeRefs(github, entries, refs);
  return refs;
};

const groupRepos = (github: GithubRepoRef, refs: LinkedRefs): RepoGroup[] => {
  const repos = new Map<string, RepoGroup>([[repoKey(github), { refs: new Map(), repo: github }]]);
  for (const items of [...refs.branches.values(), ...refs.worktrees.values()]) {
    for (const ref of items) {
      const group = repos.get(repoKey(ref.repo)) ?? { refs: new Map<string, LinkedRef>(), repo: ref.repo };
      group.refs.set(ref.number, ref);
      repos.set(repoKey(ref.repo), group);
    }
  }
  return [...repos.values()];
};

const graphQuery = (groups: RepoGroup[]): string => {
  const fields = groups.map(({ repo, refs }, index) => {
    const linked = [...refs.values()]
      .map(ref => `n${ref.number}:issueOrPullRequest(number:${ref.number}){__typename ... on Issue{number issueState:state} ... on PullRequest{number prState:state}}`)
      .join(' ');
    const merged = index === 0 ? 'merged:pullRequests(first:100,after:$endCursor,states:MERGED){nodes{headRefOid} pageInfo{hasNextPage endCursor}}' : '';
    return `r${index}:repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}){${merged} ${linked}}`;
  });
  return `query($endCursor:String){${fields.join(' ')}}`;
};

const readLinkedNode = (node: RawLinkedNode | null | undefined, ref: LinkedRef): LinkedNode | null => {
  if (node === null || node === undefined || String(node.number) !== ref.number) {
    return null;
  }
  const state = node.__typename === 'Issue' ? node.issueState : node.prState;
  if (state === undefined || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) {
    return null;
  }
  return { ...node, state };
};

const readRepository = (repository: GraphRepository, refs: Map<string, LinkedRef>, states: Map<string, LinkedNode>, mergedHeads: Set<string>): void => {
  for (const ref of refs.values()) {
    const node = readLinkedNode(repository[`n${ref.number}`], ref);
    if (node !== null) {
      const key = keyOf(ref);
      // Reopening during pagination must invalidate an earlier terminal authorization.
      if (!states.has(key) || !['CLOSED', 'MERGED'].includes(node.state)) {
        states.set(key, node);
      }
    }
  }
  for (const node of repository.merged?.nodes ?? []) {
    if (/^[a-f0-9]{40,64}$/u.test(node.headRefOid)) {
      mergedHeads.add(node.headRefOid);
    }
  }
};

interface GithubEvidence {
  states: Map<string, LinkedNode>;
  mergedHeads: Set<string>;
}

const readPages = (pages: GraphPage[], groups: RepoGroup[], warnings: string[]): GithubEvidence => {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('missing GitHub evidence');
  }
  const states = new Map<string, LinkedNode>();
  const mergedHeads = new Set<string>();
  for (const page of pages) {
    if (page.errors !== undefined && page.errors.length > 0) {
      warnings.push(`merged PR check failed: ${page.errors.map(error => error.message).join('; ')}`);
    }
    for (const [index, { refs }] of groups.entries()) {
      const repository = page.data?.[`r${index}`];
      if (repository === null || repository === undefined) {
        warnings.push('merged PR check failed: repository inspection unavailable');
        continue;
      }
      readRepository(repository, refs, states, mergedHeads);
    }
  }
  return { mergedHeads, states };
};

const terminalRefs = (items: Map<string, LinkedRef[]>, states: Map<string, LinkedNode>): Map<string, string> => {
  const result = new Map<string, string>();
  for (const [id, refs] of items) {
    if (refs.some(ref => !['CLOSED', 'MERGED'].includes(states.get(keyOf(ref))?.state ?? ''))) {
      continue;
    }
    const reason = refs
      .map(ref => {
        const node = states.get(keyOf(ref));
        return `${node?.state === 'MERGED' ? 'merged' : 'closed'} linked ${node?.__typename === 'Issue' ? 'issue' : 'PR'} ${repoKey(ref.repo)}#${ref.number}`;
      })
      .join('; ');
    result.set(id, reason);
  }
  return result;
};

/** Resolves associations and merged PR heads in one paginated GraphQL operation. */
export const cleanLinks = async (root: string, github: GithubRepoRef | null, branches: string[], entries: Worktree[], warnings: string[]): Promise<CleanLinks> => {
  const result: CleanLinks = { branches: new Map(), mergedHeads: [], worktrees: new Map() };
  if (github === null) {
    return result;
  }
  try {
    const refs = await collectRefs(root, github, branches, entries);
    const groups = groupRepos(github, refs);
    const response = await ghTry('api', 'graphql', '--paginate', '--slurp', '-f', `query=${graphQuery(groups)}`);
    if (response.error !== null) {
      warnings.push(`merged PR check failed: ${response.error}`);
      if (response.stdout.trim() === '') {
        return result;
      }
    }
    // SAFETY: the GitHub CLI wraps GraphQL response pages in one JSON array with --slurp.
    const pages = JSON.parse(response.stdout) as GraphPage[];
    const { states, mergedHeads } = readPages(pages, groups, warnings);
    result.branches = terminalRefs(refs.branches, states);
    result.worktrees = terminalRefs(refs.worktrees, states);
    result.mergedHeads = [...mergedHeads];
  } catch (error) {
    warnings.push(`merged PR check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
};

/** Finds branch tips missing from the proof histories in one graph traversal. Missing PR objects cannot prove integration. */
export const cleanReachability = async (
  root: string,
  base: string,
  heads: Map<string, string>,
  mergedHeads: string[],
  entries: Worktree[],
): Promise<{ proven: Set<string>; local: Set<string> }> => {
  const detached = entries.filter(entry => entry.branch === null).map(entry => entry.head);
  const [unproven, local, remote] = await Promise.all([
    gitRun(root, 'rev-list', '--ignore-missing', '--branches', '--not', `refs/remotes/origin/${base}`, ...mergedHeads),
    gitMust(root, 'rev-list', '--branches', ...detached, '--not', '--remotes'),
    gitRun(root, 'rev-parse', '--verify', `refs/remotes/origin/${base}`),
  ]);
  const remaining = new Set(unproven.stdout.split('\n').filter(Boolean));
  return {
    local: new Set(local.split('\n').filter(Boolean)),
    proven: new Set(unproven.status === 0 && remote.status === 0 ? [...heads].filter(([, head]) => !remaining.has(head)).map(([branch]) => branch) : []),
  };
};
