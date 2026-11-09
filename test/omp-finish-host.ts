import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vite-plus/test';
import finishExtension from '../src/omp-finish.ts';
import type { FinishArmed, FinishPlan } from '../src/finish-types.ts';
import type {
  FinishContext,
  FinishEntry,
  FinishEvent,
  FinishExecResult,
  FinishExtensionAPI,
  FinishHandler,
  FinishHookResponse,
  FinishSchema,
  FinishTool,
  FinishToolParams,
  FinishToolResult,
} from '../src/omp-finish-types.ts';
import { isJsonObject, isString } from '../src/json.ts';
import { run } from '../src/proc.ts';
import { tempDir, tmpRepo, useSandbox } from './helpers.ts';

const schema: FinishSchema = { optional: () => schema };

export interface TestAskInput {
  html: string;
}

interface MalformedFinishEnvelope {
  id?: string;
  selected?: string[];
  status?: string;
}

type TestCliResponse = FinishPlan | FinishArmed | MalformedFinishEnvelope | string;

const execute = async (command: string, args: string[], cwd?: string): Promise<FinishExecResult> => {
  const output = await run([command, ...args], { cwd });
  return { code: output.status, killed: false, stderr: output.stderr, stdout: output.stdout };
};

/** Extract the real ask payload from a finish continuation. */
export const askInput = (response: FinishHookResponse): TestAskInput => {
  const text = response?.additionalContext ?? '';
  const value: unknown = JSON.parse(text.slice(text.indexOf('{')));
  if (!isJsonObject(value)) {
    throw new Error('Missing native HTML ask input and French intent');
  }
  if (!('html' in value) || !isString(value.html) || !('i' in value) || !isString(value.i)) {
    throw new Error('Missing native HTML ask input and French intent');
  }
  return { html: value.html };
};

/** Fixture matching the observed native HTML ask result, not a question echo. */
export const askReply = (input: TestAskInput, choice: 'current' | 'merged' | 'none' = 'current'): Pick<FinishEvent, 'content' | 'details' | 'isError'> => {
  const name = /<form id="(?<name>[^"]+)"/u.exec(input.html)?.groups?.name;
  if (name === undefined) {
    throw new Error('Missing plan-bound form name');
  }
  const labels = { current: 'Supprimer seulement mes worktrees', merged: 'Supprimer aussi les autres PR fusionnées du dépôt', none: 'Ne rien supprimer' };
  return {
    content: [{ text: `User answers:\n${JSON.stringify({ [name]: choice }, null, 2)}`, type: 'text' }],
    details: { answers: [{ answer: labels[choice], name, question: 'La livraison est terminée. Quels worktrees souhaitez-vous supprimer après le bilan final ?' }] },
    isError: false,
  };
};

const parseCall = (line: string): string[] => {
  const value: unknown = JSON.parse(line);
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new Error('Invalid fake CLI log');
  }
  return value;
};

/** In-memory adapter for the extension host, with real child-process CLI calls. */
export class FinishHost {
  readonly entries: FinishEntry[] = [];
  readonly handlers = new Map<string, FinishHandler>();
  readonly tools = new Map<string, FinishTool>();
  readonly api: FinishExtensionAPI;
  readonly ctx: FinishContext;
  readonly plan: FinishPlan;
  readonly binary: string;
  readonly planFile: string;
  readonly log: string;
  private shutdownCount = 0;

