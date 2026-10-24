import { describe, expect, it } from 'vite-plus/test';
import { issueBranchName } from '../src/issue.ts';
import { nameWithOwner, parseGithubUrl, parseIssueRef, repoKey } from '../src/repo-ref.ts';

describe(nameWithOwner, () => {
  it('joins the owner and the name', () => {
    expect(nameWithOwner({ name: 'name', owner: 'owner' })).toBe('owner/name');
  });
});

describe(repoKey, () => {
  it('gives the name with owner in lowercase letters', () => {
    expect(repoKey({ name: 'Hello-World', owner: 'OctoCat' })).toBe('octocat/hello-world');
  });
});

describe(parseGithubUrl, () => {
  it.each([
    ['git@github.com:riicodespretty/tern-worktrees.git', 'riicodespretty', 'tern-worktrees'],
    ['git@github.com:owner/name', 'owner', 'name'],
    ['https://github.com/owner/name.git', 'owner', 'name'],
    ['https://github.com/owner/some.repo', 'owner', 'some.repo'],
  ])('parses %s', (url, owner, name) => {
    expect(parseGithubUrl(url)).toStrictEqual({ name, owner });
  });

  it.each(['https://gitlab.com/owner/name.git', 'https://github.com/owner/name/extra', 'xgit@github.com:owner/name', 'git@github.com:owner/name.git.bak/x', ''])(
    'gives null for %s',
    url => {
      expect(parseGithubUrl(url)).toBeNull();
    },
  );
});

describe(parseIssueRef, () => {
  it.each([
    ['https://github.com/octocat/hello-world/issues/342', 'issue'],
    ['https://github.com/octocat/hello-world/issues/342/comments?foo=bar#issuecomment-1', 'issue'],
    ['https://github.com/octocat/hello-world/pull/342/files?diff=split#top', 'pr'],
  ])('parses %s', (text, kind) => {
    expect(parseIssueRef(text)).toStrictEqual({ kind, number: '342', repo: { name: 'hello-world', owner: 'octocat' } });
  });

  it.each(['342', '#342'])('parses the repository-relative issue %s', text => {
    expect(parseIssueRef(text)).toStrictEqual({ kind: 'issue', number: '342', repo: null });
  });

  it.each([
    '',
    '0',
    '#0',
    '-1',
    '#-1',
    '3.42',
    '342text',
    // oxlint-disable-next-line sonarjs/no-clear-text-protocols -- Reject insecure input. No request is made.
    'http://github.com/owner/repo/issues/342',
    'https://gitlab.com/owner/repo/issues/342',
    'garbagehttps://github.com/owner/repo/issues/342',
    'https://github.com/owner/repo/issues/0',
    'https://github.com/owner/repo/issues/-1',
    'https://github.com/owner/repo/issues/342text',
    'https://github.com/owner/repo/issues/',
    'https://github.com/owner/repo/pulls/342',
    'https://github.com/owner/repo/342',
    'https://github.com/owner/../issues/342',
    'https://github.com/owner/repo/issues/342.evil',
  ])('gives null for %s', text => {
    expect(parseIssueRef(text)).toBeNull();
  });
});

describe(issueBranchName, () => {
  const fixLabels = ['bug', 'fix', 'regression', 'hotfix'];

  it('normalizes French accents and drops tags, issue references and stop words', () => {
    expect(issueBranchName(342, '[UI] La journée de l’IA et les états (#342)', null, [], fixLabels)).toBe('feat/342-journee-lia-etats');
    for (const word of ['a', 'an', 'and', 'au', 'aux', 'de', 'des', 'du', 'en', 'et', 'for', 'in', 'la', 'le', 'les', 'of', 'on', 'the', 'to', 'un', 'une']) {
      expect(issueBranchName(342, `${word} dashboard`, null, [], fixLabels)).toBe('feat/342-dashboard');
    }
  });

  it.each([
    ['alpha [UI] beta', 'alpha-ui-beta'],
    [' \t[UI] alpha', 'alpha'],
    ['[UI]alpha', 'alpha'],
  ])('removes only a leading tag from %s', (title, slug) => {
    expect(issueBranchName(12, title, null, [], fixLabels)).toBe(`feat/12-${slug}`);
  });

  it('removes parenthesized issue references without splitting adjacent words', () => {
    expect(issueBranchName(12, 'alpha(#12)beta', null, [], fixLabels)).toBe('feat/12-alphabeta');
  });

  it('keeps title words that also name inherited object properties', () => {
    expect(issueBranchName(12, 'Fix the constructor crash', null, [], fixLabels)).toBe('feat/12-fix-constructor-crash');
  });

  it('drops straight apostrophes and typographic quotes without splitting words', () => {
    expect(issueBranchName(12, `« L'IA » “can't” "stop" #12`, null, [], fixLabels)).toBe('feat/12-lia-cant-stop');
  });

  it.each(['a', 'an', 'and', 'au', 'aux', 'de', 'des', 'du', 'en', 'et', 'for', 'in', 'la', 'le', 'les', 'of', 'on', 'the', 'to', 'un', 'une'])(
    'removes the stop word %s',
    word => {
      expect(issueBranchName(12, `${word} dashboard`, null, [], fixLabels)).toBe('feat/12-dashboard');
    },
  );

  it('uses fix for the Bug issue type without labels', () => {
    expect(issueBranchName(12, 'Crash', { name: 'Bug' }, [], fixLabels)).toBe('fix/12-crash');
  });

  it.each(fixLabels)('matches the %s label regardless of case', label => {
    expect(issueBranchName(12, 'Crash', { name: 'Feature' }, [{ name: label.toUpperCase() }], fixLabels)).toBe('fix/12-crash');
  });

  it('uses custom fix labels case-insensitively instead of the defaults', () => {
    expect(issueBranchName(12, 'Crash', undefined, [{ name: 'Urgent' }], ['URGENT'])).toBe('fix/12-crash');
    expect(issueBranchName(12, 'Crash', null, [{ name: 'bug' }], ['urgent'])).toBe('feat/12-crash');
  });

  it('keeps the first five significant words', () => {
    expect(issueBranchName(12, 'one two three four five six seven', null, [], fixLabels)).toBe('feat/12-one-two-three-four-five');
  });

  it('caps the slug at forty characters on a word boundary', () => {
    expect(issueBranchName(12, 'abcdefghij klmnopqrst uvwxyzabcd efghijk z', null, [], fixLabels)).toBe('feat/12-abcdefghij-klmnopqrst-uvwxyzabcd-efghijk');
    expect(issueBranchName(12, 'abcdefghij klmnopqrst uvwxyzabcd efghijkl z', null, [], fixLabels)).toBe('feat/12-abcdefghij-klmnopqrst-uvwxyzabcd');
  });

  it.each(['', '[UI] (#12) #34', 'le et the', '!!!', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmno'])('omits an empty slug for %s', title => {
    expect(issueBranchName(12, title, null, [], fixLabels)).toBe('feat/12');
  });

  it('maps punctuation to safe branch separators and trims them', () => {
    expect(issueBranchName(12, '... crash@{startup} / then..retry.lock ---', null, [], fixLabels)).toBe('feat/12-crash-startup-then-retry-lock');
  });

  it('does not treat partial labels as a fix label', () => {
    expect(issueBranchName(12, 'Debug startup', { name: 'Feature' }, [{ name: 'debug' }], ['bug'])).toBe('feat/12-debug-startup');
  });

  it('removes decomposed combining marks and preserves title numbers', () => {
    expect(issueBranchName(12, 'Journée cafe\u0301 v2 #34', null, [], [])).toBe('feat/12-journee-cafe-v2');
  });
});
