--!strict
local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

test("load registers commands without reading files or kv; status stays memory-only before hydration", function()
	local reads = 0
	local kv = setmetatable({}, {
		__index = function()
			reads += 1
			return nil
		end,
	})
	local plugin = Stub.load({ env = Stub.ENV, kv = kv :: any, autoTick = false })
	eq(reads, 0, "kv reads at load")
	eq(plugin:status("/r/app"), nil, "status before hydration")
	eq(reads, 0, "kv reads in status")
	plugin:tick(0)
	eq(reads, 2, "root and index hydration")
end)

test("cwd bursts defer native inspection and resolve only the latest path", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = Stub.ENV, cx = cx, autoTick = false })
	plugin:tick(0)
	plugin:take("setup")
	plugin.handlers.cwd({ pane = 1, path = "/r/old" }, cx)
	plugin.handlers.cwd({ pane = 1, path = "/r/latest" }, cx)
	eq(#plugin.runs, 0, "runs during cwd hook")
	plugin:tick(0)
	eq(plugin:pending_line("resolve"), "resolve /r/latest", "coalesced directory")
end)

test("palette rows register in batches after the process callback", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = Stub.ENV, cx = cx, autoTick = false })
	plugin:tick(0)
	plugin:press(cx)
	plugin:answer("branches", Stub.fixture("branches", Stub.worktree_vars("x")), 0, cx)
	local count = 0
	for _, cmd in plugin.commands do
		if cmd.group == "Worktrees" then
			count += 1
		end
	end
	eq(count, 0, "rows during process callback")
	plugin:tick(0)
	count = 0
	for _, cmd in plugin.commands do
		if cmd.group == "Worktrees" then
			count += 1
		end
	end
	eq(count, 3, "rows after deferred registration")
end)

runner.finish()