  constructor(cwd: string, root: string) {
    this.binary = path.join(root, 'cli.cjs');
    this.planFile = path.join(root, 'plan.json');
    this.log = path.join(root, 'calls.jsonl');
    this.plan = {
      candidates: [
        {
          branch: 'feature/one',
          head: 'a'.repeat(40),
          path: cwd,
          pr: { headRefOid: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), mergedAt: '2026-11-08T00:00:00Z', number: 42, url: 'https://github.com/test/repo/pull/42' },
        },
      ],
      current: cwd,
      id: 'plan-1',
      keep: [{ code: 'active_process', path: '/work/busy' }],
      ready: true,
      repo: cwd,
      warnings: [],
    };
    this.ctx = {
      cwd,
      getAsyncJobSnapshot: () => null,
      hasPendingMessages: () => false,
      hasUI: true,
      sessionManager: { getBranch: () => this.entries, getSessionId: () => 'session-1' },
      shutdown: () => {
        this.shutdownCount += 1;
      },
    };
    this.api = this.hostApi();
    this.savePlan();
    writeFileSync(this.log, '');
    writeFileSync(
      this.binary,
      `const fs = require('node:fs');
const [planFile, log, ...args] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const values = flag => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
if (args[1] === 'plan') {
 const plan = JSON.parse(fs.readFileSync(planFile)); const owned = values('--owned'); const excluded = values('--exclude');
 plan.keep.push(...plan.candidates.filter(candidate => excluded.includes(candidate.path)).map(candidate => ({ path: candidate.path, code: 'retained' })));
 plan.candidates = plan.candidates.filter(candidate => !excluded.includes(candidate.path));
 fs.writeFileSync(planFile + '.saved', JSON.stringify({ plan, owned }));
 process.stdout.write(JSON.stringify(plan));
} else if (args[1] === 'arm') {
 const { plan, owned } = JSON.parse(fs.readFileSync(planFile + '.saved')); const choice = values('--choice')[0]; const approved = values('--selected');
 const selected = choice === 'none' ? [] : plan.candidates.filter(candidate => choice === 'merged' || candidate.path === plan.current || owned.includes(candidate.path)).map(candidate => candidate.path);
 const sameSet = approved.length === new Set(approved).size && JSON.stringify(approved.toSorted()) === JSON.stringify(selected.toSorted());
 if (args[2] !== plan.id || !['current', 'merged', 'none'].includes(choice) || !sameSet) {
  process.stderr.write('Approved selection differs from the saved finish preview'); process.exitCode = 1;
 } else { process.stdout.write(JSON.stringify({ id: plan.id, status: choice === 'none' ? 'declined' : 'armed', selected })); }
} else { process.stderr.write('unsupported'); process.exitCode = 1; }
`,
    );
    finishExtension(this.api);
  }

  private hostApi(): FinishExtensionAPI {
    return {
      appendEntry: (customType, data) => {
        this.entries.push({ customType, data: structuredClone(data), type: 'custom' });
      },
      exec: async (command, args, options) =>
        command.endsWith('/bin/tern-wt')
          ? await execute(process.execPath, [this.binary, this.planFile, this.log, ...args], options?.cwd)
          : await execute(command, args, options?.cwd),
      getActiveTools: () => ['ask', 'worktree_finish'],
      getAllTools: () => [{ name: 'ask', sourceInfo: { origin: 'top-level', path: '<builtin:ask>', scope: 'temporary', source: 'builtin' } }],
      on: (name, handler) => {
        this.handlers.set(name, handler);
      },
      registerTool: tool => {
        this.tools.set(tool.name, tool);
      },
      zod: { array: () => schema, enum: () => schema, object: () => schema, string: () => schema },
    };
  }

  /** Deliver a lifecycle event through the registered public handler. */
  async emit(name: string, event: FinishEvent = {}): Promise<FinishHookResponse> {
    return await this.handlers.get(name)?.(event, this.ctx);
  }
  /** Invoke the essential tool through its registered execution interface. */
  async tool(params: FinishToolParams): Promise<FinishToolResult> {
    const tool = this.tools.get('worktree_finish');
    if (tool === undefined) {
      throw new Error('Missing finish tool');
    }
    return await tool.execute('finish-call', params, undefined, undefined, this.ctx);
  }
  /** Read calls that crossed the real CLI process seam. */
  calls(): string[][] {
    return readFileSync(this.log, 'utf-8').trim().split('\n').filter(Boolean).map(parseCall);
  }
  /** Replace the fake process with a real CLI startup failure. */
  failArm(): void {
    writeFileSync(this.binary, "process.stderr.write('worker could not start'); process.exitCode = 1;");
  }
  /** Send a controlled CLI envelope through a real child process. */
  respond(output: TestCliResponse): void {
    const text = JSON.stringify(output);
    writeFileSync(this.binary, `process.stdout.write(${JSON.stringify(text)});`);
  }
  /** Publish the next read-only backend plan. */
  savePlan(): void {
    writeFileSync(this.planFile, JSON.stringify(this.plan));
  }
  /** Number of shutdown requests observed by this host. */
  shutdowns(): number {
    return this.shutdownCount;
  }
}

/** Start a new isolated host with one temporary Git checkout. */
export const host = async (): Promise<FinishHost> => {
  useSandbox();
  vi.stubEnv('TERN_PANE', undefined);
  const repo = await tmpRepo();
  const instance = new FinishHost(repo.dir, tempDir('finish-host'));
  await instance.emit('session_start');
  return instance;
};
