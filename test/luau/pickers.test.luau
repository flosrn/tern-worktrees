--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local REPO = "/r/app"
local ISSUE_REF = '{"ref":{"repo":"acme/app","number":"42","kind":"issue"}}'
local PR_REF = '{"ref":{"repo":"acme/app","number":"7","kind":"pr"}}'

-- The `branches` answer of the CLI for REPO with a worktree of x and the pull request 7.
local BRANCHES = Stub.fixture("branches", Stub.worktree_vars("x"))
-- A `branches` answer with the main checkout and a worktree of y that is not in the worktree root.
local OUTSIDE_ROOT = Stub.answer("branches-offline", { repo = REPO }, function(answer: any)
	answer.branches = { "main", "y" }
	table.insert(answer.worktrees, { branch = "y", path = "/elsewhere/y", managed = false, main = false })
end)

local function same(actual: { [string]: any }, expected: { [string]: any }, what: string)
	for key, value in expected do
		eq(actual[key], value, what .. "." .. key)
	end
	for key, value in actual do
		eq(expected[key], value, what .. "." .. key)
	end
end

-- Opens the branch picker of REPO from a pane in it, answers `branches` with `answer` (default BRANCHES), and
-- returns the harness and the cx.
local function open_branch_picker(answer: string?): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO } }, 1)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin:open_branch_picker(cx, answer or BRANCHES)
	return plugin, cx
end

-- Opens the repo picker from a window with no pane in a repository.
local function open_repo_picker(): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1 } }, 1)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin.commands.new.run(cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(cx.asked[1].kind, "pick", "request kind")
	return plugin, cx
end

local function choose_new_branch(): (Stub.Harness, any)
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(Stub.item(picker, "new"), nil, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].kind, "prompt", "request kind")
	return plugin, cx
end

test("the hotkey opens the focused pane's repository instead of the session's first repository", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/first" }, { pane = 2, tab = 2, cwd = REPO } }, 2)
	local plugin = Stub.load({ env = Stub.ENV })
	local resolved =
		'{"repos":[{"dir":"/r/first","root":"/r/first","name":"first"},{"dir":"/r/app","root":"/r/app","name":"app"}]}'
	plugin:press(cx, resolved)
	eq(plugin:pending("branches")[1], Stub.argv("branches", { repo = REPO }), "focused repository branches")
	plugin:answer("branches", BRANCHES, 0, cx)
	local picker = cx.asked[1]
	picker.next(Stub.item(picker, "new"), nil, cx)
	eq(cx.asked[2].opts.placeholder, "New branch from main in app", "new branch repository and default")
	cx.asked[2].next("focused-branch", nil, cx)
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	eq(
		plugin:pending("create")[1],
		Stub.argv("create-branch-new", { repo = REPO, branch = "focused-branch" }),
		"create repository"
	)
end)

test("a focused pane outside a repository falls back to the session's first repository", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO }, { pane = 2, tab = 2, cwd = "/outside" } }, 2)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin:press(cx, '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"},{"dir":"/outside","root":null}]}')
	eq(plugin:pending("branches")[1], Stub.argv("branches", { repo = REPO }), "session repository branches")
end)

