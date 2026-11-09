import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { FinishChoice, FinishPlan } from './finish-types.ts';
import { finishChoice, finishForm, finishSelection, isFinishAsk, nativeFinishAsk, parseFinishArm, parseFinishPlan, validateFinishArm } from './omp-finish-input.ts';
import type { FinishContext, FinishEvent, FinishExtensionAPI, FinishHookResult, FinishToolParams, FinishToolResult, PendingFinish, SessionFinish } from './omp-finish-types.ts';
import { ternBin } from './tern.ts';

const cli = fileURLToPath(new URL('../bin/tern-wt', import.meta.url));
const entryType = 'tern-worktrees.finish';
const result = (text: string, details: FinishToolParams = {}, isError = false): FinishToolResult => ({ content: [{ text, type: 'text' }], details, isError });

const activeJobs = (ctx: FinishContext): boolean => {
  if (ctx.hasPendingMessages()) {
    return true;
  }
  const jobs = ctx.getAsyncJobSnapshot();
  if (jobs === null) {
    return false;
  }
  if (jobs.running.length > 0 || jobs.delivery.queued > 0) {
    return true;
  }
  return jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0;
};

const automaticFinish = (state: SessionFinish): boolean => {
  if (state.scoped === true || state.orchestrate === true || state.automaticCheckFailed === true) {
    return false;
  }
  return state.sawTool === true && state.baselineMerged !== undefined;
};

const deliveredReport = (event: FinishEvent): boolean => {
  const { message } = event;
  if (message?.role !== 'assistant' || message.stopReason !== 'stop') {
    return false;
  }
  return message.content?.some(block => block.type === 'text' && (block.text?.trim().length ?? 0) > 0) === true;
};

const notifyFinish = async (pi: FinishExtensionAPI, ctx: FinishContext): Promise<void> => {
  try {
    const watching = await pi.exec(ternBin(), ['ctl', 'plugins', 'run', 'plugin.tern-worktrees.finish-watch'], { cwd: ctx.cwd, timeout: 10_000 });
    if (watching.code !== 0 || watching.killed) {
      throw new Error(watching.stderr.trim() || 'Tern notification watcher unavailable');
    }
  } catch (error) {
    ctx.ui?.notify(`Teardown is armed, but the Tern notification watcher failed. The backend result remains saved: ${String(error)}`, 'warning');
  }
};

