import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enterRequestFile } from './enter.ts';

/** The part of the omp extension context that the enter lifecycle reads. */
export interface EnterContext {
  cwd: string;
  agent?: { kind: string };
  ui?: { notify: (message: string, type: 'info' | 'warning' | 'error') => void };
  sessionManager: { getSessionFile: () => string | undefined; getSessionId: () => string };
  shutdown: () => void;
}

export interface EnterHookResult {
  block?: boolean;
  reason?: string;
  continue?: boolean;
  additionalContext?: string;
}

/** The event of a hook. The enter lifecycle reads no field of it. */
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

/** Structural subset of the omp 18.18 extension interface that the enter lifecycle uses. No runtime host import. */
export interface EnterExtensionAPI {
  on: (name: string, handler: EnterHandler) => void;
  exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<EnterExecResult>;
}

const cli = fileURLToPath(new URL('../bin/tern-wt', import.meta.url));

/** Tells if the main session of `ctx` has a worktree to enter, recorded by `tern-wt enter <worktree>` or `tern-wt create --enter`. */
const requested = (ctx: EnterContext): boolean => (ctx.agent === undefined || ctx.agent.kind === 'main') && existsSync(enterRequestFile(ctx.sessionManager.getSessionId()));

/**
 * Moves the main session into the worktree that `tern-wt enter` or `tern-wt create --enter` recorded. After the tool call that recorded it, each other tool call
 * of the turn is blocked. At the end of the turn, `tern-wt enter --session <id> --fork <session file>` forks the session into a block adjacent to the tab of the worktree,
 * and this session stops. When the fork fails, this session stays and continues the task.
 */
export default function enterExtension(pi: EnterExtensionAPI): void {
  let pending = false;
  pi.on('tool_result', (_event, ctx): EnterHookResult | undefined => {
    if (pending || !requested(ctx)) {
      return undefined;
    }
    pending = true;
    return {
      additionalContext:
        'This session moves into the recorded worktree when this turn ends: a fork of it continues the task there, and this session ends. Make no other tool call. End the turn now with one short line for the user.',
    };
  });
  pi.on('tool_call', (): EnterHookResult | undefined => {
    if (!pending) {
      return undefined;
    }
    return { block: true, reason: 'This session is moving into a worktree. End the turn now; the fork continues the task there.' };
  });
  pi.on('session_stop', async (_event, ctx): Promise<EnterHookResult | undefined> => {
    if (!pending && !requested(ctx)) {
      return undefined;
    }
    pending = false;
    const args = ['enter', '--session', ctx.sessionManager.getSessionId(), '--fork', ctx.sessionManager.getSessionFile() ?? ''];
    const output = await pi.exec(cli, args, { cwd: ctx.cwd, timeout: 60_000 });
    if (output.code === 0 && !output.killed) {
      ctx.ui?.notify('Session forked into the worktree', 'info');
      ctx.shutdown();
      return undefined;
    }
    const reason = output.stderr.trim() || `tern-wt enter failed (${output.code})`;
    return {
      additionalContext: `The move into the worktree failed, so this session stays here: ${reason}. Tell the user, then continue the task in this session.`,
      continue: true,
    };
  });
}
