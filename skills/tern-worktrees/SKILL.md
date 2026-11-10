---
name: tern-worktrees
description: Use to create, list, relocate or tear down git worktrees as Tern tabs with tern-wt, finish a merged delivery with explicit teardown consent, plan repository cleanup, prepare repository environments, or run heavy commands in host-wide slots. Replaces Orca worktrees.
---

# tern-worktrees

`tern-wt` keeps git worktrees in the worktree root and opens each one in a Tern tab. The worktree root is `$TERN_WT_HOME/worktrees` when `TERN_WT_HOME` is set. Else, when omp is installed, it is omp's default worktree root, usually `~/.omp/wt`: `$OMP_WORKTREE_DIR`, else the omp setting `worktree.base`, else the `wt` folder of the omp data folder, which follows `PI_CONFIG_DIR`, `OMP_PROFILE` and `$XDG_DATA_HOME/omp` as omp does. Else it is `~/.tern-wt/worktrees`. A tern-managed worktree is at `<root>/<repo>/<slug>`, where `<repo>` is the folder name of the main checkout and the slug is the branch name with each `/` changed to `-`. Each other worktree in the omp worktree root is omp-owned: `tern-wt` opens it, and does not remove it.

## Rules

- Use `tern-wt` for a branch worktree, not `git worktree` or `orca worktree`. A branch worktree holds issue or pull request work, a pushed branch, a Tern tab or repository services.
- Use an ovnfs checkout for a throwaway isolated copy, for example an experiment, when `ovnfs` is on `PATH`. Open it with `ovnfs new`, and merge it back with `ovnfs apply`. Run `ovnfs rm` on each checkout that you opened. omp gives each `isolated: true` subagent its own ovnfs checkout.
- For work on an issue, use `tern-wt create --issue <url>` (or the plugin's `create` export with `issue`). This derives the branch and records `ternIssue`. Use `--branch --new` alone only for work with no issue.
- Put `Closes <owner>/<repo>#<n>` in the PR body, or `Closes #<n>` when the issue is in the same repository.
- Run `remove` only on a worktree you created in this session, or one the user names.
- Pass `remove --force` only after the user says yes: it discards work to lose, but does not permit closing busy tabs.
- On `busy_tabs`, show the user the reported processes. Pass `--close-busy-tabs` only after the user agrees to close them, separately from approval for `--force`.
- After `busy_tabs`, keep the process check on retry unless the user agrees to bypass it. Ask before retrying with `--keep-tab` too: it removes the worktree without examining running processes.
- Tabs that `create` opens are yours to close (skill://tern-cli). `remove` closes them after the process check. `--close-busy-tabs` skips the check. `--keep-tab` skips the check and keeps the tabs open.
- Do not run `omp worktree clear` without `--dry-run` first. With or without `--all`, it deletes each worktree that omp sees as orphaned, and omp can see a live tern-managed worktree as orphaned, for example with `worktree.useRelativePaths=true` or after the main checkout moved.
- For repository cleanup, run `clean --repo <dir>` first and show the user its `remove`, `keep` and `warnings`. Run `clean --repo <dir> --apply` only after the user explicitly says yes to that plan. A request to examine or plan cleanup is not approval to apply it.
- Treat `clean` as repository-scoped. Keep uncertain resources. Do not supplement it with host-wide Docker, volume or temporary-file pruning.
- At the real end of a merged delivery, use the [delivery finish](#finish) lifecycle when available. Register the run's paths and blocked lanes. Signal readiness only after all requested deliveries and jobs complete. A worker returns delivery evidence to its coordinator. Only the coordinator asks for teardown.

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

Before the last `git submodule update --init --recursive`, `create` initializes top-level submodules from the main checkout when the target has no `.git` and the local objects contain the recorded commit. A submodule with `update=none` stays uninitialized, with no clone or repack. Submodule git folders copied by omp keep their custom `origin` and copy-on-write objects, with no repack. The main checkout's objects and `objects/info/alternates` stay unchanged.

For a non-shallow source, local initialization uses a temporary local URL with `--reference`. Only an actual clone with its own `.git` and `objects/info/alternates` copies the referenced objects into its object store and removes that reference. For a shallow source, it clones through a local `file://` URL with `--depth 1` and no reference or `objects/info/alternates`, fetching the recorded commit directly from that local source if it is not in the cloned tip. Only an actual clone gets its `origin` restored to the original URL. This also applies to plain git worktrees and a rebuilt relocation.

A missing local commit skips reuse without a warning. A failed local clone adds `local submodule reuse failed for <path>: <error>` before the normal recursive update, which can fetch from the original remote. A failure to copy the referenced objects or remove their reference adds `local submodule reuse failed for <path>: <error>; reference to main checkout objects remains`. That submodule still depends on the main checkout's object store. A `submodule repair failed: <error>` warning stays first. `submodule update failed: <error>` follows if the recursive update fails. The worktree stays available.

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

For a new worktree, `create` loads `.tern/worktree.json` and starts or reuses its services before opening the tab. It waits a maximum of 30 s for the shell prompt, then types the setup line: environment activation first, repository setup commands second, and user setup commands last, with `&&` between them. These commands run in the tab. `create` does not wait for them to complete. See [Repository environment](#repository-environment). Reused and relocated worktrees get no preparation.

Output: `{"path", "branch", "repo", "owner", "port", "status", "carried", "setup", "tab", "warnings"}`, plus `issue` for an issue.

- `owner`: `tern` for a tern-managed worktree, `omp` for an omp-owned worktree, as in `list`, and `main` for the main checkout. A reused omp-owned worktree and the omp checkout of a pull request give `omp`.
- `port`: the numeric worktree base port, or null for the main checkout. It is an even number from 4000 through 5998, saved in `branch.<branch>.ternWtPort`. Reuse and relocation keep a saved value unless a different live branch worktree of the same repository uses it. Without a saved value, start at `4000 + 2 * (SHA256(<main checkout folder name>/<branch>).readUInt32BE(0) % 1000)`. Collisions, also for a saved value, with other live branch worktrees of the same repository increase the port by 2, wrapping from 5998 to 4000. Before assigning a port to a new worktree, `create` reserves and saves the derived ports of the other live worktrees that have no saved value. A new branch does not get their ports through alphabetical order. Use the base port and base + 1 for two development servers. Shared Docker service ports stay as declared.
- `status`: `created`, `reused` or `relocated`. For an omp-owned worktree and for the main checkout, `reused` with its `path`.
- `carried`: the ignored files, as paths in the worktree, that a rebuilt relocation copied into the new worktree. Empty otherwise. When the new worktree has a file at that path, the copy stays in the temporary folder, with a `not carried:` warning.
- `setup`: `{"line", "typed"}`, or null. For a new worktree, `line` starts with `eval "$(tern-wt env . --shell)"` to activate `TERN_WT_PORT` and the declared environment variables, then joins repository setup and user setup commands with `&&`. It still returns the activation line without a repository file or setup commands. Repository setup and environment variables need no GitHub origin. User setup commands use its name with owner. `setup` is null for reused or relocated worktrees. `typed` is true when `create` typed the line into the tab it opened. When the tab was open before, no prompt shows in 30 s, or Tern fails, `typed` is false with a `setup not run:` warning, and the worktree stays. With `--no-tab`, `typed` is false without running the line.
- `tab`: `{"session", "block", "opened"}`, or null with a `tab not opened:` warning. `opened` is false when `create` focused a tab that was open before.
- `issue`: for an issue URL or short issue reference, `{"number", "url", "title"}` identifying the issue recorded in `ternIssue`. No `issue` field for `/pull/<n>` URLs, which use the PR flow.

The Carly `create` export has the signature `(repo: string, branch: string?, new: boolean?, issue: string?)`. For issue work, pass the repository directory first and the issue URL fourth, with an optional branch override second. Keep `new` unset. The issue flow creates or reuses the branch.

Run `create` commands for the same repository sequentially. Port allocation has no lock, so concurrent creates can select the same port.

### `prepare`

`tern-wt prepare <path> [--no-setup]`

Loads the [repository environment](#repository-environment), starts or reuses shared Docker services, then runs setup commands sequentially in the checkout root: repository commands first, user commands second. Applies the declared environment and, for a linked branch worktree, `TERN_WT_PORT` to each command and waits for it to complete. `--no-setup` still starts or reuses services but runs no setup commands. This command needs no Tern tab.

Output: `{"path", "repo", "services": [{"name", "container", "status"}], "setup": [{"command", "exitCode", "ms"}], "env", "warnings"}`. `path` is the checkout root, `repo` its lowercase name with owner or null without a GitHub origin, service `status` is `started` or `running`, and `ms` is each command's time in milliseconds. `setup` is empty with `--no-setup`. The first failed command stops setup with `setup_failed`, `command`, `exitCode` and the last 40 output lines in `output`.

### `env`

`tern-wt env <path> [--shell]`

Returns `{"env": {"NAME": "value"}}` with repository variables and, for a linked branch worktree, the base port as the string `TERN_WT_PORT`. Without repository variables, an example is `{"env":{"TERN_WT_PORT":"4280"}}`. The main checkout and detached worktrees get no generated `TERN_WT_PORT`. With `--shell`, prints POSIX-quoted `export NAME='value'` lines, not JSON. Apply them to the current shell with `eval "$(tern-wt env . --shell)"`. The generated port needs no repository file. Reading an older worktree without a saved port derives it without writing git settings. This command starts no services and runs no setup commands.

### `heavy`

`tern-wt heavy [--repo <dir>] -- <command> [args...]`

Starts or reuses repository services, applies the declared environment and, for a linked branch worktree, `TERN_WT_PORT`, gets a host-wide slot and runs the command. `--repo` selects the checkout for its repository file and base port. The command's working directory stays the current directory. It runs no setup commands. Standard output, standard error and the child exit code pass through without a JSON result.

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

### `finish`

The omp extension uses the real built-in `ask` at the end of a completed delivery. The preview names the selected worktree paths, merged pull requests and commit IDs. Three alternatives are available. Remove this session or run's managed worktrees, add other merged managed worktrees of this repository, or keep all worktrees. Keeping everything is recommended. A composed caller with more requested work waits until its last delivery. Orchestration asks once through its coordinator and preserves blocked lanes.

Use the `worktree_finish` tool's `scope` action at the start of a composed delivery to register its boundary and paths. The preview uses canonical paths, and the offered selections stay fixed even if a subsequent scope call adds paths. A declared scope defers automatic offers until `ready`. Use `ready` only when all requested work and jobs complete, or to examine readiness again after a failed automatic check. The tool does not accept a teardown selection. Consent comes only from the matching built-in `ask` result. A dialog, shell command or model-authored selection cannot grant consent. If the tool or built-in `ask` is unavailable, report that limit and preserve the worktrees and tab.

The native contract is omp 18.18.3's HTML-form `ask`, not the former `questions` input. When the extension offers a preview, call the built-in `ask` once. Use the supplied `html` and French `i` without changes. The value of `i` is `Recueillir le choix explicite de Florian sur les worktrees du plan enregistré, sans suppression par défaut.` The host strips `i` before the hooks. The hooks accept only the saved `{html}` input and the matching tool call ID. Preserve the supplied form unchanged. It has three radio values, `current`, `merged` and `none`, with labels `Supprimer seulement mes worktrees`, `Supprimer aussi les autres PR fusionnées du dépôt` and `Ne rien supprimer`. Only `none` is selected by default.

The native result must contain matching representations of the same answer: the `User answers:` JSON text maps the saved form name to its radio value, and `details.answers` carries the matching name, legend and label. An error, cancellation, timeout, Other text, changed form or disagreement between those representations cannot arm teardown. Preserve all worktrees and the tab, and report the limit. An older ask API that rejects the form gets the same safe outcome. Do not retry with `questions` or a different consent mechanism.

After approval, write the delivery report before the caller exits. Report the teardown as armed, not completed. The external executor waits for the caller to exit and examines each target again. It closes only the tabs of removed worktrees. Tern reports the actual result without using the removed tab. Keep omp history. Manual tab closure still uses its picker.

Before reporting completed work, read [Delivery finish limits](../../docs/README.md#delivery-finish-limits) for connected RPC exit and CI proof. Report unresolved proof as a limit. Do not claim that no workflow applies.

The CLI protocol is:

```sh
tern-wt finish plan --repo <dir> [--current <worktree>] [--owned <path> ...] [--exclude <path> ...] [--pid <pid>] [--block <block>] [--session <id>]
tern-wt finish arm <id> --choice current|merged|none [--selected <path> ...]
tern-wt finish status <id>
```

`plan` examines Git refs and worktrees without changing them, then saves a private local plan. It returns `id`, `repo`, `current`, `ready`, `candidates`, `keep` and `warnings`. Each candidate has `path`, `branch`, `head` and a `pr` proof with `number`, `url`, `headRefOid`, `mergeCommit` and `mergedAt`. Each kept target has `path`, `code` and optional `detail`, as defined below. `ready` needs merged PR evidence at the same commit IDs as the run and successful applicable post-merge workflows.

Only call `arm` after explicit consent to that saved preview. Supply `--selected` for each approved canonical path. The CLI compares this set with the saved selection before it starts a worker. A mismatch stops arm without teardown. `current` selects its eligible current and registered run paths. `merged` selects its saved candidates, and `none` records refusal with an empty selection. It returns `id`, `status` and `selected`. A PR merged after approval cannot expand the selection. Do not replace this lifecycle with `remove --force`, `--keep-tab` or `--close-busy-tabs`.

`status` returns the plan plus `status`, `selected`, `removed` and `errors`. States are `planned`, `armed`, `declined`, `running` and `completed`. Removed entries have `path`, `branchDeleted` and `closedBlocks`. Errors have the same `path`, `code` and optional `detail` shape as kept targets. Read `keep`, `warnings` and `errors` even when execution completed. Internal commands `execute <id>`, `notices` and `acknowledge <id>` serve the executor and the Tern result action. They do not grant consent.

Preserve the main checkout, non-managed worktrees, paths identified to stay, blocked lanes, work to lose, live activity and uncertain targets. A closed issue or a closed PR without a merge is not sufficient. Before teardown, the executor examines path, registration, lock, branch, HEAD, merge proof and activity again. Changes can shrink the selection. Follow the teardown policy for local branches and keep remote branches. Unlike `clean`, this path does not discard changes, create recovery archives or prune Docker resources.

#### Finish causes

Each `keep` or `errors` entry has the form `{"path": "/canonical/worktree", "code": "path_identity_changed"}`, with an optional `detail` string. `code` is the stable public value for automation. `detail` carries an external exception message when available, for inspection rather than matching. Internal decisions carry no explanatory prose in `detail`. These entries have no `reason` field.

| Code                    | Cause                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| `path_identity_changed` | A path no longer has its approved identity or canonical directory form. |
| `registration_changed`  | The worktree registration, branch or HEAD no longer matches approval.   |
| `inspection_failed`     | A required inspection failed without a more specific CLI error code.    |
| `caller_waiting`        | The executor cannot prove that the caller has exited at this time.      |
| `interrupted`           | An earlier teardown stopped and is not replayed.                        |
| `worker_start_failed`   | The external teardown worker could not start.                           |
| `teardown_failed`       | Teardown failed without a more specific CLI error code.                 |
| `not_managed`           | The target is not an eligible managed worktree.                         |
| `retained`              | The coordinator did not include the target in teardown.                 |
| `not_merged`            | The required merged pull request proof is unavailable.                  |
| `active_process`        | Live activity prevents teardown.                                        |

Finish also preserves the [CLI error codes](#error-codes), for example `dirty_worktree`, `busy_tabs`, `git_failed` and `tern_failed`. It does not replace them with a generic cause. This does not change the CLI error envelope or `clean`'s `reason` fields.

Saved finish state uses version `2`. The CLI rejects version `1` and other state that is not compatible. It does not convert that state or authorize teardown from it. Create a new plan and get consent to its preview.

### `clean`

`tern-wt clean --repo <dir> [--apply]`

Without `--apply`, returns a dry-run plan without writing anything, fetching or pruning refs. Show the plan to the user before asking to apply it. With explicit approval, run the same command with `--apply`: it fetches and prunes `origin`, then builds a new plan rather than replaying the dry run. The new plan can be different from the preview.

Output: `{"repo", "default", "remove": {"worktrees": [], "branches": [], "processes": [], "containers": [], "paths": []}, "keep": [{"kind", "id", "reason"}], "warnings": []}`, plus `"applied": true` with `--apply`.

- `repo`: the main checkout. `default`: the default branch.
- `remove.worktrees`, `remove.branches`, `remove.containers` and `remove.paths`: arrays of strings identifying the planned removals.
- `remove.processes`: `[{"pid", "cwd", "command"}]`, with a numeric process ID and strings for the working directory and command.
- `keep`: kept resources and the cause for each decision. Read this alongside `warnings`. An empty removal list does not prove that the repository has no resources that are not used.
- `removalDetails`: optional entries `{"kind", "id", "reason", "recovery": true, "recoveryPath"?}` for linked removals and integrated branches with commits missing from remote branches. Each entry requires recovery before removal. `recoveryPath` identifies the saved files after applying.

Closed linked issues and closed or merged pull requests can authorize removal without proof of integration. Associations come from branch names `<prefix>/<number>-<slug>`, `<prefix>/<number>` and `pr-<number>`, `branch.<branch>.ternIssue` references, and worktree folder names starting with `<number>-`. All references for a target must be closed or merged. Open or unknown references do not authorize the exception. GitHub evidence is read in one batched operation for all targets. Live-process, caller, locked-worktree and inspection protections still win.

Before applying each removal recorded in `removalDetails`, `clean` saves recovery files in `${XDG_STATE_HOME:-~/.local/state}/tern-wt/recovery/<timestamp>/<slug>/`: a binary patch against `HEAD`, a tar archive of non-ignored files not tracked by Git, the branch name and tip SHA in a manifest, and a Git bundle when commits are missing from all remote branches. This also applies to integrated branches with commits missing from remote branches. Initialized submodules get their own recovery files. A recovery failure keeps the target. Ignored hard-to-rebuild files still block removal. A dry run creates no recovery files.

Keeps the main checkout, the caller's worktree, a worktree that is the caller's working directory or an ancestor of it, live omp sessions, and worktrees with a live busy Tern block. Work to lose and work on branches without proof of integration stay unless the closed-link exception above authorizes removal with recovery. Hard-to-rebuild files follow the teardown rule: a copy with the same bytes in the main checkout does not block removal. When inspection cannot prove safety, the related resource stays. No flag bypasses these protections.

For `clean`, a branch is integrated when its tip is an ancestor of `origin/<default>` or one merged pull request's head commit. It also counts as integrated when `git merge-tree` shows that merging it into `origin/<default>` keeps that tree unchanged. `clean` reads merged pull requests and linked issue states in one batched GitHub operation. It batches branch tips and ancestry proofs, bounds concurrent branch and worktree inspections, and runs `merge-tree` only for branches not proven integrated. Without the closed-link exception, removing commits missing from remote branches needs proof of integration.

Process-related keep causes identify the PID and command, or state that inspection is unavailable. Linux reads `/proc`. macOS reads process working directories with one `lsof` snapshot and parent relationships with `ps`. When process inspection is not full, the process keeps only a worktree that contains its known working directory. An unrelated process does not keep all worktrees. When inspection is unavailable, for example when `lsof` is missing or fails on macOS, worktrees stay with an explicit cause. Branch cleanup can still continue. When Tern inspection is unavailable, all worktrees stay with an explicit cause.

Process removal works on Linux and macOS and needs repository attribution. A process must be in a worktree selected for removal or be a proven orphan. The caller and its ancestors, live omp sessions and their descendants, system services and the rootless Docker daemon stay. `clean` does not stop a live busy Tern block. That block keeps its worktree. Containers need evidence tying them exclusively to worktrees in `remove.worktrees`. `Testcontainers` containers also need an `org.testcontainers.sessionId` label, no other container with the same session label, and no live working directory below their source paths. Shared `tern-wt` services and unattributable containers stay. Anonymous volumes are not removed. `paths` contains only empty directories left at paths of Git worktree entries identified `prunable`, with identity examined again before removal. Do not infer a temporary-file, staging-copy, Docker image or volume sweep from this field.

### `list`

`tern-wt list [--repo <dir>] [--all]`

- `--all`: also list the omp-owned worktrees, at all depths in the worktree root. `list` does not look in a worktree or a main checkout.

Output: `{"root", "warnings", "worktrees": [{"path", "repo", "branch", "port", "dirty", "changed", "owner"}]}`. Without `--all`, `list` shows the tern-managed worktrees only. With `--repo`, `list` shows only the worktrees of the repository that contains `<dir>`.

- `repo`: the main checkout.
- `branch`: null for a detached `HEAD`.
- `port`: the numeric worktree base port, or null for a detached `HEAD`. Uses the saved value from `create`, or derives it for an older worktree without writing git settings.
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

Links `~/.local/bin/tern-wt` to the CLI and `~/.agents/skills/tern-worktrees` to this skill. It links each applicable omp agent directory's `extensions/tern-worktrees-omp` to the bundled `omp` package. Setup covers the default agent, active agent and real profiles on disk, using omp configuration paths. Restart a running omp session to load the extension. The plugin runs setup each time it loads in a Tern window. A second run changes nothing. Output: `{"links": [{"path", "target", "action"}]}`, with `action` `created`, `kept`, `replaced` or `removed`. It removes the previous `~/.omp/agent/skills/tern-worktrees` symbolic link only when its target is this bundled skill. The target package must have the name `tern-worktrees`. A conflicting real file, folder or unrelated extension link gives `path_conflict` before setup changes links. Preserve unrelated links and real directories.

## Error codes

Main checkouts with an external Git directory are supported. Linked worktrees of that layout and bare repositories give `not_a_repo`.

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
- `env`: a string map, default `{}`. Names must be valid environment variable identifiers. `TERN_WT_PORT` is reserved. Declaring it here gives `worktree_config_invalid`. Values are literal. Only a leading `~/` expands to the home directory. `$VAR` and shell substitutions are not expanded. Applies to setup, heavy commands and the setup line of new worktree tabs. A linked branch worktree also receives its generated `TERN_WT_PORT`, even without this file. Service `env` values stay literal, also with `~/`.
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
- `hotkeys.new`: the Tern key chords that open the branch picker. The default is `["cmd+shift+w"]`. The picker uses the focused pane's repository. When the pane has no working directory, use its agent's directory, then the first known directory in its tab. Without a repository there, use the session's first repository. When the session has no repository, open the repo picker. Clicking the worktree segment and the issue palette command use the same rule.
- `setup`: the user setup commands of each repository, for example `{"virtusize/aoyama": ["npm ci", "npm run build"]}`. The key is the name with owner, ignoring uppercase and lowercase letters. The value is a list of shell commands without line breaks. An empty list runs nothing. The default is `{}`. These run after repository setup commands in `prepare`, and in the setup line of each new worktree tab.
- `issueBranch.fixLabels`: a list of labels that select `fix/` for issue branches, ignoring uppercase and lowercase letters. The default is `["bug", "fix", "regression", "hotfix"]`. With `[]`, only the issue type `Bug` selects `fix/`.
- `issueBranch.linkOnGitHub`: a boolean, `false` by default. `true` opts into `gh issue develop` to create a remote branch linked to the issue on GitHub. The default records only the local `ternIssue` setting.

In Tern, select `From issue…` in the branch picker or `New worktree from issue` in the palette (`plugin.tern-worktrees.from-issue`). The prompt starts from the clipboard when it holds an issue URL, then a second prompt lets the user edit the suggested branch. `New branch…` detects a pasted issue URL too. For a different repository, the plugin uses a matching open repository session or offers `Clone <owner>/<repo>`.
