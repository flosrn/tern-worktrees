/** The GitHub owner and name of a repository. */
export interface GithubRepoRef {
  owner: string;
  name: string;
}

const NAME_WITH_OWNER = /^(?<owner>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<name>(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]*)$/u;

const GITHUB_URL = /^(?:git@github\.com:|https:\/\/github\.com\/)(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/u;

/** The `<owner>/<name>` form of `repoRef`, the name that `gh` uses for a repository. */
export const nameWithOwner = (repoRef: GithubRepoRef): string => `${repoRef.owner}/${repoRef.name}`;

/** The key of `repoRef`: its name with owner in lowercase letters. Two repository references name the same GitHub repository when they have the same key. */
export const repoKey = (repoRef: GithubRepoRef): string => nameWithOwner(repoRef).toLowerCase();

/** Reads `<owner>/<name>` from `text`, or gives null when `text` is not a valid `<owner>/<name>`. */
export const parseRepoRef = (text: string): GithubRepoRef | null => {
  const groups = NAME_WITH_OWNER.exec(text)?.groups;
  return groups ? { name: groups.name, owner: groups.owner } : null;
};

/** Reads the GitHub owner and name from the remote URL `url`, in the form `git@github.com:<owner>/<name>` or `https://github.com/<owner>/<name>`, with an optional `.git`. Gives null when `url` is not a GitHub URL. */
export const parseGithubUrl = (url: string): GithubRepoRef | null => {
  const groups = GITHUB_URL.exec(url)?.groups;
  return groups ? { name: groups.name, owner: groups.owner } : null;
};

/** Reads a GitHub issue or pull request URL, or a positive issue number with an optional `#`. Relative issue numbers have no repository. */
export const parseIssueRef = (text: string): { repo: GithubRepoRef | null; number: string; kind: 'issue' | 'pr' } | null => {
  if (/^#?[1-9][0-9]*$/u.test(text)) {
    return { kind: 'issue', number: text.replace('#', ''), repo: null };
  }
  const groups = /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<name>[^/]+)\/(?<kind>issues|pull)\/(?<number>[1-9][0-9]*)(?:[/?#].*)?$/u.exec(text)?.groups;
  if (!groups) {
    return null;
  }
  const repo = parseRepoRef(`${groups.owner}/${groups.name}`);
  return repo ? { kind: groups.kind === 'pull' ? 'pr' : 'issue', number: groups.number, repo } : null;
};
