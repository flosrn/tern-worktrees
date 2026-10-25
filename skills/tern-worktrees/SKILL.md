---
name: tern-worktrees
description: Use to create, list, relocate or tear down git worktrees as Tern tabs with tern-wt, prepare their repository environment, or run heavy commands in host-wide slots. Replaces Orca worktrees.
---

# tern-worktrees

`tern-wt` keeps git worktrees in the worktree root and opens each one in a Tern tab. The worktree root is `$TERN_WT_HOME/worktrees` when `TERN_WT_HOME` is set. Else, when omp is installed, it is omp's default worktree root, usually `~/.omp/wt`: `$OMP_WORKTREE_DIR`, else the omp setting `worktree.base`, else the `wt` folder of the omp data folder, which follows `PI_CONFIG_DIR`, `OMP_PROFILE` and `$XDG_DATA_HOME/omp` as omp does. Else it is `~/.tern-wt/worktrees`. A tern-managed worktree is at `<root>/<repo>/<slug>`, where `<repo>` is the folder name of the main checkout and the slug is the branch name with each `/` changed to `-`. Each other worktree in the omp worktree root is omp-owned: `tern-wt` opens it, and does not remove it.

## Rules

- Use `tern-wt` for worktrees, not `git worktree` or `orca worktree`.
- For work on an issue, use `tern-wt create --issue <url>` (or the plugin's `create` export with `issue`). This derives the branch and records `ternIssue`. Use `--branch --new` alone only for work with no issue.
- Put `Closes <owner>/<repo>#<n>` in the PR body, or `Closes #<n>` when the issue is in the same repository.
- Run `remove` only on a worktree you created in this session, or one the user names.
- Pass `remove --force` only after the user says yes: it discards work to lose, but does not permit closing busy tabs.
- On `busy_tabs`, show the user the reported processes. Pass `--close-busy-tabs` only after the user agrees to close them, separately from approval for `--force`.
- After `busy_tabs`, keep the process check on retry unless the user agrees to bypass it. Ask before retrying with `--keep-tab` too: it removes the worktree without examining running processes.
- Tabs that `create` opens are yours to close (skill://tern-cli). `remove` closes them after the process check. `--close-busy-tabs` skips the check. `--keep-tab` skips the check and keeps the tabs open.
- Do not run `omp worktree clear` without `--dry-run` first. With or without `--all`, it deletes each worktree that omp sees as orphaned, and omp can see a live tern-managed worktree as orphaned, for example with `worktree.useRelativePaths=true` or after the main checkout moved.

## Output

Commands print one JSON object to standard output. Two commands use a different output: `env --shell` prints shell exports, and `heavy -- <command>` passes through child output and exit code without JSON.

- Exit 0: the result. Read its `warnings`. Each warning is a problem that did not stop the command.
- Exit 1: `{"error":{"code":"<code>","message":"<text>", ...}}`, plus the message on standard error. Some codes add fields: see [Error codes](#error-codes).

When omp is on disk but `omp config list --json` fails in `/`, the worktree root is unknown: `create`, `remove`, `list` and `branches` fail with `omp_failed`. `~/.tern-wt/worktrees` is the root only when no omp binary is on disk.

## Commands

### `create`

`tern-wt create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab]`

`tern-wt create --issue <url|#n|n> [--repo <dir>] [--branch <name>] [--suggest] [--relocate] [--no-tab]`

Makes the tern-managed worktree of a branch, or reuses it. Then opens its tab, or focuses the tab that is open. When the branch has an omp-owned worktree, `create` reuses that worktree where it is, with no `--relocate`. Reuse matches by branch: omp checks out pull request `<n>` on the branch `pr-<n>`. For `--pr <n>` of a pull request from the same repository, when no worktree has its head branch, `create` reuses omp's worktree on `pr-<n>` when the git config key `branch.pr-<n>.ompPrHeadRef` is not set or names the head branch. `branch` in the output is then `pr-<n>`.

When the main checkout has the branch, also the head branch of `--pr`, `create` opens the main checkout where it is. `--relocate` does not apply: the main checkout does not move.

When omp is installed and the omp setting `worktree.clone` is true in the repository, `create` makes the worktree with `omp worktree add`, also when `TERN_WT_HOME` is set. A rebuilt relocation uses plain git. The new worktree starts as a copy-on-write clone of the main checkout, so it has the ignored files of the main checkout, for example `.env` and `node_modules`. The clone also copies the `.git` file of each submodule, which then points to no git folder. `create` deletes each of these files, copies the submodule git folders of the main checkout into the git folder of the worktree, and runs `git submodule update`. Thus git works in each submodule, each submodule is at the recorded commit, and the files of the clone stay. A new branch gets the same upstream as plain `git worktree add -b` gives it, `origin/<default>` with the git defaults. Each line that omp prints to standard error, for example that the clone fell back to a checkout, becomes a warning that starts with `omp:`. When `omp config list --json` fails in the repository, `create` uses plain git and adds a warning that starts with `omp config list`. omp moves an invalid `.omp/config.yml` of the repository aside to `.omp/config.yml.broken-<id>` when it reads it.

- `--repo`: a dir in the repository. Required for `--branch`, `--pr`, and short issue references (`#n` or `n`). An issue URL uses this checkout when its `origin` matches, otherwise the checkout at `<cloneRoot>/<owner>/<repo>`.
- `--branch`: a local branch or a branch on `origin`. With `--issue`, overrides the derived name and needs no `--new`. A name that git rejects gives `bad_args`.
- `--new`: make `--branch` a new branch from `origin/<default>`. When the branch is local or on `origin`, `--new` gives `bad_args`, also when the branch has a worktree.
- `--pr`: the branch of a pull request. A pull request from a fork gets the branch `pr-<number>`. When the head branch of a pull request from the same repository is not local and not on `origin`, `--pr` gives `git_failed` with the fetch failure when the fetch of `origin` failed, else `bad_args`: `origin` does not have the branch, for example because it was deleted.
- `--issue`: a GitHub issue URL, or `#n` or `n` with `--repo`. URLs can have a trailing path, query and fragment. A `/pull/<n>` URL uses the `--pr` flow. Without a matching checkout, `not_cloned` gives the clone `path` and the name with owner in `repo`. Ask the user before running `clone`, then retry.
- `--suggest`: with an issue URL or short issue reference in `--issue`, return `{"branch", "issue": {"number", "url", "title"}, "repo", "warnings"}` without fetching or writing anything. It creates no branch, worktree or tab and writes no `ternIssue`. A `/pull/<n>` URL opens the PR flow directly. Use it without `--suggest`.
- `--relocate`: move the worktree of the branch into the worktree root from a path that is not in the root. Pass it only after the user says yes. When git refuses the move, `create` makes the worktree again in the root with plain `git worktree add`. Of the work to lose in the first worktree, only a change, a new file that git does not track or a submodule commit not held by a remote branch or by the main checkout's committed submodule history stops it with `dirty_worktree`. Hard-to-rebuild files (see `remove`) do not stop it: `create` copies them into the new worktree.
- `--no-tab`: skip the tab and service startup. For a new worktree, still return the same `setup.line` with `setup.typed: false`. The caller runs it in the worktree.

Issue branches start from `origin/<default>` and use `<prefix>/<number>-<slug>`. The prefix is `fix` when the issue type is `Bug` or a label matches `issueBranch.fixLabels`, ignoring uppercase and lowercase letters. Otherwise it is `feat`. The title slug drops a leading `[tag]` and issue-number references, applies NFKD and removes accent marks, changes letters to lowercase, drops quotes and apostrophes, replaces other runs of characters that do not match `[a-z0-9]` with `-`, and drops French and English stop words. It keeps the first five words, with a maximum of 40 characters on a word boundary. An empty slug gives `<prefix>/<number>`. An unrelated collision adds `-2`, `-3` and so on. The worktree folder replaces `/` with `-` as before.

A local or `origin` branch that matches `^(fix|feat)/<n>(?:-|$)` is reused with its worktree. No second branch is created. This also applies to `<prefix>/<number>` with no slug. A closed issue adds a warning. Creation records `git config branch.<branch>.ternIssue <url>` and adds `issue: {number, url, title}` to the result for issue references, not `/pull/<n>` URLs. The default makes no GitHub writes. `issueBranch.linkOnGitHub: true` opts into `gh issue develop <n> --repo <owner>/<repo> --name <branch>` to create a remote branch linked in the issue's Development panel. It creates a branch, not a link for a branch from an earlier push. GitHub failures, for example conflicting branches, give `gh_failed`.

For these related branch names only, the CLI first selects a branch with a `ternIssue` value that matches the issue URL exactly, then a branch with no issue association.

For a new worktree, `create` loads `.tern/worktree.json` and starts or reuses its services before opening the tab. It waits a maximum of 30 s for the shell prompt, then types the setup line: environment activation first when set, repository setup commands second, and user setup commands last, with `&&` between them. These commands run in the tab. `create` does not wait for them to complete. See [Repository environment](#repository-environment). Reused and relocated worktrees get no preparation.

Output: `{"path", "branch", "repo", "owner", "status", "carried", "setup", "tab", "warnings"}`, plus `issue` for an issue.

- `owner`: `tern` for a tern-managed worktree, `omp` for an omp-owned worktree, as in `list`, and `main` for the main checkout. A reused omp-owned worktree and the omp checkout of a pull request give `omp`.
- `status`: `created`, `reused` or `relocated`. For an omp-owned worktree and for the main checkout, `reused` with its `path`.
- `carried`: the ignored files, as paths in the worktree, that a rebuilt relocation copied into the new worktree. Empty otherwise. When the new worktree has a file at that path, the copy stays in the temporary folder, with a `not carried:` warning.
- `setup`: `{"line", "typed"}`, or null. For a new worktree, `line` joins repository setup and user setup commands with `&&`. When repository environment variables are set, it starts with `eval "$(tern-wt env . --shell)"`. Repository setup and environment variables need no GitHub origin. User setup commands use its name with owner. `setup` is null for reused or relocated worktrees, or when there are no environment variables and no setup commands. `typed` is true when `create` typed the line into the tab it opened. When the tab was open before, no prompt shows in 30 s, or Tern fails, `typed` is false with a `setup not run:` warning, and the worktree stays. With `--no-tab`, `typed` is false without running the line.
- `tab`: `{"session", "block", "opened"}`, or null with a `tab not opened:` warning. `opened` is false when `create` focused a tab that was open before.
- `issue`: for an issue URL or short issue reference, `{"number", "url", "title"}` identifying the issue recorded in `ternIssue`. No `issue` field for `/pull/<n>` URLs, which use the PR flow.

The Carly `create` export has the signature `(repo: string, branch: string?, new: boolean?, issue: string?)`. For issue work, pass the repository directory first and the issue URL fourth, with an optional branch override second. Keep `new` unset. The issue flow creates or reuses the branch.

### `prepare`

`tern-wt prepare <path> [--no-setup]`

Loads the [repository environment](#repository-environment), starts or reuses shared Docker services, then runs setup commands sequentially in the checkout root: repository commands first, user commands second. Applies the declared environment to each command and waits for it to complete. `--no-setup` still starts or reuses services but runs no setup commands. This command needs no Tern tab.

Output: `{"path", "repo", "services": [{"name", "container", "status"}], "setup": [{"command", "exitCode", "ms"}], "env", "warnings"}`. `path` is the checkout root, `repo` its lowercase name with owner or null without a GitHub origin, service `status` is `started` or `running`, and `ms` is each command's time in milliseconds. `setup` is empty with `--no-setup`. The first failed command stops setup with `setup_failed`, `command`, `exitCode` and the last 40 output lines in `output`.

### `env`

`tern-wt env <path> [--shell]`

Returns `{"env": {"NAME": "value"}}` from the repository file. With `--shell`, prints POSIX-quoted `export NAME='value'` lines, not JSON. Apply them to the current shell with `eval "$(tern-wt env . --shell)"`. This command starts no services and runs no setup commands.

### `heavy`

`tern-wt heavy [--repo <dir>] -- <command> [args...]`

Starts or reuses repository services, applies the declared environment, gets a host-wide slot and runs the command. `--repo` selects the repository file. The command's working directory stays the current directory. It runs no setup commands. Standard output, standard error and the child exit code pass through without a JSON result.

The number of slots is `max(1, floor(total host RAM in GiB / heavy.slotMemoryGb))`, with 7 GiB for each slot by default. Locks are `<plugin-data>/heavy/slot-<n>.lock`. Acquisition removes locks with dead process IDs. When all slots are busy, it prints one waiting message to standard error and retries at 5 s intervals. The lock is released when the command ends or receives SIGHUP, SIGINT or SIGTERM. The child runs in its own session, so cancellation goes to its process group. It has no controlling terminal. A command that opens `/dev/tty`, for example an interactive privilege prompt or a credential prompt, fails.

`tern-wt heavy [--repo <dir>] --status`

Returns `{"slots": [{"slot", "busy", "pid", "cwd", "command", "startedAt"}], "memAvailableGb", "memTotalGb"}` without running a command or starting services. `slot` starts at 1. Busy slots report the holder PID, working directory, argument array and start timestamp. Idle slots have null ownership fields. Memory values use GiB.

### `remove`

`tern-wt remove <path> [--force] [--close-busy-tabs] [--keep-tab]`

Removes the tern-managed worktree at `<path>`, closes its tabs, then applies the teardown policy to its branch. An omp-owned worktree gives `not_managed`.

Unless `--keep-tab` or `--close-busy-tabs` is set, `remove` examines the processes in the target Tern blocks before removal. A running process gives `busy_tabs`, and the worktree, tabs and branch stay. The `error.blocks` field lists each busy block as `{"block", "tab", "session", "process": {"pid", "name", "argv", "cwd"}}`. First, a null foreground process is idle. With a non-null foreground process, the block is idle only when its child is a recognized shell and the foreground PID is the child PID. All other cases are busy, also with an unsupported shell. This inspection is a snapshot: a process can start after the check.

- `--close-busy-tabs`: skip process inspection and permit closing busy blocks. This does not permit discarding work to lose.
- `--force`: discard work to lose. This does not bypass `busy_tabs` or inspection failures.
- `--keep-tab`: keep the tabs open and skip all Tern inspection.

When a process inspection fails, `remove` stops with `tern_failed` before removing the worktree, closing blocks or applying the teardown policy. Fix the inspection failure before retrying. A failure to list Tern blocks adds a `tabs not closed:` warning and continues removal without closing blocks. `--close-busy-tabs` skips process inspection, but still lists blocks. `--keep-tab` skips the list and process inspection.

When a block in the list closes or its process ends before inspection, the inspection can fail with `tern_failed`. Retry to get the current list and process information.

A worktree with a changed file, a new file that git does not track, a submodule commit not held by a remote branch or by the main checkout's committed submodule history, or an ignored file that is hard to rebuild gives `dirty_worktree` and stays. The submodule check uses local refs only: it trusts the commits recorded in `HEAD` of the main checkout and their ancestors, at each submodule depth, only when the two submodule object stores have the recorded commit: the main checkout and the worktree. Otherwise, only remote branches protect the commits. It needs no fetched tags or network access. A local tag alone, or a submodule commit recorded only in the worktree, does not protect a commit. `remove` checks for that work before git removes anything. A different refusal of git, for example for a locked worktree, gives `git_failed` with the message of git, and the worktree stays. An ignored file is build, install or tool output when a part of its path is `node_modules`, `dist`, `build`, `coverage`, `.DS_Store`, `.cache`, `.next`, `.nuxt`, `.output`, `.turbo`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `__pycache__` or `.venv`, or its filename ends with `.tsbuildinfo`. That output goes with the worktree. Each other ignored file, for example `.env`, is hard to rebuild. An ignored file with the same bytes as the file at the same path in the main checkout, or in the same submodule of the main checkout, is a copy and goes with the worktree. `--force` deletes all of them.

Output: `{"removed", "repo", "branch", "branchDeleted", "branchKept", "closedBlocks", "warnings"}`. `repo` is the main checkout of the removed worktree. `branch` is null for a detached `HEAD`. `branchKept` tells why `remove` kept the branch: `policy` for the teardown policy `worktree`, `not_merged` for a branch that is not merged, also when the merge check failed, and `not_deleted` when `git branch -D` failed. It is null when `remove` deleted the branch, and for a detached `HEAD`. A branch that the policy keeps because it is not merged adds the warning `kept local branch <branch>: not merged`, and a failed delete adds `branch <branch> not deleted: <reason>`. That warning comes first in `warnings`.

### `list`

`tern-wt list [--repo <dir>] [--all]`

- `--all`: also list the omp-owned worktrees, at all depths in the worktree root. `list` does not look in a worktree or a main checkout.

Output: `{"root", "warnings", "worktrees": [{"path", "repo", "branch", "dirty", "changed", "owner"}]}`. Without `--all`, `list` shows the tern-managed worktrees only. With `--repo`, `list` shows only the worktrees of the repository that contains `<dir>`.

- `repo`: the main checkout.
- `branch`: null for a detached `HEAD`.
- `changed`: the number of files with changes. Each changed or new file counts one time, and submodule changes also count.
- `dirty`: true when `changed` is more than 0.
- `owner`: `tern` for a tern-managed worktree and `omp` for an omp-owned worktree.
- `warnings`: one entry for each worktree in the output where git cannot count the changes, for example because a submodule has a broken `.git` file. The entry starts with `changed files not counted in <path>:` and gives the git error. That worktree stays in `worktrees`. Its `changed` does not include the submodules, and it is 0 when git cannot count the changes without the submodules too. Empty when git counts all worktrees.

### `branches`

`tern-wt branches --repo <dir> [--offline]`

- `--offline`: read only local refs. It does not run `git fetch --prune origin`, does not list the open pull requests, and does not ask GitHub for the default branch. `prs` is `[]`, and `branches` has the branches on `origin` as of the last fetch. When `origin/HEAD` is unset, `default` is the current branch.

Output: `{"repo", "name", "default", "branches", "prs": [{"number", "title", "branch", "fork"}], "prsFailed", "worktrees": [{"branch", "path", "main", "managed", "owner"}], "warnings"}`. `main` is true for the main checkout. `owner` is `tern` for a tern-managed worktree, `omp` for an omp-owned worktree, and null for a worktree that is not in the worktree root. `managed` is true for a tern-managed worktree. `branches` is sorted by the date of the last commit on each branch, newest first. It has the local branches and the branches on `origin`, each once. `prsFailed` is true when `gh pr list` failed. Then `prs` is `[]` and `warnings` has an entry that starts with `pr list failed:`. `prsFailed` is false with `--offline`, and when `origin` is not a GitHub repository.

### `resolve`

`tern-wt resolve <dir>...`

Output: `{"repos": [{"dir", "root", "name", "owner", "origin"}]}`. `root`, `name`, `owner` and `origin` are null for a dir that is not in a repository. `origin` is the GitHub name with owner (`<owner>/<repo>`) in lowercase, or null when the repository has no GitHub origin.

### `issue-ref`

`tern-wt issue-ref -- <text>`

Parse one issue or pull request URL, or a short issue reference (`#n` or `n`), without git or network access. Output: `{"ref": {"repo", "number", "kind"}}`, or `{"ref": null}` when the text is not a reference. `repo` is the name with owner (`<owner>/<repo>`) in lowercase, or null for a short reference. `number` is a string. `kind` is `issue` or `pr`. Pass exactly one text argument. A different number of arguments gives `bad_args`. The plugin uses this command to read prompt and clipboard text.

Use the `--` separator to read clipboard text that starts with `-` as text.

### `repos`

`tern-wt repos`

Output: `{"owners", "repos": [{"nameWithOwner", "isPrivate", "description", "local"}], "warnings"}`. `owners` is the GitHub user, then each GitHub organization of that user. `local` is the clone of the repository in the clone root. It is null when nothing is at the clone path, and also when the path holds something else, an empty folder included. In that case, `clone` gives `path_conflict`. `local` follows the same rule as `clone`: the match ignores the difference between uppercase and lowercase letters in the name with owner.

### `clone`

`tern-wt clone <owner/name>`. The owner starts with a letter or digit. The owner and the name use only letters, digits, `.`, `_` and `-`. The name does not start with `-`, and it is not `.` or `..`. A name with owner that breaks these rules gives `bad_args`.

Clones the GitHub repository to `<cloneRoot>/<owner>/<name>`, or reuses the clone there. A checkout at that path is the clone when the GitHub URL of its `origin` names the repository. The match ignores the difference between uppercase and lowercase letters in the name with owner. Output: `{"root", "cloned"}`.

### `new-repo`

`tern-wt new-repo <owner/name> --visibility private|public`

Makes a GitHub repository with a README, then clones it. It checks the clone path first, so a `path_conflict` makes no repository. The name with owner follows the rule of `clone`. Run it only when the user asks for a new repository. Output: `{"root", "nameWithOwner"}`.

### `config`

`tern-wt config`

Output: the options file with each default filled in, `{"teardown", "cloneRoot", "hotkeys": {"new"}, "issueBranch": {"fixLabels", "linkOnGitHub"}, "setup"}`. See [Options file](#options-file). An invalid file gives `config_invalid`, as for each command.

### `tern-wt setup`

`tern-wt setup`

Links `~/.local/bin/tern-wt` to the CLI and `~/.omp/agent/skills/tern-worktrees` to this skill, the two in the package that it runs from. The plugin runs it each time it loads in a Tern window. A second run changes nothing. Output: `{"links": [{"path", "target", "action"}]}`, with `action` `created`, `kept` or `replaced`. A file or a folder that is not a symbolic link at a link path gives `path_conflict`, and `setup` then changes nothing.

## Error codes

| Code                        | Added fields                                    | Next step                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bad_args`                  |                                                 | Fix the arguments from the message.                                                                                                                                                                                                                                                                                                                                                                           |
| `config_invalid`            |                                                 | Show the user the message, which names the file and the key.                                                                                                                                                                                                                                                                                                                                                  |
| `worktree_config_invalid`   |                                                 | Show the message naming `.tern/worktree.json` and its invalid key. Fix that declaration before retrying.                                                                                                                                                                                                                                                                                                      |
| `setup_failed`              | `command`, `exitCode`, `output`                 | Show the failed command and last 40 output lines. Fix its failure before rerunning preparation. Subsequent setup commands did not run.                                                                                                                                                                                                                                                                        |
| `service_failed`            | `service`                                       | Show the service and Docker or readiness failure from the message. Fix it before retrying.                                                                                                                                                                                                                                                                                                                    |
| `docker_missing`            |                                                 | Install Docker or make its executable available on `PATH`, then retry.                                                                                                                                                                                                                                                                                                                                        |
| `not_a_repo`                |                                                 | Pass a dir in a git repository.                                                                                                                                                                                                                                                                                                                                                                               |
| `not_cloned`                | `path`, `repo`                                  | Show the clone path and ask before `tern-wt clone <owner>/<repo>`, then retry `create --issue`. The CLI does not clone silently.                                                                                                                                                                                                                                                                              |
| `not_managed`               |                                                 | `remove` acts only on a tern-managed worktree, not on an omp-owned one. Get the paths from `list`.                                                                                                                                                                                                                                                                                                            |
| `path_conflict`             | `path`                                          | Show the user `path`. Keep it as it is.                                                                                                                                                                                                                                                                                                                                                                       |
| `worktree_exists_elsewhere` | `existing`, `target`                            | Ask the user, then run `create` again with `--relocate`.                                                                                                                                                                                                                                                                                                                                                      |
| `dirty_worktree`            | `existing`, `files`, `changes`, `hardToRebuild` | Show the user `files`. An entry `!! <path>` is an ignored file that is hard to rebuild. `changes` holds the entries without `!! `, and `hardToRebuild` holds the paths of the `!! ` entries. Relocate stops only on `changes` and gives an empty `hardToRebuild`, because it carries the hard-to-rebuild files into the new worktree. `remove` stops on all work to lose. For `remove`, ask before `--force`. |
| `busy_tabs`                 | `blocks`                                        | Show the user each block, tab, session and process (`pid`, `name`, `argv`, `cwd`) from `error.blocks`. Stop the processes and retry, or ask before `--close-busy-tabs`. `--force` does not bypass this refusal.                                                                                                                                                                                               |
| `git_failed`                |                                                 | Show the user the message. For `remove`, ask before `--force`.                                                                                                                                                                                                                                                                                                                                                |
| `gh_failed`                 |                                                 | Show the user the message. Check `gh auth status`.                                                                                                                                                                                                                                                                                                                                                            |
| `omp_failed`                |                                                 | Show the user the message. omp is installed but `omp config list --json` failed, so the worktree root is unknown. Fix omp, then run the command again.                                                                                                                                                                                                                                                        |
| `tern_failed`               |                                                 | Show the user the message. Check that Tern runs and process inspection works. A failed process inspection stops `remove` before removal, also with `--force`. `--keep-tab` and `--close-busy-tabs` skip that inspection.                                                                                                                                                                                      |

An error from `create` after a rebuilt relocation copied the ignored files adds the field `staging`: the temporary folder that keeps those copies. The message names it. Tell the user, and do not delete that folder.

## Repository environment

Read `.tern/worktree.json` at the checkout root. Each key is optional. A missing file supplies the defaults. The accepted keys:

- `setup`: an ordered array of non-empty shell commands without line breaks, default `[]`. Runs before user setup commands.
- `services`: a map from service names to Docker declarations, default `{}`. Each declaration must have `image` (string), `port` (host port) and `containerPort` (container port). Optional fields are `env` (string map), `args` (argument array after the image), `tmpfs` and `memory` (strings passed to Docker), and `ready` (non-empty command array for `docker exec`). Ports are integers from 1 to 65535. Names use letters, digits, `.`, `_` and `-`, start with a letter or digit, and are unique ignoring case.
- `env`: a string map, default `{}`. Names must be valid environment variable identifiers. Values are literal. Only a leading `~/` expands to the home directory. `$VAR` and shell substitutions are not expanded. Applies to setup, heavy commands and the setup line of new worktree tabs. Service `env` values stay literal, also with `~/`.
- `heavy.slotMemoryGb`: a positive finite number, default `7`, for sizing host-wide heavy slots.

Services need a GitHub origin. All worktrees of the repository share the lowercase container name `tern-wt-<owner>-<repo>-<name>` and label `tern-wt.service=<owner>/<repo>/<name>`. Running containers are reused without changing their declaration. Stopped containers are removed with `docker rm -fv` and started again from the declared specification. `ready` runs in the container until it succeeds, with a 60 s deadline, also for reused running containers. Service failures stop preparation before setup or a new tab opens. See the [README example](../../README.md#prepare-a-repository-environment) for a complete declaration.

## Options file

The file is `config.json` in the plugin data dir, the first of:

1. `$TERN_PLUGIN_DATA`, when set.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when `TERN_CONFIG_DIR` is set.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

An invalid file makes each command fail with `config_invalid`. The keys:

- `teardown`: the teardown policy. It sets what `remove`, and the close of a worktree tab, do to the branch. `worktree` keeps the branch. `worktree+merged-branch`, the default, deletes a merged branch. `worktree+branch` deletes the branch. A branch is merged when it is an ancestor of `origin/<default>`, or when its tip is the head commit of a merged pull request or an ancestor of that commit.
- `cloneRoot`: the dir for `clone` and `new-repo`, an absolute path or a path that starts with `~`. The default is `~/Developer`.
- `hotkeys.new`: the Tern key chords that open the branch picker. The default is `["cmd+shift+w"]`. The picker uses the repository of the focused pane, else the session's first repository. When the session has no repository, it opens the repo picker. Clicking the worktree segment follows the same rule.
- `setup`: the user setup commands of each repository, for example `{"virtusize/aoyama": ["npm ci", "npm run build"]}`. The key is the name with owner, ignoring uppercase and lowercase letters. The value is a list of shell commands without line breaks. An empty list runs nothing. The default is `{}`. These run after repository setup commands in `prepare`, and in the setup line of each new worktree tab.
- `issueBranch.fixLabels`: a list of labels that select `fix/` for issue branches, ignoring uppercase and lowercase letters. The default is `["bug", "fix", "regression", "hotfix"]`. With `[]`, only the issue type `Bug` selects `fix/`.
- `issueBranch.linkOnGitHub`: a boolean, `false` by default. `true` opts into `gh issue develop` to create a remote branch linked to the issue on GitHub. The default records only the local `ternIssue` setting.

In Tern, select `From issue…` in the branch picker or `New worktree from issue` in the palette (`plugin.tern-worktrees.from-issue`). The prompt starts from the clipboard when it holds an issue URL, then a second prompt lets the user edit the suggested branch. `New branch…` detects a pasted issue URL too. For a different repository, the plugin uses a matching open repository session or offers `Clone <owner>/<repo>`.
