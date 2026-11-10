# tern-worktrees

Git worktrees as [Tern](https://docs.stencil.so/tern) tabs, in four parts:

- The `tern-worktrees` Tern plugin. `cmd+shift+w` (W for worktree) opens the branch picker, and the branch you pick opens as a worktree tab. The command palette also lists the branches and pull requests of the current repository as worktree rows. When you close a worktree tab, a Tern picker offers to keep the worktree or tear it down.
- The `tern-wt` CLI, the one implementation of each git and GitHub step. The plugin runs it, and agents run it directly.
- The `tern-worktrees` omp skill, the contract that agents follow.
- The bundled omp extension, which offers consented delivery finish through the built-in `ask` tool.

Each tern-managed worktree lives in the worktree root, at `<root>/<repo>/<slug>`. The slug is the branch name with each `/` changed to `-`. The worktree root is `$TERN_WT_HOME/worktrees` when you set `TERN_WT_HOME`, else the omp worktree root when omp is installed, else `~/.tern-wt/worktrees`. See [Work with omp](#work-with-omp).

## Requirements

- Tern 0.8.0 or a newer version.
- [bun](https://bun.sh).
- git.
- [gh](https://cli.github.com), logged in (`gh auth login`).

## Install

```sh
tern plugin install github.com/riicodespretty/tern-worktrees
```

Tern runs `tern-wt setup` from its installed plugin copy each time the plugin loads in a window. This occurs when the window starts or `tern plugin install` adds or updates the plugin in an open window. `setup` links `~/.local/bin/tern-wt` to the CLI and `~/.agents/skills/tern-worktrees` to the skill. It links the omp agent directories' `extensions/tern-worktrees-omp` to the bundled `omp` package. Setup covers the default agent, active agent and real profiles on disk, using omp configuration paths. A new or changed link shows the toast `Linked tern-wt, the tern-worktrees skill and the OMP extension`. Correct links show no toast. A conflicting real file, folder or unrelated extension link gives `path_conflict` before setup changes links.

`setup` also removes the previous `~/.omp/agent/skills/tern-worktrees` link when its target is the bundled skill of a package named `tern-worktrees`. It preserves real folders and links to other targets. The JSON `links` list reports that link and its target with action `removed`.

Put `~/.local/bin` on your `PATH`, so that your shell and your agents find `tern-wt`.

Restart a running omp session to load the extension. New sessions find it through omp's native extension loader. Without the extension or built-in `ask`, the manual teardown rules still apply. This grants no teardown consent.
Run `tern-wt setup` again after creating a named omp profile. Setup does not create profiles or modify omp configuration or plugin lock files.

To update the plugin, run:

```sh
tern plugin install github.com/riicodespretty/tern-worktrees --force
```

To remove the plugin, remove it from Tern, then delete its CLI and skill links. Before deleting an `extensions/tern-worktrees-omp` link, make sure it points to this package's `omp` directory. Use the agent directories reported by `tern-wt setup`. Keep unrelated links and real directories.

```sh
tern plugin remove tern-worktrees
rm ~/.local/bin/tern-wt ~/.agents/skills/tern-worktrees
```

## Usage

### Open a worktree tab

1. Press `cmd+shift+w`. The branch picker opens over the focused pane, for its repository. When the pane has no working directory, use its agent's directory. Without an agent directory, use the first known directory in the same tab. When that directory is in no repository, use the session's first repository. When the session has no repository, the repo picker opens first.
2. Type to filter. The branch picker lists `New branch…`, `From issue…`, `Other repo…`, the open pull requests, then the branches. The label of a pull request row is `#<n> <title> · <branch>`, so you can also find the row when you type part of its branch name. A branch with a worktree shows `worktree` in dim text adjacent to its name. The filter reads only the row name, not the dim text.
3. Press Enter on a branch or a pull request. To start a new branch from `origin/<default>`, press Enter on `New branch…`. Type the branch name, then press Enter. When `tern-wt` refuses the name, a toast tells you why. The prompt then opens again and shows the name that you typed. If you press Escape, or press Enter with no name, the plugin makes no branch.

The first open of the branch picker for a repository in a Tern window waits for its branches and pull requests, with a `Loading branches…` toast. When the list is ready, a `Branches loaded` toast replaces it. Each subsequent open shows the last list at once and gets a new list in the background, with a `Refreshing branches…` toast. When the new list is ready, a toast tells you to reopen the picker to see the changes, or that it found no changes. When the refresh fails, an error toast gives the cause.

While `tern-wt` makes the worktree, a `Creating worktree <branch>…` toast shows, or `Reusing worktree <branch>…` when the branch has a worktree. When it is done, a `Created worktree` or `Reused worktree` toast replaces it. The worktree tab opens with the name of the branch, in the session of its repository, else in a new session named after the repository. When the worktree has a tab, the plugin focuses that tab. The `Created worktree` or `Reused worktree` toast shows when the tab opens, before the plugin types the setup line. When the setup line cannot run, a `Setup not run: …` toast then replaces it and stays.

When the main checkout of the repository has the branch that you picked, the plugin opens the main checkout. An `Opening main checkout…` toast shows, then an `Opened main checkout` toast replaces it. The plugin focuses the tab of the main checkout, else it opens a tab there. The plugin does not move the main checkout, and the tab of the main checkout is not a worktree tab, so its close opens no teardown picker.

Each picker, prompt and confirmation of the plugin uses the Tern picker or the Tern prompt. In a picker, a path in your home folder starts with `~`.

CLI directory arguments accept `~` and `~/` paths, also with `--repo`. `resolve` keeps the directory string as given in its `dir` field. The plugin compares home-relative pane directories with absolute worktree paths. Window load defers saved index and hotkey file reads to the next tick. Background directory, focus and command end events share deferred refreshes. Worktree rows register in batches of eight.

### Start work from an issue

Select `From issue…` in the branch picker, or `New worktree from issue` in the command palette. Bind `plugin.tern-worktrees.from-issue` in Tern settings for a direct shortcut. The issue prompt starts with the clipboard text when it holds a GitHub issue URL. Paste the URL and press Enter, then edit or accept the suggested branch name in the second prompt. Pasting an issue URL into `New branch…` starts the same flow.

For an issue in a different repository, the plugin uses an open repository session with a matching `origin`. When no checkout is available, it offers `Clone <owner>/<repo>` through the clone flow. It clones only after you select that action. A pull request URL opens the pull request worktree.

From a shell or an agent:

```sh
tern-wt create --issue https://github.com/owner/repo/issues/342
tern-wt create --repo /path/to/repo --issue '#342' --suggest
tern-wt create --issue https://github.com/owner/repo/issues/342 --branch fix/342-custom-name --no-tab
```

`--issue` accepts a GitHub issue URL with a trailing path, query or fragment. Short references (`#342` or `342`) need `--repo`. The CLI first checks a matching `--repo` checkout, then `<cloneRoot>/<owner>/<repo>`. Without a checkout, `not_cloned` gives the clone `path` and the name with owner in `repo`. Run `tern-wt clone <owner>/<repo>` before you retry. `--suggest` returns the derived `branch`, `issue`, `repo` and `warnings` without fetching, writing git settings or creating a branch, worktree or tab. `--branch` overrides the derived name without needing `--new`.

An issue branch has the form `fix/342-title-slug` when the issue type is `Bug` or a label matches `issueBranch.fixLabels`, ignoring uppercase and lowercase letters. Otherwise it starts with `feat/`. The title slug drops a leading `[tag]` and issue-number references, removes accents and quotes, changes words to lowercase, replaces other separators with `-`, and drops French and English stop words. It keeps at most five words and 40 characters on a word boundary. An empty slug gives `fix/342` or `feat/342`. An unrelated name collision adds `-2`, `-3` and so on. The worktree folder still replaces `/` with `-`.

A local or `origin` branch that matches `^(fix|feat)/342(?:-|$)` is reused with its worktree. This also applies to `fix/342` or `feat/342` with no slug. A new branch starts from `origin/<default>`. A closed issue adds a warning. For an issue reference, the result includes `issue: {number, url, title}`, and the branch records the issue URL in `git config branch.<branch>.ternIssue`. A `/pull/<n>` URL opens the PR flow directly and has no issue metadata. Use it without `--suggest`.

For these related branch names only, the CLI first selects a branch with a `ternIssue` value that matches the issue URL exactly, then a branch with no issue association.

The default makes no GitHub writes. Set `issueBranch.linkOnGitHub` to `true` to opt into `gh issue develop <n> --repo <owner>/<repo> --name <branch>`, which creates a remote branch linked in the issue's Development panel. It creates a branch, not a link for a branch from an earlier push. A GitHub failure, for example a conflicting branch, gives `gh_failed`.

Agents working on an issue must use `tern-wt create --issue <url>` rather than invent a branch with `--branch --new`. Use `--branch` alone only for work with no issue. Put `Closes <owner>/<repo>#<n>` in the PR body, or `Closes #<n>` for an issue in the same repository.

### Open a worktree from the command palette

In a pane of a repository or of one of its worktrees, the command palette (`cmd+shift+p`) shows the `Worktrees` group. This group has a worktree row for each branch and each open pull request:

- `<repo>: <branch>`, with ` · worktree` at the end when the branch has a worktree.
- `<repo>: #<n> <title>` for a pull request.

Press Enter on a row to open its worktree tab, as the branch picker does. The rows of a repository show only in its panes.

The rows refresh from local refs, with no network traffic. This refresh runs when a shell command ends in a pane of the repository and when one of its panes gets focus. It also runs after the plugin makes or removes a worktree, for the repository of that worktree only. The fetch from `origin` and the list of open pull requests run at most one time in each Tern auto-fetch interval, the Tern setting `git.auto_fetch_minutes` (5 by default). The rows and the branch picker share one list of branches and pull requests. Each open of the branch picker fetches and lists the pull requests, and the auto-fetch interval starts again from it. Thus the pull request rows also update after an open of the branch picker. When you set `git.auto_fetch_minutes` to 0, Tern auto-fetch is off, the rows refresh from local refs only, and the pull request rows update only after an open of the branch picker.

`cmd+shift+w` also opens the branch picker. Use the branch picker to select `New branch…` or `Other repo…`.

### Select a different repository

In the branch picker, select `Other repo…`. The repo picker shows:

- Each repository open in a session, in the `Open sessions` group.
- In the `GitHub` group, `Browse GitHub repos…`: the repositories of your GitHub user and organizations, grouped by owner. `tern-wt` clones the one you select to the clone root, or reuses the clone there. When GitHub lists no repository, a toast says so.
- In the `GitHub` group, `Create new GitHub repo…`, which asks for the owner, the name and the visibility (`Private` or `Public`), then makes the repository and clones it. When the name is empty, the plugin makes no repository.

The branch picker of that repository opens next.

### Relocate

A branch can have a worktree that is not in the worktree root, for example from Orca, or from `tern-wt` before you installed omp, in `~/.tern-wt/worktrees`. When you pick that branch, a picker reads `Worktree of this branch is at <path>` and offers `Relocate to <path>`. Enter relocates, and Escape keeps the worktree where it is. Relocate moves the worktree into the root.

When git refuses the move, `tern-wt` makes the worktree again in the root with plain `git worktree add`, also in omp clone mode. Of the work to lose in the first worktree, only a change, a new file that git does not track or a submodule commit not held by a remote branch or by the main checkout's committed submodule history stops the rebuild. Then the worktree stays where it is, and a message lists that work.

The submodule check is local: it trusts the commits recorded in `HEAD` of the main checkout, and their ancestors, also for nested submodules, only when the two submodule object stores have the recorded commit: the main checkout and the worktree. Otherwise, only remote branches protect the commits. A release tag need not be fetched. A local tag alone does not protect a commit. A submodule commit recorded only in the worktree being removed or relocated does not protect it.

An omp-owned worktree of the branch needs no relocation: `tern-wt` opens its tab where it is.

Ignored files that are hard to rebuild, for example `.env` or `*.pem`, do not stop the rebuild: `tern-wt` copies them into the new worktree, in the submodules too, and lists them in `carried`. An ignored file is build, install or tool output when a part of its path is `node_modules`, `dist`, `build`, `coverage`, `.DS_Store`, `.cache`, `.next`, `.nuxt`, `.output`, `.turbo`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `__pycache__` or `.venv`, or its filename ends with `.tsbuildinfo`. Those files stay behind. When a step after the copy fails, the error names the temporary folder that keeps the copies.

### Close a worktree tab

When you close a worktree tab, a picker opens with the placeholder `Closing worktree tab · <path>`. It shows two items. Keep worktree is the first item, so Enter keeps the worktree:

- Keep worktree: closes the tab and keeps the worktree.
- Tear down: removes the worktree, applies the teardown policy to its branch, then closes the tab. Its dim text says what the teardown policy does with the branch, from `tern-wt config` when the picker opens. When the options file is invalid, it has no dim text. Ignored build, install and tool output goes with the worktree. Ignored files that are hard to rebuild stop the teardown, as uncommitted changes do. A copy goes with the worktree: an ignored file with the same bytes as the file at the same path in the main checkout, for example the `.env` that an omp clone copied. A changed copy stops the teardown.

Escape keeps the tab and the worktree. The picker has no `⌫` or `⌘⌫` keys. To select an item, type to filter the list or use the arrow keys. Then press Enter. When the picker fails to open, a toast shows the error. The tab closes, and the worktree stays.

The plugin's teardown picker calls `remove --keep-tab`, then closes the tab. It does not examine running processes, so the `busy_tabs` refusal does not protect this picker. Check the tab's processes before you select Tear down or Force delete.

While a teardown runs, a `Deleting worktree <branch>…` toast shows. After the teardown, the toast title tells you what the teardown did with the branch: `Deleted worktree and branch`, `Deleted worktree, kept branch: not merged`, or `Deleted worktree, kept branch`. Its second line names the steps that failed, for example `fetch failed`.

When the tab closes before the picker opens, for example from the tab bar, the picker reads `Worktree tab closed · <path>` and offers the same two items. Escape keeps the worktree. This picker gets the focus, so a key press meant for a pane goes to the picker. A typed letter can hide Keep worktree, so check the selected item before you press Enter.

When the teardown fails, for example because of uncommitted changes, a new file that git does not track, or an ignored `.env` file, an error toast gives the cause, `Teardown failed: <cause>`. For a worktree with work to lose, the cause lists the files, at most 10. The ignored files that are hard to rebuild get the first positions in the 10. For the files that it does not show, the cause adds `and <n> more`. A second picker then shows the same `Teardown failed: <cause>` in its placeholder, for example `Teardown failed: 1 file with work to lose: ?? .setup-ran`, and offers:

- Retry: runs the teardown again.
- Force delete: removes the worktree and discards its uncommitted work.

Escape keeps the tab and the worktree.

### Worktree variables

A shell that starts in a worktree in the worktree root, or in a folder of one, gets three environment variables. The worktree can be tern-managed or omp-owned. The variables are:

- `TERN_WT_PATH`: the path of the worktree.
- `TERN_WT_MAIN`: the path of its main checkout.
- `TERN_WT_BRANCH`: its branch. A shell in a worktree with a detached `HEAD` does not get it.

A shell that starts in a folder that is not in the worktree root gets none of them. The values come from the last refresh of the plugin's list of worktrees, `tern-wt list --all`. The refresh runs at these times:

- A Tern window starts.
- A pane moves into a worktree in the root that is not on the list.
- A tab or pane opens in a worktree in the root that is not on the list, for example a tab from `tern-wt create` in a shell. After the refresh, a close of that tab opens the teardown picker when the worktree is tern-managed.
- A shell command ends, or a pane gets focus, in a worktree on the list.

A refresh from a pane or a shell command runs at most one time in 2 seconds. When the plugin makes or tears down a worktree, the list changes immediately. After a branch switch, a new shell gets the new branch after the next refresh. A shell keeps the variables it started with.

### Worktree base port

Each linked branch worktree has an even base port from 4000 through 5998. `create` returns it as `port` and saves it in `branch.<branch>.ternWtPort`. Reuse and relocation keep that value unless a different live branch worktree of the same repository uses it. `list` reports the same numeric `port`, or null for a detached `HEAD`. The main checkout gets `port: null` from `create`.

Run `eval "$(tern-wt env . --shell)"` in a linked branch worktree to export `TERN_WT_PORT`, also when `.tern/worktree.json` is missing. `prepare`, `heavy` and the setup line of a new worktree also supply it. Use `TERN_WT_PORT` and `TERN_WT_PORT + 1` for two development servers. Shared Docker service ports stay as declared in `.tern/worktree.json`.

For a branch without a saved port, the starting value is `4000 + 2 * (SHA256(<main checkout folder name>/<branch>).readUInt32BE(0) % 1000)`. A collision, also for a saved value, with a different live branch worktree of the same repository increases the port by 2, wrapping from 5998 to 4000. Reading an older worktree through `list` or `env` derives its port without writing git settings. Before assigning a port to a new worktree, `create` reserves and saves the derived ports of the other live worktrees that have no saved value. A new branch does not get their ports through alphabetical order.

Run `create` commands for the same repository sequentially. Port allocation has no lock, so concurrent creates can select the same port.

### Worktree segment

When the pane with the focus is in a worktree in the worktree root, or in a folder of one, the Tern status line shows the worktree segment. The worktree can be tern-managed or omp-owned. The segment shows the branch icon and the branch. When the worktree has `n` changed files, the segment adds `· <n>` and shows in the warning color, for example `⎇ feat · 2`. Without changed files, the segment shows the branch alone, in the muted color. A worktree with a detached `HEAD` shows `detached`.

A pane in a folder that is not in the worktree root shows no segment. The count is the number of changed files that `tern-wt list --all` gives. The count includes changes to tracked files, staged or not, new files that git does not track, and submodule changes. Ignored files do not count. The segment changes when the plugin's list of worktrees changes, at the times that [Worktree variables](#worktree-variables) gives.

Click the segment to open the branch picker, as `cmd+shift+w` does.

## Work with omp

When omp is on `PATH` and `TERN_WT_HOME` is not set, `tern-wt` shares omp's default worktree root, usually `~/.omp/wt`. It resolves the root as omp 18.8.6 does: `$OMP_WORKTREE_DIR`, else the omp setting `worktree.base`, else the `wt` folder of the omp data folder. omp removes the spaces at the two ends of each override, a leading `~` becomes the home folder, and a value that is still relative does not count. The omp data folder is `~/.omp`, or `~/$PI_CONFIG_DIR`, with `profiles/<profile>` added for the profile in `OMP_PROFILE` or `PI_PROFILE`. On Linux and macOS, `$XDG_DATA_HOME/omp` replaces it when that folder is on disk (`$XDG_DATA_HOME/omp/profiles/<profile>` for a profile). `tern-wt` reads the omp settings with `omp config list --json` run in `/`, so the config of a project does not move the root.

- A tern-managed worktree is at `<root>/<repo>/<slug>`, two levels below the root, where `<repo>` is the folder name of the main checkout.
- Each other worktree in the root is omp-owned, for example the `<n>-<hash>` folder of a pull request checkout or the folder of a `/wt` session. `list` shows omp-owned worktrees only with `--all`, `branches` marks them with `owner: "omp"`, `create` opens them where they are, and `remove` refuses them with `not_managed`.
- `create` finds an omp-owned worktree by its branch. omp checks out each pull request on the branch `pr-<n>`, so `create --pr <n>` reuses that checkout. For a pull request from the same repository, it does so when no worktree has the head branch and the git config key `branch.pr-<n>.ompPrHeadRef` that omp writes, when set, names that head branch.

When omp is on disk but `omp config list --json` fails in `/`, the worktree root is unknown, so `create`, `remove`, `list` and `branches` fail with `omp_failed` rather than use a different root. `tern-wt` uses `~/.tern-wt/worktrees` only when no omp binary is on disk.

Clone mode applies when omp is installed, also when `TERN_WT_HOME` is set: when the omp setting `worktree.clone` is true in the repository, project config included, `create` makes each new worktree with `omp worktree add`. A rebuilt relocation uses plain git. The new worktree starts as a copy-on-write clone of the main checkout, with its ignored files, for example `.env` and `node_modules`. The clone also copies the `.git` file of each submodule, and that file then points to no git folder. `create` deletes each of these files, copies the submodule git folders of the main checkout into the git folder of the new worktree, and runs `git submodule update`. Thus git works in each submodule, each submodule is at the commit that the branch records, and the files of the clone stay. A new branch gets the same upstream as with plain `git worktree add -b`. When the clone falls back to a plain checkout, the omp message shows in `warnings`. When `omp config list --json` fails in the repository, `create` uses plain git and adds a warning. omp 18.8.6 moves an invalid `.omp/config.yml` aside to `.omp/config.yml.broken-<id>` when it reads it, so that probe can change the repository.

Before the last `git submodule update --init --recursive`, `create` initializes each top-level submodule from the main checkout when the target has no `.git` and the local objects contain the recorded commit. A submodule with `update=none` stays uninitialized, with no clone or repack. Submodule git folders copied by omp keep their custom `origin` and copy-on-write objects, with no repack. The main checkout's objects and `objects/info/alternates` stay unchanged.

For a non-shallow source, local initialization uses a temporary local URL with `--reference`. Only an actual clone with its own `.git` and `objects/info/alternates` copies the referenced objects into its object store and removes that reference. For a shallow source, it clones through a local `file://` URL with `--depth 1` and no reference or `objects/info/alternates`, fetching the recorded commit directly from that local source if it is not in the cloned tip. Only an actual clone gets its `origin` restored to the original URL. The same reuse applies to plain git worktrees and a rebuilt relocation.

If the local commit is missing, reuse is skipped without a warning. A failed local clone adds `local submodule reuse failed for <path>: <error>` before the normal recursive update, which can fetch from the original remote. A failure to copy the referenced objects or remove their reference adds `local submodule reuse failed for <path>: <error>; reference to main checkout objects remains`. That submodule still depends on the main checkout's object store. A `submodule repair failed:` warning stays first. A `submodule update failed:` warning follows if the recursive update fails. The worktree stays available.

`omp worktree clear` deletes each worktree in the root that omp sees as orphaned, also without `--all`. omp can see a live tern-managed worktree as orphaned, for example when git has `worktree.useRelativePaths=true` or when you moved the main checkout. Run `omp worktree clear --dry-run` first, and check its list.

## Options file

The options file is `config.json` in the first of these folders:

1. `$TERN_PLUGIN_DATA`, when you set it.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when you set `TERN_CONFIG_DIR`.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

Each key in the file replaces its default:

| Key                        | Default                                  | Value                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teardown`                 | `"worktree+merged-branch"`               | The teardown policy. `"worktree"` keeps the branch. `"worktree+merged-branch"` deletes the branch when it is merged. `"worktree+branch"` deletes the branch.                                           |
| `cloneRoot`                | `"~/Developer"`                          | The clone root, an absolute path or a path that starts with `~`. `tern-wt` clones a GitHub repository to `<cloneRoot>/<owner>/<name>`.                                                                 |
| `hotkeys.new`              | `["cmd+shift+w"]`                        | The Tern key chords that open the branch picker. A change applies after `tern plugin reload`.                                                                                                          |
| `setup`                    | `{}`                                     | The setup commands of each repository: its name with owner maps to a list of shell commands without line breaks. Uppercase and lowercase letters in the name are the same. An empty list runs nothing. |
| `issueBranch.fixLabels`    | `["bug", "fix", "regression", "hotfix"]` | Labels that select the `fix/` prefix for issue branches, ignoring uppercase and lowercase letters. An empty list uses only the issue type `Bug` to select `fix/`.                                      |
| `issueBranch.linkOnGitHub` | `false`                                  | Set to `true` to create a remote branch linked to the issue with `gh issue develop`. The default records only the local `ternIssue` setting.                                                           |

A branch is merged when it is an ancestor of `origin/<default>`, or when its tip is the head commit of a merged pull request or an ancestor of that commit.

For a new worktree only, `tern-wt` starts the declared services before opening the tab, then types the setup line into its shell. Repository setup commands from `.tern/worktree.json` run before user setup commands, with `&&` between them. The line starts with `eval "$(tern-wt env . --shell)"` to activate `TERN_WT_PORT` and the declared environment variables, even without setup commands. The name with owner for user setup comes from the GitHub URL of `origin`. Repository setup and environment variables also work without a GitHub origin. `tern-wt` waits a maximum of 30 s for the shell prompt before typing the line. When the tab was open before, no tab opens, the tab holds no new shell or no prompt shows, the line does not run. A toast or a `create` warning shows why. `--no-tab` starts no services and opens no tab. It returns the line for the caller to run.

```json
{
  "teardown": "worktree",
  "cloneRoot": "~/src",
  "hotkeys": { "new": ["cmd+shift+w", "ctrl+b>w"] },
  "setup": { "virtusize/aoyama": ["npm ci", "npm run build"] }
}
```

An invalid file, an unknown key or an incorrect value makes each `tern-wt` command fail with `config_invalid`.

### Bind `cmd+shift+w` in Tern settings

A Tern key preset or a different plugin can bind the chord first. When `cmd+shift+w` opens no picker, add the binding to the Tern `settings.json`:

```json
{
  "keybinds": { "cmd+shift+w": "plugin.tern-worktrees.new" }
}
```

## Prepare a repository environment

Commit `.tern/worktree.json` at the checkout root to share setup commands, Docker services, environment variables and the memory allowance for heavy commands:

```json
{
  "setup": ["npm ci"],
  "services": {
    "postgres": {
      "image": "postgres:17",
      "port": 5432,
      "containerPort": 5432,
      "env": { "POSTGRES_PASSWORD": "development" },
      "tmpfs": "/var/lib/postgresql/data",
      "memory": "1g",
      "ready": ["pg_isready", "-U", "postgres"]
    }
  },
  "env": { "DATABASE_URL": "postgres://postgres:development@localhost:5432/postgres", "BUILD_CACHE": "~/.cache/build" },
  "heavy": { "slotMemoryGb": 7 }
}
```

Each top-level key is optional. `setup` is an ordered array of shell commands without line breaks. `services` maps names to Docker declarations. Each service must have `image`, host `port` and `containerPort`. Optional fields are `env` (a string map), `args` (an array of arguments after the image), `tmpfs` and `memory` (strings passed to Docker), and `ready` (a command array run with `docker exec`). Services need a GitHub origin. All worktrees of that repository share the lowercase container name `tern-wt-<owner>-<repo>-<name>` and label `tern-wt.service=<owner>/<repo>/<name>`. Running containers are reused unchanged. Stopped containers are removed and started again from the declaration. A readiness command must succeed in 60 s.

Top-level `env` values are literal strings. Only a leading `~/` expands to the home directory. `$VAR` and shell substitutions stay literal. These values apply to setup commands, heavy commands and the setup line of new worktree tabs. `TERN_WT_PORT` is reserved: declaring it in top-level `env` gives `worktree_config_invalid`. In a linked branch worktree, `env` adds the base port as a string, for example `{"env":{"TERN_WT_PORT":"4280"}}` with no repository variables. The main checkout and detached worktrees get no generated `TERN_WT_PORT`. Service `env` values stay literal, also with `~/`. Missing settings default to empty setup, services and declared environment variables, and `heavy.slotMemoryGb: 7`. An invalid repository file gives `worktree_config_invalid`, naming the file and key in its message.

```sh
tern-wt prepare .                 # Start services, then run repository and user setup
tern-wt prepare . --no-setup      # Start services without running setup commands
tern-wt env .                    # Print {"env": {...}}
eval "$(tern-wt env . --shell)"   # Apply POSIX-quoted exports to this shell
tern-wt heavy -- npm run build   # Run with a host-wide heavy slot
tern-wt heavy --status           # Inspect slots and host memory
```

These commands also accept a main checkout with an external Git directory, for example one made with `git init --separate-git-dir`. Linked worktrees of that layout and bare repositories give `not_a_repo`.

`prepare <path>` runs setup sequentially in the checkout root, repository commands first and user commands second. It waits for setup to complete and returns `{"path", "repo", "services": [{"name", "container", "status"}], "setup": [{"command", "exitCode", "ms"}], "env", "warnings"}`. A service status is `started` or `running`. A failed setup command stops the sequence with `setup_failed`, its `command`, `exitCode` and the last 40 lines in `output`. `--no-setup` returns an empty `setup` array. Unlike `create`, `prepare` needs no Tern tab.

`heavy [--repo <dir>] -- <command> [args...]` starts or reuses services and applies the repository environment, then runs the command in the current directory, even with `--repo`. It passes through standard output, standard error and the command's exit code, without a JSON result. Slots are shared across the host: `max(1, floor(total RAM in GiB / heavy.slotMemoryGb))`, with locks at `<plugin-data>/heavy/slot-<n>.lock`. Locks with dead process IDs are removed. When all slots are busy, it writes one waiting message to standard error and retries at 5 s intervals. The lock is released when the command ends or receives a signal. `heavy --status` returns `{"slots": [{"slot", "busy", "pid", "cwd", "command", "startedAt"}], "memAvailableGb", "memTotalGb"}`. Idle slots have null ownership fields. Memory values use GiB.

## The `tern-wt` CLI and the agent skill

[`skills/tern-worktrees/SKILL.md`](skills/tern-worktrees/SKILL.md) is the reference for each command: its arguments, its output fields, the next step for each error code, and the rules agents follow for teardown. The commands:

- `create`: makes or reuses the tern-managed worktree of a branch, an issue or a pull request, or reuses its omp-owned worktree or the main checkout, and opens its tab. Its `owner` field is `tern`, `omp` or `main`. Its `port` is the worktree base port, or null for the main checkout. For a new worktree, it starts or reuses services before opening the tab and types `setup.line`, which activates the environment and runs repository setup before user setup. `--no-tab` skips services and the tab but returns the line with `setup.typed: false`.
- `prepare`: starts or reuses services and runs setup commands in the checkout root, without a Tern tab. `--no-setup` starts or reuses only services.
- `env`: prints the repository environment, with `TERN_WT_PORT` for a linked branch worktree, as JSON or POSIX-quoted exports with `--shell`.
- `heavy`: runs a command with the repository environment and services in a host-wide slot, or reports slots and memory with `--status`.
- `remove`: tears down a tern-managed worktree as the teardown policy says, and closes its tabs. Before removal it checks the target blocks for running processes. See the refusal and overrides below.
- `finish`: saves a delivery teardown plan, records an explicit selection and reports its result. The omp integration asks through the built-in `ask` tool before arming it. See [Finish a delivery](#finish-a-delivery).
- `clean --repo <dir> [--apply]`: plans repository-scoped removals without writing. Applies a new plan only with `--apply`. See [Plan repository cleanup](#plan-repository-cleanup) for approval, output and safety rules.
- `list`: lists the tern-managed worktrees, each with its `owner`, base `port` (null for a detached `HEAD`) and number of `changed` files. `--all` adds the omp-owned worktrees. When git cannot count the changes of a worktree, for example because a submodule has a broken `.git` file, `list` still shows that worktree and adds a warning.
- `branches`: lists the branches, the open pull requests and the worktrees of a repository, with the owner of each worktree and `main` true for the main checkout. `--offline` reads only local refs, with no fetch and no pull requests.
- `resolve`: gives the repository root, name, owner and GitHub origin of each directory. Each `repos[]` entry has `origin` as `<owner>/<repo>` in lowercase, or null when `origin` is not a GitHub URL or the directory is not in a repository.
- `issue-ref -- <text>`: parses one issue or pull request URL or short issue reference without git or network access. The `--` separator lets text start with `-`. Its `ref` is null for text that is not a reference, otherwise `{"repo", "number", "kind"}`. `repo` is `<owner>/<repo>` in lowercase or null for a short reference, `number` is a string, and `kind` is `issue` or `pr`. Pass exactly one text argument, otherwise the command gives `bad_args`. The plugin uses this command for prompt and clipboard text.
- `repos`: lists the GitHub repositories of your user and organizations.
- `clone`: clones a GitHub repository to the clone root.
- `new-repo`: makes a GitHub repository, then clones it.
- `config`: prints the options file with each default filled in.
- `setup`: links `~/.local/bin/tern-wt`, the skill and the bundled omp extension to the package that it runs from. The plugin runs it each time it loads in a Tern window.

Commands print one JSON object. Two commands use a different output: `env --shell` prints shell exports, and heavy command execution passes through the child process streams and exit code. CLI failures exit 1 with one of these error codes: `bad_args`, `config_invalid`, `worktree_config_invalid`, `setup_failed`, `service_failed`, `docker_missing`, `not_a_repo`, `not_cloned`, `not_managed`, `path_conflict`, `worktree_exists_elsewhere`, `dirty_worktree`, `busy_tabs`, `git_failed`, `gh_failed`, `omp_failed`, `tern_failed`. `service_failed` names the service and the failure in its message. `docker_missing` means the Docker executable is unavailable. See the skill for recovery steps.

The plugin also gives Carly the exports `create`, `list` and `remove`, which run the CLI commands of the same names. For a new worktree with setup commands, the `create` export replies when the plugin typed them into the tab or gave up, at most 30 s after the tab opened, so `setup.typed` and `warnings` mean what they mean in the CLI output.

The Carly `create` export has the signature `(repo: string, branch: string?, new: boolean?, issue: string?)`. Pass the repository directory first and the issue URL fourth, with an optional branch override second. For issue work, keep `new` unset. The issue flow creates or reuses the branch.

### Remove a worktree safely

`tern-wt remove <path> [--force] [--close-busy-tabs] [--keep-tab]`

By default, `remove` refuses busy blocks with `busy_tabs` before removal. `--close-busy-tabs` skips the process check with approval to close busy blocks, `--force` only discards work to lose, and `--keep-tab` skips all Tern inspection and keeps tabs open. Read the [remove rules](skills/tern-worktrees/SKILL.md#remove) for the idle-process rule, `error.blocks`, inspection failures and the limits of this snapshot check.

The Carly `remove(path, force?, closeBusyTabs?)` export uses the process check by default. Set the third argument, `closeBusyTabs`, to `true` only with approval to close busy blocks. It passes `--close-busy-tabs` and skips process inspection. The second argument, `force`, passes `--force` and only discards work to lose.

### Finish a delivery

At the real end of a delivery, the omp integration offers three alternatives through omp 18.18.3's built-in `ask` HTML form:

- Remove only the managed worktrees of this session or run.
- Also remove other managed worktrees of this repository that have merged pull requests.
- Keep all worktrees and this tab, the recommended selection.

The form shows three alternatives: `Supprimer seulement mes worktrees`, `Supprimer aussi les autres PR fusionnées du dépôt` and `Ne rien supprimer`. `Ne rien supprimer` is selected by default. Only a valid answer to the saved form can approve teardown. An error, cancellation, timeout, text entered through Other or a mismatched answer keeps all worktrees and the tab. An unavailable built-in `ask` or an older API that rejects the HTML form also keeps everything. The extension does not retry through the former `questions` API.

The preview names the canonical paths, pull requests and commits. Approval applies only to that saved list. A symbolic alias cannot add a hidden target, and a subsequent scope change cannot expand the approved selection. Changed or busy worktrees, blocked orchestration lanes and targets without proof of safety stay, with a cause. A closed issue or a closed pull request without a merge is not merge proof. The main checkout stays. Local branches follow the teardown policy. Remote branches stay.

After approval, the agent writes its last delivery report. An external worker waits for the caller to exit before removing its worktree and closing its tab. The omp history stays. Tern reports removed targets, kept targets and errors without using the removed tab. Without built-in `ask`, clear readiness or successful worker startup, the worktrees and tab stay.

Finish's `keep` and `errors` entries contain `path`, a stable `code` for automation, and optional `detail` from an external exception for inspection. Match `code`, not `detail` or the label in Tern. Tern translates the codes into readable labels and reports the counts of removed worktrees, kept worktrees and errors. Use `tern-wt finish status <id>` for the full result. Saved finish state uses version `2`. Older state that is not compatible is rejected without teardown or conversion. Create a new plan and approve its preview.

Orchestration asks once, through the coordinator after all requested deliveries and jobs complete. Workers do not ask after each ticket. A composed delivery with more work explicitly scheduled waits until its last requested delivery.

For standalone sessions without a declared scope, automatic detection looks for a new merge after tool use. It waits for jobs and messages to settle and tries once for each delivery episode. Missing ask, unavailable CI proof or a CLI error does not start a continuation loop. Use an explicit `ready` to examine readiness again. A turn ending alone does not prove that a multi-delivery task is complete. Declare a composed scope before its first delivery. Signal `ready` only after the last delivery.

Unlike `clean`, `finish` does not prune Docker resources, discard work to lose or use closed issues to authorize teardown. Manual tab closure keeps its picker.

See the [finish command contract](skills/tern-worktrees/SKILL.md#finish) for saved plans, state inspection and fallbacks when tools are unavailable.

### Plan repository cleanup

Start with a dry run:

```sh
tern-wt clean --repo /path/to/repo
```

The dry run writes nothing and does not fetch or prune refs. Read `remove`, `keep` and `warnings` before you select an action. Agents must show this plan and wait for an explicit yes from the user before applying it:

```sh
tern-wt clean --repo /path/to/repo --apply
```

`--apply` fetches and prunes `origin`, then builds a new plan. It does not replay the preview, so the plan can change as remote refs and live resources change.

The JSON result is `{"repo", "default", "remove": {"worktrees": [], "branches": [], "processes": [], "containers": [], "paths": []}, "keep": [{"kind", "id", "reason"}], "warnings": []}`. `repo` is the main checkout and `default` is the default branch. The removal arrays contain strings. Only `processes` has objects, with the form `{"pid": number, "cwd": string, "command": string}`. `--apply` adds `"applied": true`. Read kept resources and warnings even when no removal is planned.

Closed linked issues and closed or merged pull requests can also authorize removal without proof of integration. `clean` recognizes branch names `<prefix>/<number>-<slug>`, `<prefix>/<number>` and `pr-<number>`, `branch.<branch>.ternIssue` references, and worktree folder names starting with `<number>-`. It resolves those numbers together with merged pull requests in one batched GitHub operation. Open or unknown references do not authorize this exception. Live-process, caller, locked-worktree and inspection protections still win.

`removalDetails` adds `{"kind", "id", "reason", "recovery": true}` entries alongside the unchanged removal arrays for linked removals and integrated branches with commits missing from remote branches. Each entry needs recovery before removal. Before applying each detailed removal, `clean` saves recovery files in `${XDG_STATE_HOME:-~/.local/state}/tern-wt/recovery/<timestamp>/<slug>/`: a binary patch against `HEAD`, a tar archive of non-ignored files not tracked by Git, a manifest with the branch and tip SHA, and a Git bundle when commits are missing from all remote branches. Initialized submodules get their own recovery files. A recovery failure keeps the target. An ignored hard-to-rebuild file still blocks removal. Successful recovery adds `recoveryPath` to the detail entry. The dry run creates no recovery files.

The main checkout, the caller's worktree, a worktree that is the caller's working directory or an ancestor of it, and live omp sessions stay. A live busy Tern block stays with its worktree. Work to lose and work on branches without proof of integration stay unless the closed-link exception above authorizes removal with recovery. Hard-to-rebuild files use the same protection as teardown. A copy with the same bytes in the main checkout does not block removal. When inspection cannot prove safety, the related resource stays.

For `clean`, a branch is integrated when its tip is an ancestor of `origin/<default>` or one merged pull request's head commit. It also counts as integrated when `git merge-tree` shows that merging it into `origin/<default>` keeps that tree unchanged. `clean` reads merged pull requests and linked issue states in one batched GitHub operation. It batches branch tips and ancestry proofs, bounds concurrent branch and worktree inspections, and runs `merge-tree` only for branches not proven integrated. Without the closed-link exception, removing commits missing from remote branches needs proof of integration.

Process-related keep causes identify the PID and command, or state that inspection is unavailable. Linux reads `/proc`. macOS reads process working directories with one `lsof` snapshot and parent relationships with `ps`. When process inspection is not full, the process keeps only a worktree that contains its known working directory. An unrelated process does not keep all worktrees. When inspection is unavailable, for example when `lsof` is missing or fails on macOS, worktrees stay with an explicit cause. Branch cleanup can still continue. When Tern inspection is unavailable, all worktrees stay with an explicit cause.

Process removal is limited to attributable repository processes on Linux and macOS: processes in worktrees selected for removal, or proven orphans. The caller, its ancestors, live omp sessions and their descendants, and system services stay. A live busy Tern block is not a removal target: its worktree stays, and `clean` does not stop that block. Docker removal needs evidence tying a container exclusively to worktrees in the removal plan. `Testcontainers` containers also need an `org.testcontainers.sessionId` label, no other container with the same session label, and no live working directory below their source paths. Shared `tern-wt` services, unattributable containers, anonymous volumes and the rootless Docker daemon stay. `paths` contains only empty directories left at paths of Git worktree entries identified `prunable`. Their identity is examined again before removal. This command does not sweep temporary folders, staging copies, Docker images or volumes.

## Design and glossary

[`docs/`](docs/README.md) holds the design and the glossary. CI publishes it to the [wiki](https://github.com/riicodespretty/tern-worktrees/wiki).

See [Development](docs/README.md#development) for the checks. Mutation testing is optional and does not block delivery.

## License

MIT, in [`LICENSE`](LICENSE).