test("a session with no repository opens the repo picker", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/outside" } }, 1)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin:press(cx, '{"repos":[{"dir":"/outside","root":null}]}')
	eq(#plugin:pending("branches"), 0, "branch calls")
	eq(cx.asked[1].opts.placeholder, "Search repositories", "repo picker")
end)

test("the branch picker lists New branch, From issue, Other repo, pull requests, then branches", function()
	local _, cx = open_branch_picker()
	local opts = cx.asked[1].opts
	eq(opts.placeholder, "Search branches in app", "placeholder")
	eq(opts.icon, "branch", "icon")
	eq(opts.action, "open", "action")
	eq(#opts.items, 6, "items")
	same(opts.items[1], { id = "new", label = "New branch…", detail = "from main", icon = "plus" }, "items[1]")
	same(opts.items[2], { id = "from-issue", label = "From issue…", icon = "branch" }, "items[2]")
	same(opts.items[3], { id = "other", label = "Other repo…", icon = "folder" }, "items[3]")
	same(
		opts.items[4],
		{ id = "pr:7", label = "#7 Fix login · fix-login", group = "Pull requests", icon = "merge" },
		"items[4]"
	)
	same(
		opts.items[5],
		{ id = "b:x", label = "x", detail = "worktree", group = "Branches", icon = "branch" },
		"items[5]"
	)
	same(opts.items[6], { id = "b:main", label = "main", group = "Branches", icon = "branch" }, "items[6]")
end)

test(
	"the branch picker shows no worktree text for the main checkout, and shows it for a worktree not in the worktree root",
	function()
		local _, cx = open_branch_picker(OUTSIDE_ROOT)
		local picker = cx.asked[1]
		eq(Stub.item(picker, "b:main").detail, nil, "detail of b:main")
		eq(Stub.item(picker, "b:y").detail, "worktree", "detail of b:y")
	end
)

test("choosing a branch creates its worktree with --branch=<name>", function()
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(Stub.item(picker, "b:x"), nil, cx)
	local creates = plugin:pending("create")
	eq(#creates, 1, "create calls")
	eq(creates[1], Stub.argv("create-branch", { repo = REPO, branch = "x" }), "create argv")
end)

test("choosing a pull request creates its worktree with --pr", function()
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(Stub.item(picker, "pr:7"), nil, cx)
	eq(plugin:pending("create")[1], Stub.argv("create-pr", { repo = REPO, pr = "7" }), "create argv")
end)

test("dismissing the branch picker runs nothing", function()
	local plugin, cx = open_branch_picker()
	cx.asked[1].next(nil, nil, cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.asked, 1, "pickers and prompts opened")
end)

test("Other repo opens the repo picker", function()
	local _, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(Stub.item(picker, "other"), nil, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].opts.placeholder, "Search repositories", "placeholder")
end)

test("a picker error shows a toast and runs nothing", function()
	local plugin, cx = open_branch_picker()
	cx.asked[1].next(nil, "picker gone", cx)
	eq(#plugin.runs, 0, "CLI calls")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "Picker failed", "toast title")
	eq(last.detail, "picker gone", "toast detail")
end)

test("a prompt error shows a toast and runs no create", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next(nil, "prompt gone", cx)
	eq(#plugin:pending("create"), 0, "create calls")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "Prompt failed", "toast title")
	eq(last.detail, "prompt gone", "toast detail")
end)

test("a picker callback with a nil cx returns at once", function()
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	local toastsBefore = #cx.toasts
	picker.next(Stub.item(picker, "b:x"), nil, nil)
	picker.next(nil, "picker gone", nil)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.toasts, toastsBefore, "toasts")
end)

test("New branch prompts for the name of a branch from the default branch", function()
	local _, cx = choose_new_branch()
	same(
		cx.asked[2].opts,
		{ placeholder = "New branch from main in app", icon = "branch", action = "create" },
		"prompt options"
	)
end)

test("New branch creates the typed branch as one --branch=<name> argument", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("-bad", nil, cx)
	eq(plugin:pending_line("issue-ref"), Stub.argv("issue-ref", { text = "-bad" }), "option-like branch parser argv")
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	local creates = plugin:pending("create")
	eq(#creates, 1, "create calls")
	eq(creates[1], Stub.argv("create-branch-new", { repo = REPO, branch = "-bad" }), "create argv")
end)

local function last_title(cx: any): string
	return cx.toasts[#cx.toasts].title
end

test(
	"a create names the branch in a reusing or creating toast while it runs, and the main checkout in an opening one",
	function()
		local _, cx = open_branch_picker()
		cx.asked[1].next(Stub.item(cx.asked[1], "b:x"), nil, cx)
		eq(last_title(cx), "Reusing worktree x…", "branch with a worktree")
		local _, cx2 = open_branch_picker()
		cx2.asked[1].next(Stub.item(cx2.asked[1], "b:main"), nil, cx2)
		eq(last_title(cx2), "Opening main checkout…", "branch of the main checkout")
		local _, cx3 = open_branch_picker()
		cx3.asked[1].next(Stub.item(cx3.asked[1], "pr:7"), nil, cx3)
		eq(last_title(cx3), "Creating worktree fix-login…", "pull request")
		local plugin4, cx4 = choose_new_branch()
		cx4.asked[2].next("feat/y", nil, cx4)
		plugin4:answer("issue-ref", '{"ref":null}', 0, cx4)
		eq(last_title(cx4), "Creating worktree feat/y…", "new branch")
	end
)

test("New branch shows the CLI's bad_args reason and prompts again with the name", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("bad..name", nil, cx)
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	plugin:answer("create", '{"error":{"code":"bad_args","message":"invalid branch name: bad..name"}}', 1, cx)
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "invalid branch name: bad..name", "toast title")
	eq(#cx.asked, 3, "pickers and prompts opened")
	eq(cx.asked[3].kind, "prompt", "request kind")
	eq(cx.asked[3].opts.value, "bad..name", "prefilled name")
	eq(cx.asked[3].opts.placeholder, "New branch from main in app", "placeholder")
end)

test("New branch shows another CLI error and prompts no more", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("feat", nil, cx)
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	plugin:answer("create", '{"error":{"code":"git_failed","message":"fetch failed"}}', 1, cx)
	eq(cx.toasts[#cx.toasts].title, "fetch failed", "toast title")
	eq(#cx.asked, 2, "pickers and prompts opened")
end)

test("New branch runs no create when the prompt is dismissed or empty", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next(nil, nil, cx)
	cx.asked[2].next("", nil, cx)
	cx.asked[2].next("feat", nil, nil)
	eq(#plugin:pending("create"), 0, "create calls")
	eq(#cx.asked, 2, "pickers and prompts opened")
end)

test("the repo picker groups open sessions and GitHub", function()
	local _, cx = open_repo_picker()
	local opts = cx.asked[1].opts
	eq(opts.placeholder, "Search repositories", "placeholder")
	eq(opts.icon, "folder", "icon")
	eq(opts.action, "open", "action")
	eq(Stub.item(cx.asked[1], "github").group, "GitHub", "github group")
	eq(Stub.item(cx.asked[1], "newrepo").group, "GitHub", "newrepo group")
end)

test("GitHub repositories open a clone picker grouped by owner", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "github"), nil, cx)
	eq(plugin:pending_line("repos"), Stub.argv("repos", {}), "repos argv")
	plugin:answer("repos", Stub.fixture("repos", {}), 0, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	local opts = cx.asked[2].opts
	eq(opts.placeholder, "Search GitHub repositories", "placeholder")
	eq(opts.icon, "globe", "icon")
	eq(opts.action, "clone", "action")
	same(
		opts.items[1],
		{ id = "gh:me/aoyama", label = "me/aoyama", detail = "Main app", group = "me", icon = "globe" },
		"items[1]"
	)
	cx.asked[2].next(opts.items[1], nil, cx)
	eq(plugin:pending("clone")[1], Stub.argv("clone", { nameWithOwner = "me/aoyama" }), "clone argv")
end)

test("an empty GitHub repository list opens no picker", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "github"), nil, cx)
	plugin:answer("repos", Stub.answer("repos", {}, { repos = {} }), 0, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "info", "toast level")
	eq(last.title, "No GitHub repositories", "toast title")
end)

test("an empty owner list opens no picker", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", Stub.answer("repos", {}, { owners = {}, repos = {} }), 0, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(#cx.toasts, 1, "toasts")
end)

test("owner, name and visibility create the repository", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", Stub.answer("repos", {}, { repos = {} }), 0, cx)

	local owner = cx.asked[2]
	same(
		owner.opts,
		{ placeholder = "Search owners", icon = "user", action = "choose", items = owner.opts.items },
		"owner"
	)
	owner.next(Stub.item(owner, "me"), nil, cx)

	local name = cx.asked[3]
	eq(name.kind, "prompt", "name request kind")
	same(
		name.opts,
		{ placeholder = "Name of the new repository under me", icon = "folder-plus", action = "continue" },
		"name"
	)
	name.next("n", nil, cx)

	local visibility = cx.asked[4]
	eq(visibility.opts.placeholder, "Visibility of me/n", "visibility placeholder")
	eq(visibility.opts.action, "create", "visibility action")
	same(visibility.opts.items[1], { id = "private", label = "Private", icon = "lock" }, "items[1]")
	same(visibility.opts.items[2], { id = "public", label = "Public", icon = "globe" }, "items[2]")
	visibility.next(Stub.item(visibility, "private"), nil, cx)

	eq(
		plugin:pending("new-repo")[1],
		Stub.argv("new-repo", { nameWithOwner = "me/n", visibility = "private" }),
		"new-repo argv"
	)
end)

test("an empty repository name ends the flow", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", Stub.answer("repos", {}, { repos = {} }), 0, cx)
	cx.asked[2].next(Stub.item(cx.asked[2], "me"), nil, cx)
	cx.asked[3].next("", nil, cx)
	cx.asked[3].next(nil, nil, cx)
	eq(#cx.asked, 3, "pickers and prompts opened")
end)

test("dismissing or failing the GitHub repository picker clones nothing", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "github"), nil, cx)
	plugin:answer("repos", Stub.fixture("repos", {}), 0, cx)
	cx.asked[2].next(nil, nil, cx)
	cx.asked[2].next(nil, "gone", cx)
	cx.asked[2].next(Stub.item(cx.asked[2], "gh:me/aoyama"), "gone", cx)
	eq(#plugin:pending("clone"), 0, "clone calls")
end)

test("dismissing or failing the visibility picker makes no repository", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", Stub.answer("repos", {}, { repos = {} }), 0, cx)
	cx.asked[2].next(Stub.item(cx.asked[2], "me"), nil, cx)
	cx.asked[3].next("n", nil, cx)
	cx.asked[4].next(nil, nil, cx)
	cx.asked[4].next(nil, "gone", cx)
	cx.asked[4].next(Stub.item(cx.asked[4], "private"), "gone", cx)
	eq(#plugin:pending("new-repo"), 0, "new-repo calls")
end)

test("dismissing or failing the repo picker runs nothing", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(nil, nil, cx)
	cx.asked[1].next(nil, "gone", cx)
	cx.asked[1].next(Stub.item(cx.asked[1], "github"), "gone", cx)
	cx.asked[1].next(Stub.item(cx.asked[1], "newrepo"), "gone", cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.asked, 1, "pickers and prompts opened")
end)

test("a bad_args error of a chosen branch shows a toast and prompts nothing", function()
	local plugin, cx = open_branch_picker()
	cx.asked[1].next(Stub.item(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", '{"error":{"code":"bad_args","message":"bad branch name x"}}', 1, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "bad branch name x", "toast title")
end)

local ISSUE = "https://github.com/acme/app/issues/42"
local SUGGESTION =
	'{"branch":"fix/42-login","repo":"/r/app","issue":{"number":42,"url":"https://github.com/acme/app/issues/42","title":"Login"},"warnings":[]}'

local function paste_issue(clipboard: string, status: number?): (Stub.Harness, any)
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(Stub.item(picker, "from-issue"), nil, cx)
	eq(plugin.runs[1].argv[1], "pbpaste", "clipboard process")
	local paste = table.remove(plugin.runs, 1)
	assert(paste ~= nil, "clipboard read pending")
	paste:respond(clipboard, status or 0, cx)
	return plugin, cx
end

local function choose_issue(clipboard: string, status: number?, parsed: string?): (Stub.Harness, any)
	local plugin, cx = paste_issue(clipboard, status)
	plugin:answer(
		"issue-ref",
		parsed
			or (
				if (clipboard == ISSUE or clipboard == ISSUE .. "\n") and (status or 0) == 0
					then ISSUE_REF
					else '{"ref":null}'
			),
		0,
		cx
	)
	return plugin, cx
end

test("From issue prefills only an issue URL from the clipboard", function()
	local _, cx = choose_issue(ISSUE .. "\n")
	eq(cx.asked[2].opts.value, ISSUE, "issue prefill")
	local _, other = choose_issue("private clipboard text")
	eq(other.asked[2].opts.value, nil, "unrelated clipboard is not exposed")
	local _, failed = choose_issue(ISSUE, 1)
	eq(failed.asked[2].opts.value, nil, "failed clipboard read")
end)

for _, clipboard in { "- item", "--secret" } do
	test("From issue safely parses option-like clipboard text " .. clipboard, function()
		local plugin, cx = paste_issue(clipboard)
		eq(plugin:pending_line("issue-ref"), Stub.argv("issue-ref", { text = clipboard }), "clipboard parser argv")
		plugin:answer("issue-ref", '{"ref":null}', 0, cx)
		eq(cx.asked[2].opts.value, nil, "unrelated clipboard is not exposed")
	end)
end

test("From issue suggests then creates the edited branch while retaining issue metadata", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-suggest", { issue = ISSUE, repo = REPO }), "suggest argv")
	plugin:answer("create", SUGGESTION, 0, cx)
	eq(cx.asked[3].opts.value, "fix/42-login", "derived branch")
	eq(#plugin:pending("create"), 0, "suggestion creates no worktree")
	cx.asked[3].next("fix/42-custom", nil, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-edited-create", { repo = REPO, issue = ISSUE, branch = "fix/42-custom" }),
		"edited branch argv"
	)
end)

test("accepting the suggested issue branch leaves branch selection to the CLI", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer("create", SUGGESTION, 0, cx)
	cx.asked[3].next("fix/42-login", nil, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-create", { repo = REPO, issue = ISSUE }), "no branch override")
end)

test("cancelling either issue prompt creates no worktree", function()
	local plugin, cx = choose_issue("")
	cx.asked[2].next(nil, nil, cx)
	cx.asked[2].next("", nil, cx)
	eq(#plugin:pending("resolve"), 0, "no resolve after cancellation")
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer("create", SUGGESTION, 0, cx)
	cx.asked[3].next(nil, nil, cx)
	cx.asked[3].next("", nil, cx)
	eq(#plugin:pending("create"), 0, "no create after branch cancellation")
end)

test("New branch recognizes an issue URL instead of creating it as a branch", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-suggest", { issue = ISSUE, repo = REPO }), "issue suggestion")
end)

test("issue URLs select an open repository session by origin rather than folder name", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer(
		"resolve",
		'{"repos":[{"dir":"/r/app","root":"/r/app","name":"app","origin":"other/app"},{"dir":"/r/renamed","root":"/r/renamed","name":"renamed","origin":"acme/app"}]}',
		0,
		cx
	)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-suggest", { issue = ISSUE, repo = "/r/renamed" }),
		"matching origin"
	)
end)

test("issue URLs preserve the current checkout when several sessions share its origin", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer(
		"resolve",
		'{"repos":[{"dir":"/r/other","root":"/r/other","name":"other","origin":"acme/app"},{"dir":"/r/app","root":"/r/app","name":"app","origin":"acme/app"}]}',
		0,
		cx
	)
	eq(plugin:pending_line("create"), Stub.argv("issue-suggest", { issue = ISSUE, repo = REPO }), "current root")
end)

test("a missing issue repository offers a clone and resumes after cloning", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer("create", '{"error":{"code":"not_cloned","message":"not cloned","path":"/code/acme/app"}}', 1, cx)
	local picker = cx.asked[3]
	eq(Stub.item(picker, "clone").label, "Clone acme/app", "clone offer")
	eq(#plugin:pending("clone"), 0, "no silent clone")
	picker.next(Stub.item(picker, "clone"), nil, cx)
	eq(plugin:pending_line("clone"), Stub.argv("clone", { nameWithOwner = "acme/app" }), "existing clone flow")
	plugin:answer("clone", '{"root":"/code/acme/app"}', 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-suggest", { issue = ISSUE, repo = "/code/acme/app" }),
		"suggestion after clone"
	)
end)

test("pull request URLs use the PR create flow without a branch prompt", function()
	local plugin, cx = choose_new_branch()
	local url = "https://github.com/acme/app/pull/7/files?x=1#diff"
	cx.asked[2].next(url, nil, cx)
	plugin:answer("issue-ref", PR_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-create", { repo = REPO, issue = url }), "PR create argv")
	eq(#cx.asked, 2, "no editable issue branch prompt")
	eq(cx.toasts[#cx.toasts].level, "info", "progress toast")
	plugin:answer_create(cx, Stub.fixture("create-created", Stub.worktree_vars("x")))
	eq(cx.toasts[#cx.toasts].level, "success", "success toast")
end)

test("a PR URL offers Relocate and preserves its arguments", function()
	local plugin, cx = choose_new_branch()
	local url = "https://github.com/acme/app/pull/7"
	cx.asked[2].next(url, nil, cx)
	plugin:answer("issue-ref", PR_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer(
		"create",
		'{"error":{"code":"worktree_exists_elsewhere","message":"outside","existing":"/elsewhere/pr","target":"/worktrees/pr"}}',
		1,
		cx
	)
	eq(cx.asked[3] ~= nil, true, "Relocate picker opened")
	cx.asked[3].next(Stub.item(cx.asked[3], "relocate"), nil, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-create-relocate", { repo = REPO, issue = url }), "relocate argv")
end)

test("the issue palette command opens its prompt with current repository context", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO } }, 1)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin.commands["from-issue"].run(cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	local paste = table.remove(plugin.runs, 1)
	assert(paste ~= nil, "clipboard read pending")
	paste:respond("", 0, cx)
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	eq(cx.asked[1].kind, "prompt", "palette prompt")
	cx.asked[1].next("#42", nil, cx)
	plugin:answer("issue-ref", '{"ref":{"repo":null,"number":"42","kind":"issue"}}', 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-suggest", { issue = "#42", repo = REPO }), "short issue context")
end)

test("the create export accepts an issue without an invented branch", function()
	local cx = Stub.cx({}, nil)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin.exports.create(REPO, nil, nil, ISSUE, cx, Stub.call())
	eq(plugin:pending_line("create"), Stub.argv("issue-create", { repo = REPO, issue = ISSUE }), "agent issue argv")
end)

test("the create export permits a branch override with an issue but never adds new", function()
	local cx = Stub.cx({}, nil)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin.exports.create(REPO, "custom", true, ISSUE, cx, Stub.call())
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-branch-create", { repo = REPO, branch = "custom", issue = ISSUE }),
		"agent override argv"
	)
end)

test("a failed issue suggestion reports the error without a branch prompt", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer("create", '{"error":{"code":"gh_failed","message":"issue unavailable"}}', 1, cx)
	eq(cx.toasts[#cx.toasts].title, "issue unavailable", "suggestion error")
	eq(#cx.asked, 2, "no branch prompt")
end)

test("an invalid edited issue branch is offered again with the user's text", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer("create", SUGGESTION, 0, cx)
	cx.asked[3].next("bad..branch", nil, cx)
	plugin:answer("create", '{"error":{"code":"bad_args","message":"invalid branch"}}', 1, cx)
	eq(cx.asked[4].opts.value, "bad..branch", "retry branch")
	cx.asked[4].next("bad..branch", nil, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-edited-create", { repo = REPO, issue = ISSUE, branch = "bad..branch" }),
		"unchanged retry keeps override"
	)
	plugin:answer("create", '{"error":{"code":"bad_args","message":"invalid branch"}}', 1, cx)
	cx.asked[5].next("fix/42-retry", nil, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-edited-create", { repo = REPO, issue = ISSUE, branch = "fix/42-retry" }),
		"retry retains issue"
	)
end)

test("declining the clone offer performs no clone or create", function()
	local plugin, cx = choose_issue(ISSUE)
	cx.asked[2].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
	plugin:answer("create", '{"error":{"code":"not_cloned","message":"not cloned","path":"/code/acme/app"}}', 1, cx)
	cx.asked[3].next(nil, nil, cx)
	eq(#plugin:pending("clone"), 0, "clone not run")
	eq(#plugin:pending("create"), 0, "create not run")
end)

test("the issue palette accepts a URL without a current repository", function()
	local cx = Stub.cx({}, nil)
	local plugin = Stub.load({ env = Stub.ENV })
	plugin.commands["from-issue"].run(cx)
	local paste = table.remove(plugin.runs, 1)
	assert(paste ~= nil, "clipboard read pending")
	paste:respond(ISSUE, 0, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	cx.asked[1].next(ISSUE, nil, cx)
	plugin:answer("issue-ref", ISSUE_REF, 0, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-suggest-no-repo", { issue = ISSUE }),
		"URL resolves without repo"
	)
end)

test("a pull request clipboard value is not used as an issue prefill", function()
	local _, cx = choose_issue("https://github.com/acme/app/pull/7", 0, PR_REF)
	eq(cx.asked[2].opts.value, nil, "only issue URLs prefill")
end)

test("a PR URL without a repository offers a clone and resumes the common create flow", function()
	local cx = Stub.cx({}, nil)
	local plugin = Stub.load({ env = Stub.ENV })
	local url = "https://github.com/acme/app/pull/7"
	plugin.commands["from-issue"].run(cx)
	local paste = table.remove(plugin.runs, 1)
	assert(paste ~= nil, "clipboard read pending")
	paste:respond("", 0, cx)
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	cx.asked[1].next(url, nil, cx)
	plugin:answer("issue-ref", PR_REF, 0, cx)
	eq(plugin:pending_line("create"), Stub.argv("issue-create-no-repo", { issue = url }), "PR without repo")
	plugin:answer("create", '{"error":{"code":"not_cloned","message":"not cloned","path":"/code/acme/app"}}', 1, cx)
	cx.asked[2].next(Stub.item(cx.asked[2], "clone"), nil, cx)
	plugin:answer("clone", '{"root":"/code/acme/app"}', 0, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("issue-create", { repo = "/code/acme/app", issue = url }),
		"PR after clone"
	)
end)

test("New branch treats an invalid issue URL as an ordinary branch", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("https://github.com/acme/app/issues/0", nil, cx)
	eq(
		plugin:pending_line("issue-ref"),
		Stub.argv("issue-ref", { text = "https://github.com/acme/app/issues/0" }),
		"delegated parsing"
	)
	eq(#plugin:pending("create"), 0, "waits for parser")
	plugin:answer("issue-ref", '{"ref":null}', 0, cx)
	eq(
		plugin:pending_line("create"),
		Stub.argv("create-branch-new", { repo = REPO, branch = "https://github.com/acme/app/issues/0" }),
		"ordinary branch path"
	)
end)

for _, name in { "42", "#42" } do
	test("New branch preserves the ordinary branch name " .. name, function()
		local plugin, cx = choose_new_branch()
		cx.asked[2].next(name, nil, cx)
		eq(plugin:pending_line("issue-ref"), Stub.argv("issue-ref", { text = name }), "delegated parsing")
		plugin:answer("issue-ref", '{"ref":{"repo":null,"number":"42","kind":"issue"}}', 0, cx)
		eq(#plugin:pending("resolve"), 0, "no issue repository lookup")
		eq(
			plugin:pending_line("create"),
			Stub.argv("create-branch-new", { repo = REPO, branch = name }),
			"ordinary branch path"
		)
	end)
end

runner.finish()
