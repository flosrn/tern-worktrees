import { describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/issue-ref.ts';

describe('issue-ref command', () => {
  it('returns the canonical repository identity for an issue URL', () => {
    expect(run(['https://github.com/ACME/App/issues/42?tab=comments'])).toStrictEqual({ ref: { kind: 'issue', number: '42', repo: 'acme/app' } });
  });

  it('recognizes a pull request URL', () => {
    expect(run(['https://github.com/acme/app/pull/7'])).toStrictEqual({ ref: { kind: 'pr', number: '7', repo: 'acme/app' } });
  });

  it('preserves short issue references without a repository', () => {
    expect(run(['#42'])).toStrictEqual({ ref: { kind: 'issue', number: '42', repo: null } });
  });

  it.each(['text', '', 'https://github.com/acme/app/issues/0', 'https://github.com/acme/../issues/42'])('returns null for non-issue text %j', text => {
    expect(run([text])).toStrictEqual({ ref: null });
  });

  it.each(['-bad', '- item', '--secret-token-xyz'])('accepts non-issue text after the option delimiter %j', text => {
    expect(run(['--', text])).toStrictEqual({ ref: null });
  });

  it.each([[], ['one', 'two']])('rejects an incorrect argument count %j', (...args) => {
    expect(() => run(args)).toThrow('issue-ref needs one issue reference');
    expect(() => run(args)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });
});
