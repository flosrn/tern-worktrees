--!strict

local serde = require("@lune/serde")
local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ROOT = "/wt/worktrees"
local WORKTREE = ROOT .. "/app/feat"
local ID = "finish-123"

local function load(cx: any): Stub.Harness
	return Stub.load({
		env = Stub.ENV,
		cx = cx,
		autoTick = false,
		kv = {
			worktreeRoot = ROOT,
			worktreeIndex = { [WORKTREE] = { main = "/r/app", branch = "feat", changed = 0, owner = "tern" } },
		},
	})
end

local function completed(): any
	return {
		id = ID,
		repo = "/r/app",
		current = WORKTREE,
		ready = true,
		candidates = {},
		keep = {},
		warnings = {},
		status = "completed",
		selected = { WORKTREE },
		removed = { { path = WORKTREE, branchDeleted = true, closedBlocks = { 2 } } },
		errors = {},
	}
end

local function finish_run(plugin: Stub.Harness, action: string): Stub.Run
	local runs = plugin:take("finish")
	eq(#runs, 1, "one finish request")
	eq(runs[1].argv[3], action, "finish operation")
	return runs[1]
end

local function notices(plugin: Stub.Harness, cx: any, pending: { string }, results: { any })
	finish_run(plugin, "notices"):respond(serde.encode("json", { pending = pending, completed = results }), 0, cx)
end

test("finish result survives the worktree tab and refreshes its index", function()
	local before = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" }, { pane = 2, tab = 2, cwd = WORKTREE } }, 2)
	local plugin = load(before)
	plugin.commands["finish-watch"].run(before)
	local after = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	notices(plugin, after, {}, { completed() })
	eq(#before.toasts, 0, "expired tab context has no toast")
	eq(#after.toasts, 1, "result toast in surviving window")
	eq(after.toasts[1].level, "success", "completed result level")
	eq(string.find(after.toasts[1].title, "1", 1, true) ~= nil, true, "removed count visible")
	eq(plugin.kv.worktreeIndex[WORKTREE], nil, "removed worktree leaves index")
	eq(plugin:pending_line("branches"), "branches --repo /r/app", "main repository refresh")
	eq(#after.effects, 0, "window never closes the main tab")
	local ack = finish_run(plugin, "acknowledge")
	eq(ack.argv[4], ID, "acknowledged delivered result")
end)

test("two finish-watch actions share one in-flight notices request", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	plugin.commands["finish-watch"].run(cx)
	plugin.commands["finish-watch"].run(cx)
	eq(#plugin:pending("finish"), 1, "coalesced finish requests")
	notices(plugin, cx, {}, {})
	eq(#cx.toasts, 0, "no result without a completed teardown")
end)

test("plugin load resumes notices once and stays idle when none are pending", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	plugin:tick(0)
	notices(plugin, cx, {}, {})
	plugin:tick(10000)
	eq(#plugin:pending("finish"), 0, "no permanent notices watcher")
	eq(#cx.toasts, 0, "declined and absent results stay silent")
end)

test("pending teardown polls after one second with the surviving window context", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	plugin:tick(0)
	notices(plugin, cx, { ID }, {})
	plugin:tick(999)
	eq(#plugin:pending("finish"), 0, "no early notices poll")
	plugin:tick(1)
	eq(#plugin:pending("finish"), 1, "pending notices poll")
	notices(plugin, cx, {}, { completed() })
	finish_run(plugin, "acknowledge"):respond('{"id":"finish-123","acknowledged":true}', 0, cx)
	plugin:tick(10000)
	eq(#plugin:pending("finish"), 0, "completed teardown stops polling")
	eq(#cx.toasts, 1, "one completion notification")
end)

test("failed notices stay visible without acknowledging or reporting success", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	plugin.commands["finish-watch"].run(cx)
	local run = finish_run(plugin, "notices")
	run:respond('{"error":{"code":"finish_store","message":"private plan unreadable"}}', 1, cx)
	eq(#cx.toasts, 1, "failed notices produce one error")
	eq(cx.toasts[1].level, "error", "CLI failure level")
	eq(string.find(cx.toasts[1].title, "private plan unreadable", 1, true) ~= nil, true, "actual CLI cause visible")
	eq(#plugin:pending("finish"), 0, "failed read never acknowledges")
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, {})
end)

test("failed acknowledgement stays visible and retries without repeating the result", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { completed() })
	finish_run(plugin, "acknowledge"):respond('{"error":{"code":"finish_store","message":"ack write denied"}}', 1, cx)
	eq(#cx.toasts, 2, "result and acknowledgement failure")
	eq(cx.toasts[2].level, "error", "acknowledgement failure level")
	eq(string.find(cx.toasts[2].title, "ack write denied", 1, true) ~= nil, true, "ack failure cause visible")
	plugin:take("branches")
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { completed() })
	eq(#cx.toasts, 2, "result is not shown twice in one VM")
	eq(#plugin:pending("branches"), 0, "delivered result has no repeated index effects")
	finish_run(plugin, "acknowledge"):respond('{"id":"finish-123","acknowledged":true}', 0, cx)
end)

test("kept worktrees explain their cause without claiming an all-success teardown", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	local result = completed()
	result.removed = {}
	result.keep = { { path = WORKTREE, code = "active_process" } }
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { result })
	eq(cx.toasts[1].level, "info", "kept result level")
	eq(string.find(cx.toasts[1].detail or "", "process", 1, true) ~= nil, true, "active process cause visible")
	eq(plugin.kv.worktreeIndex[WORKTREE] ~= nil, true, "kept worktree stays indexed")
end)

test("actual completed errors outrank kept results and explain what failed", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	local result = completed()
	result.keep = { { path = ROOT .. "/app/busy", code = "dirty_worktree" } }
	result.errors = { { path = ROOT .. "/app/failed", code = "teardown_failed", detail = "permission denied" } }
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { result })
	eq(cx.toasts[1].level, "error", "partial failure result level")
	eq(string.find(cx.toasts[1].detail or "", "permission denied", 1, true) ~= nil, true, "actual error visible")
	eq(string.find(cx.toasts[1].detail or "", "busy:", 1, true) ~= nil, true, "kept worktree retained in details")
end)

test("structured causes preserve worktrees and their collection determines the notification class", function()
	local codes = {
		"bad_args",
		"config_invalid",
		"worktree_config_invalid",
		"service_failed",
		"docker_missing",
		"setup_failed",
		"not_a_repo",
		"not_cloned",
		"not_managed",
		"path_conflict",
		"worktree_exists_elsewhere",
		"dirty_worktree",
		"busy_tabs",
		"git_failed",
		"gh_failed",
		"omp_failed",
		"tern_failed",
		"path_identity_changed",
		"registration_changed",
		"inspection_failed",
		"caller_waiting",
		"interrupted",
		"worker_start_failed",
		"teardown_failed",
		"retained",
		"not_merged",
		"active_process",
	}
	for _, code in ipairs(codes) do
		for _, collection in ipairs({ "keep", "errors" }) do
			local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
			local plugin = load(cx)
			local result = completed()
			result.removed = {}
			result[collection] = { { path = WORKTREE, code = code } }
			plugin.commands["finish-watch"].run(cx)
			notices(plugin, cx, {}, { result })
			eq(#cx.toasts, 1, code .. " produces one notification")
			eq(cx.toasts[1].level, if collection == "errors" then "error" else "info", code .. " class")
			eq(plugin.kv.worktreeIndex[WORKTREE] ~= nil, true, code .. " never removes a retained worktree")
			eq(finish_run(plugin, "acknowledge").argv[4], ID, code .. " result acknowledged")
		end
	end
end)

test("external exception details cannot change the structured notification class", function()
	for _, collection in ipairs({ "keep", "errors" }) do
		local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
		local plugin = load(cx)
		local result = completed()
		local external = if collection == "errors" then "removed successfully; no errors" else "fatal error"
		result.removed = {}
		result[collection] = { { path = WORKTREE, code = "inspection_failed", detail = external } }
		plugin.commands["finish-watch"].run(cx)
		notices(plugin, cx, {}, { result })
		eq(cx.toasts[1].level, if collection == "errors" then "error" else "info", "class ignores external prose")
		eq(string.find(cx.toasts[1].detail or "", external, 1, true) ~= nil, true, "external exception detail visible")
	end
end)

test("long result details show ten worktrees and the retained status command", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	local result = completed()
	for i = 1, 11 do
		table.insert(result.keep, { path = ROOT .. "/app/kept-" .. i, code = "retained" })
	end
	result.warnings = { "finish warning" }
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { result })
	local detail = cx.toasts[1].detail or ""
	eq(string.find(detail, "kept-10:", 1, true) ~= nil, true, "tenth worktree visible")
	eq(string.find(detail, "kept-11:", 1, true), nil, "eleventh worktree is not in the toast")
	eq(
		string.find(detail, "tern-wt finish status " .. ID, 1, true) ~= nil,
		true,
		"actual retained status is discoverable"
	)
end)

test("completed result warnings remain visible", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	local result = completed()
	result.warnings = { "branch retained by policy" }
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { result })
	eq(
		string.find(cx.toasts[1].detail or "", "branch retained by policy", 1, true) ~= nil,
		true,
		"backend warning visible"
	)
end)

test("a long external detail is shortened with a pointer to the actual retained status", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	local result = completed()
	result.keep =
		{ { path = WORKTREE, code = "inspection_failed", detail = "busy " .. string.rep("long-process ", 30) } }
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { result })
	local detail = cx.toasts[1].detail or ""
	eq(#detail < 200, true, "individual cause stays short")
	eq(string.find(detail, "busy", 1, true) ~= nil, true, "external detail still recognizable")
	eq(string.find(detail, "tern-wt finish status " .. ID, 1, true) ~= nil, true, "full detail remains available")
end)

test("a new plugin VM resumes a completed result that was not acknowledged", function()
	local firstCx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local first = load(firstCx)
	first:tick(0)
	notices(first, firstCx, {}, { completed() })
	finish_run(first, "acknowledge"):respond('{"id":"finish-123","acknowledged":false}', 0, firstCx)
	local resumedCx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local resumed = load(resumedCx)
	resumed:tick(0)
	notices(resumed, resumedCx, {}, { completed() })
	eq(#resumedCx.toasts, 1, "unacknowledged durable result resumes after reload")
	eq(resumedCx.toasts[1].level, "success", "reloaded result has its actual level")
	eq(#resumed:pending("remove"), 0, "replay never tears down again")
end)

test("an acknowledgement refused by the backend is not silently accepted", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = load(cx)
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { completed() })
	finish_run(plugin, "acknowledge"):respond('{"id":"finish-123","acknowledged":false}', 0, cx)
	eq(#cx.toasts, 2, "refused acknowledgement is visible")
	eq(cx.toasts[2].level, "error", "refused acknowledgement level")
	plugin.commands["finish-watch"].run(cx)
	notices(plugin, cx, {}, { completed() })
	eq(#cx.toasts, 2, "no duplicate result after refused acknowledgement")
	eq(finish_run(plugin, "acknowledge").argv[4], ID, "refused acknowledgement retried")
end)

runner.finish()
