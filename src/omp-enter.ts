import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface EnterSchema {
  optional: () => EnterSchema;
}

export interface EnterToolResult {
  content: { type: 'text'; text: string }[];
  details: { path?: string };
  isError?: boolean;
}

/** The part of the omp extension context that `worktree_enter` reads. */
export interface EnterContext {
  cwd: string;
  agent?: { kind: string };
  ui?: { notify: (message: string, type: 'info' | 'warning' | 'error') => void };
  sessionManager: { getSessionFile: () => string | undefined };
  shutdown: () => void;
}

export interface EnterHookResult {
  block?: boolean;
  reason?: string;
  continue?: boolean;
  additionalContext?: string;
}

export interface EnterEvent {
  toolName?: string;
}

export type EnterHandler = (event: EnterEvent, ctx: EnterContext) => EnterHookResult | undefined | Promise<EnterHookResult | undefined>;

export interface EnterExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface EnterTool {
  name: string;
  label: string;
  description: string;
  parameters: EnterSchema;
  loadMode: 'essential';
  execute: (
    id: string,
    params: { path?: string },
    signal: AbortSignal | undefined,
    onUpdate: ((result: EnterToolResult) => void) | undefined,
    ctx: EnterContext,
  ) => EnterToolResult;
}

/** Structural subset of the omp 18.18 extension interface that `worktree_enter` uses. No runtime host import. */
export interface EnterExtensionAPI {
  zod: { string: () => EnterSchema; object: (properties: Record<string, EnterSchema>) => EnterSchema };
  on: (name: string, handler: EnterHandler) => void;
  registerTool: (tool: EnterTool) => void;
  exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<EnterExecResult>;
}

const cli = fileURLToPath(new URL('../bin/tern-wt', import.meta.url));

const failure = (text: string): EnterToolResult => ({ content: [{ text, type: 'text' }], details: {}, isError: true });

/** A worktree that the session moves into when its turn ends, and the transcript that the fork copies. */
interface PendingEnter {
  dir: string;
  file: string;
}

/**
 * Registers `worktree_enter`. The tool records a worktree. At the end of the turn, `tern-wt enter` forks the session into a block adjacent to the tab of that worktree,
 * and this session stops. Until then each other tool call is blocked, so no more work runs in the first directory.
 */
export default function enterExtension(pi: EnterExtensionAPI): void {
  let pending: PendingEnter | null = null;
  pi.registerTool({
    description:
      'Move this session into a linked git worktree, for example one that `tern-wt create` just made. At the end of this turn, the session is forked into a Tern block in the tab of the worktree, where it continues the task, and this session ends. Call it last in the turn.',
    execute(_id, params, _signal, _update, ctx) {
      if (ctx.agent !== undefined && ctx.agent.kind !== 'main') {
        return failure('Only the main session can move into a worktree.');
      }
      if (process.env.TERN_PANE === undefined || process.env.TERN_PANE === '') {
        return failure('This session does not run in a Tern pane, so it cannot move into the tab of a worktree.');
      }
      const file = ctx.sessionManager.getSessionFile();
      if (file === undefined || file === '') {
        return failure('This session has no session file to fork.');
      }
      if (params.path === undefined || params.path.trim() === '') {
        return failure('Expected the path of a worktree.');
      }
      let dir: string;
      try {
        dir = realpathSync(path.resolve(ctx.cwd, params.path));
      } catch (error) {
        return failure(`Cannot resolve the worktree path: ${String(error)}`);
      }
      pending = { dir, file };
      return {
        content: [
          {
            text: `This session moves into ${dir} when this turn ends: a fork of it continues the task there, and this session ends. Make no other tool call. End the turn now with one short line for the user.`,
            type: 'text',
          },
        ],
        details: { path: dir },
      };
    },
    label: 'Enter worktree',
    loadMode: 'essential',
    name: 'worktree_enter',
    parameters: pi.zod.object({ path: pi.zod.string() }),
  });
  pi.on('tool_call', (): EnterHookResult | undefined => {
    if (pending === null) {
      return undefined;
    }
    return { block: true, reason: `This session is moving into ${pending.dir}. End the turn now; the fork continues the task there.` };
  });
  pi.on('session_stop', async (_event, ctx): Promise<EnterHookResult | undefined> => {
    if (pending === null) {
      return undefined;
    }
    const { dir, file } = pending;
    pending = null;
    const output = await pi.exec(cli, ['enter', dir, '--fork', file], { cwd: ctx.cwd, timeout: 60_000 });
    if (output.code === 0 && !output.killed) {
      ctx.ui?.notify(`Session forked into ${dir}`, 'info');
      ctx.shutdown();
      return undefined;
    }
    const reason = output.stderr.trim() || `tern-wt enter failed (${output.code})`;
    return { additionalContext: `The move into ${dir} failed, so this session stays here: ${reason}. Tell the user, then continue the task in this session.`, continue: true };
  });
}
