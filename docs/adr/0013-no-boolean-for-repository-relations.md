# ADR-0013: Two fields and one key, not a boolean, for repository relations

Status: Accepted

## Decision

- The create `Target` in `src/commands/create.ts` keeps the two fields `forkPr` and `ompPrBranch`. It does not get one `fork: boolean`.
- `src/repo-ref.ts` keeps one exported `repoKey` for the same GitHub repository. It does not get a boolean `sameRepo(a, b)`.

## Why

- With `fork: boolean` and `pr: string | null`, the types let `fork: true` with no pull request through. The two fields keep the pull request number with the action that needs it.
- `repoKey` is the map key of the setup commands and the key that `clonePath` compares (#95, Out of scope, C4 spec). A boolean comparison does not supply that key.

## Reopen when

The boolean form gives a stronger contract without losing the pull request number or the repository key that callers need.