/** Register the delivery finish lifecycle in each omp session. */
export default function finishExtension(pi: FinishExtensionAPI): void {
  let state: SessionFinish = { owned: [], requested: false };
  const save = (): void => {
    pi.appendEntry(entryType, structuredClone(state));
  };
  const command = async (args: string[], ctx: FinishContext): Promise<string> => {
    const output = await pi.exec(cli, ['finish', ...args], { cwd: ctx.cwd, timeout: 30_000 });
    if (output.code !== 0 || output.killed) {
      throw new Error(output.stderr.trim() || `tern-wt finish failed (${output.code})`);
    }
    return output.stdout;
  };
  const planFor = async (ctx: FinishContext): Promise<FinishPlan> => {
    const checkout = await pi.exec('git', ['-C', ctx.cwd, 'rev-parse', '--show-toplevel'], { cwd: ctx.cwd, timeout: 10_000 });
    const current = checkout.stdout.trim();
    if (checkout.code !== 0 || checkout.killed || !path.isAbsolute(current)) {
      throw new Error('Cannot resolve the current checkout; keep all worktrees.');
    }
    const args = ['plan', '--repo', ctx.cwd, '--current', current, '--pid', String(process.pid), '--session', ctx.sessionManager.getSessionId()];
    const block = process.env.TERN_PANE ?? '';
    if (/^[1-9]\d*$/u.test(block) && Number.isSafeInteger(Number(block))) {
      args.push('--block', block);
    }
    for (const owned of state.owned) {
      args.push('--owned', owned);
    }
    for (const retained of state.retained ?? []) {
      args.push('--exclude', retained);
    }
    return parseFinishPlan(await command(args, ctx));
  };
  const restore = async (_event: FinishEvent, ctx: FinishContext): Promise<undefined> => {
    state = { owned: [], requested: false };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === entryType && entry.data !== undefined) {
        state = structuredClone(entry.data);
      }
    }
    if (state.pending !== undefined && state.pending.status !== 'closed') {
      state.pending.status = 'closed';
      state.requested = false;
      save();
    }
    if (ctx.agent !== undefined && ctx.agent.kind !== 'main') {
      return undefined;
    }
    if (state.baselineMerged === undefined) {
      try {
        const plan = await planFor(ctx);
        state.baselineMerged = plan.candidates.map(candidate => `${candidate.path}:${candidate.head}`);
      } catch {
        delete state.baselineMerged;
      }
      save();
    }
    return undefined;
  };
  pi.on('session_start', restore);
  pi.on('session_branch', restore);
  pi.on('session_tree', restore);
  pi.on('before_agent_start', event => {
    if (event.prompt?.split(/\r?\n/u).includes("This worker is assigned by the user's explicit `orchestrate` invocation.") === true) {
      state.worker = true;
      save();
    }
  });
  pi.registerTool({
    description:
      "Register this run's worktree paths with action scope; use ready only after delivery and all run jobs are finished. The lifecycle asks the user before any teardown. This tool never accepts a teardown choice.",
    execute(_id, params, _signal, _update, ctx) {
      if (params.action !== 'scope' && params.action !== 'ready') {
        return result('Expected action scope or ready.', {}, true);
      }
      try {
        const owned = [...new Set([...state.owned, ...(params.owned ?? [])].map(value => realpathSync(path.resolve(ctx.cwd, value))))];
        const retained = [...new Set([...(state.retained ?? []), ...(params.retained ?? [])].map(value => realpathSync(path.resolve(ctx.cwd, value))))];
        state.owned = owned;
        state.retained = retained;
      } catch (error) {
        return result(`Cannot resolve finish scope paths. Keep all worktrees: ${String(error)}`, {}, true);
      }
      if (params.action === 'scope') {
        state.scoped = true;
      }
      if (params.workflow === 'orchestrate') {
        state.orchestrate = true;
      }
      if (params.action === 'ready') {
        state.requested = true;
      }
      save();
      return result('Finish scope recorded. Readiness and consent are checked at the end of the turn.', { action: params.action, owned: state.owned });
    },
    label: 'Finish worktrees',
    loadMode: 'essential',
    name: 'worktree_finish',
    parameters: pi.zod.object({
      action: pi.zod.enum(['scope', 'ready']),
      owned: pi.zod.array(pi.zod.string()).optional(),
      retained: pi.zod.array(pi.zod.string()).optional(),
      workflow: pi.zod.enum(['orchestrate']).optional(),
    }),
  });
  pi.on('tool_call', (event): FinishHookResult | undefined => {
    const { pending } = state;
    if (event.toolName !== 'ask' || pending === undefined || !isFinishAsk(event)) {
      return undefined;
    }
    if (pending.status !== 'offered') {
      return { block: true, reason: 'This finish plan has already been asked or resolved. Keep its recorded decision.' };
    }
    if (!nativeFinishAsk(pi)) {
      pending.status = 'closed';
      save();
      return { block: true, reason: 'The real built-in ask is unavailable; keep all worktrees.' };
    }
    if (event.toolCallId === undefined || event.toolCallId.trim() === '' || !isDeepStrictEqual(event.input, { html: pending.form })) {
      return { block: true, reason: 'Finish consent requires the exact saved HTML form and safe default.' };
    }
    pending.status = 'asking';
    pending.callId = event.toolCallId;
    save();
    return undefined;
  });
  const arm = async (pending: PendingFinish, choice: FinishChoice, ctx: FinishContext): Promise<FinishHookResult> => {
    try {
      const selected = pending.approved[choice];
      if (selected.some(target => state.retained?.includes(target) === true)) {
        throw new Error('Retained finish target selected');
      }
      const args = ['arm', pending.plan.id, '--choice', choice];
      for (const target of selected) {
        args.push('--selected', target);
      }
      const armed = parseFinishArm(await command(args, ctx));
      validateFinishArm(armed, pending, state, choice);
      pending.status = choice === 'none' ? 'closed' : 'armed';
      pending.selected = armed.selected;
      pending.reported = false;
      save();
      if (choice !== 'none') {
        await notifyFinish(pi, ctx);
      }
      save();
      return {
        additionalContext:
          choice === 'none'
            ? 'The user declined teardown. Keep every worktree and this tab.'
            : 'Finish teardown is armed for the approved saved plan. Write a short, genuine final delivery report now. The external worker will revalidate targets; do not claim they were already removed. Do not invoke shutdown yourself.',
      };
    } catch (error) {
      pending.status = 'closed';
      save();
      return { additionalContext: `Finish arm failed. Keep all worktrees and this tab, and report: ${String(error)}` };
    }
  };
  pi.on('tool_result', async (event, ctx): Promise<FinishHookResult | undefined> => {
    if (event.toolName !== 'ask' && event.toolName !== 'worktree_finish' && event.isError !== true) {
      state.sawTool = true;
      save();
    }
    const { pending } = state;
    if (event.toolName !== 'ask' || pending?.status !== 'asking' || event.toolCallId !== pending.callId) {
      return undefined;
    }
    const choice = nativeFinishAsk(pi) ? finishChoice(event, pending) : null;
    if (choice === null) {
      pending.status = 'closed';
      save();
      return { additionalContext: 'No explicit finish consent was received. Keep all worktrees and this tab.' };
    }
    return await arm(pending, choice, ctx);
  });
  pi.on('message_end', event => {
    const { pending } = state;
    if (pending?.status === 'armed' && deliveredReport(event)) {
      pending.reported = true;
      save();
    }
  });
  const finishArmed = (pending: PendingFinish, ctx: FinishContext): FinishHookResult | undefined => {
    if (pending.reported !== true) {
      return { additionalContext: 'Before settling, write the short final delivery report for the user. Teardown has only been armed, not completed.', continue: true };
    }
    pending.status = 'closed';
    save();
    if (pending.plan.current !== null && pending.selected?.includes(pending.plan.current) === true) {
      ctx.shutdown();
    }
    return undefined;
  };
  const offer = async (ctx: FinishContext): Promise<FinishHookResult | undefined> => {
    const explicit = state.requested;
    state.requested = false;
    state.automaticCheckFailed = true;
    save();
    try {
      const plan = await planFor(ctx);
      const newlyMerged = plan.candidates.some(candidate => candidate.path === plan.current && state.baselineMerged?.includes(`${candidate.path}:${candidate.head}`) !== true);
      state.baselineMerged = [...new Set([...(state.baselineMerged ?? []), ...plan.candidates.map(candidate => `${candidate.path}:${candidate.head}`)])];
      state.automaticCheckFailed = false;
      save();
      if (!explicit && !newlyMerged) {
        return undefined;
      }
      if (!nativeFinishAsk(pi)) {
        return { additionalContext: 'The real built-in ask is unavailable. Keep all worktrees and this tab; no teardown was armed.', continue: true };
      }
      if (!plan.ready || plan.candidates.length === 0) {
        return { additionalContext: `Worktrees kept: delivery is not ready. ${JSON.stringify({ keep: plan.keep, warnings: plan.warnings })}`, continue: true };
      }
      const form = finishForm(plan, state);
      const approved = { current: finishSelection(plan, state, 'current'), merged: finishSelection(plan, state, 'merged'), none: [] };
      state.pending = { approved, form, plan, status: 'offered' };
      save();
      return {
        additionalContext: `Before settling, call the real built-in ask tool once with exactly this model input, including the French intent i. The host strips i before the native tool_call hook; its input contains only html with the saved form. Do not change the HTML, add other form fields, replace ask with a UI dialog or shell command, fabricate a tool result, or ask in prose.\n${JSON.stringify({ html: form, i: 'Recueillir le choix explicite de Florian sur les worktrees du plan enregistré, sans suppression par défaut.' })}`,
        continue: true,
      };
    } catch (error) {
      save();
      return { additionalContext: `Finish check failed; keep all worktrees and this tab. Report the failure honestly: ${String(error)}`, continue: true };
    }
  };
  pi.on('session_stop', async (_event, ctx): Promise<FinishHookResult | undefined> => {
    if (state.worker === true || (ctx.agent !== undefined && ctx.agent.kind !== 'main')) {
      return undefined;
    }
    if (activeJobs(ctx)) {
      return undefined;
    }
    if (state.pending?.status === 'armed') {
      return finishArmed(state.pending, ctx);
    }
    if (state.pending !== undefined) {
      return undefined;
    }
    if (!state.requested && !automaticFinish(state)) {
      return undefined;
    }
    return await offer(ctx);
  });
}
