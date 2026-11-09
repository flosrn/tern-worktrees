import type { FinishChoice, FinishPlan } from './finish-types.ts';

export interface FinishSchema {
  optional: () => FinishSchema;
}

/** Schema methods supplied by the host. */
export interface FinishSchemas {
  string: () => FinishSchema;
  enum: (values: [string, ...string[]]) => FinishSchema;
  array: (item: FinishSchema) => FinishSchema;
  object: (properties: Record<string, FinishSchema>) => FinishSchema;
}

export interface FinishExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface FinishToolParams {
  action?: string;
  owned?: string[];
  retained?: string[];
  workflow?: string;
}

export interface FinishToolResult {
  content: { type: 'text'; text: string }[];
  details: FinishToolParams;
  isError?: boolean;
}

interface FinishPhases {
  armed: true;
  asking: true;
  closed: true;
  offered: true;
}

export interface PendingFinish {
  plan: FinishPlan;
  form: string;
  /** Target sets shown by each alternative, frozen before asking. */
  approved: Record<FinishChoice, string[]>;
  status: keyof FinishPhases;
  callId?: string;
  selected?: string[];
  reported?: boolean;
}

export interface SessionFinish {
  owned: string[];
  retained?: string[];
  scoped?: boolean;
  orchestrate?: boolean;
  requested: boolean;
  worker?: boolean;
  pending?: PendingFinish;
  /** Merged path/HEAD pairs from the session baseline and subsequent plan results. */
  baselineMerged?: string[];
  sawTool?: boolean;
  /** A failed plan check needs explicit ready before it can run again. */
  automaticCheckFailed?: boolean;
}

export interface FinishEntry {
  type?: string;
  customType?: string;
  data?: SessionFinish;
}

export interface FinishEvent {
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  input?: object;
  details?: object;
  content?: { type: string; text?: string }[];
  prompt?: string;
  reason?: string;
  message?: { role?: string; stopReason?: string; content?: { type: string; text?: string }[] };
}

export interface FinishHookResult {
  block?: boolean;
  reason?: string;
  continue?: boolean;
  additionalContext?: string;
}

export interface FinishAsyncSnapshot {
  running: object[];
  recent: object[];
  delivery: { queued: number; delivering: boolean; pendingJobIds: string[] };
}

export interface FinishContext {
  cwd: string;
  hasUI: boolean;
  agent?: { kind: string };
  ui?: { notify: (message: string, type: 'info' | 'warning' | 'error') => void };
  sessionManager: {
    getBranch: () => FinishEntry[];
    getSessionId: () => string;
  };
  getAsyncJobSnapshot: () => FinishAsyncSnapshot | null;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
}

export type FinishHookResponse = FinishHookResult | undefined;
export type FinishHandler = (event: FinishEvent, ctx: FinishContext) => FinishHookResponse | Promise<FinishHookResponse>;

export interface FinishTool {
  name: string;
  label: string;
  description: string;
  parameters: FinishSchema;
  loadMode: 'essential';
  execute: (
    id: string,
    params: FinishToolParams,
    signal: AbortSignal | undefined,
    onUpdate: ((result: FinishToolResult) => void) | undefined,
    ctx: FinishContext,
  ) => Promise<FinishToolResult> | FinishToolResult;
}

export interface FinishToolSource {
  name: string;
  sourceInfo?: { source?: string; path?: string; scope?: string; origin?: string };
}

/** Structural subset of the omp 18.18 extension interface. No runtime host import. */
export interface FinishExtensionAPI {
  zod: FinishSchemas;
  on: (name: string, handler: FinishHandler) => void;
  registerTool: (tool: FinishTool) => void;
  appendEntry: (customType: string, data: SessionFinish) => void;
  exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<FinishExecResult>;
  getActiveTools: () => string[];
  getAllTools: () => FinishToolSource[];
}
