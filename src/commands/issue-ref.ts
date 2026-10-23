import { parseArgs } from 'node:util';
import { CliError } from '../proc.ts';
import { parseIssueRef, repoKey } from '../repo-ref.ts';

/** Reads an issue reference for prompts without git or network access. */
export const run = (args: string[]) => {
  const { positionals } = parseArgs({ allowPositionals: true, args, options: {} });
  if (positionals.length !== 1) {
    throw new CliError('bad_args', 'issue-ref needs one issue reference');
  }
  const ref = parseIssueRef(positionals[0]);
  return { ref: ref === null ? null : { kind: ref.kind, number: ref.number, repo: ref.repo === null ? null : repoKey(ref.repo) } };
};
