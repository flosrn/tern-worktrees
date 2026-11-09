import type { ErrorCode } from './proc.ts';

/** GitHub proof that the PR merged with the worktree HEAD. */
export interface FinishPullRequest {
  number: number;
  url: string;
  headRefOid: string;
  mergeCommit: string;
  mergedAt: string;
}

/** A worktree approved for teardown. The main checkout is not a candidate. */
export interface FinishCandidate {
  path: string;
  branch: string;
  head: string;
  pr: FinishPullRequest;
}

/** Stable causes for finish consumers. CLI failures keep their codes. */
export type FinishCauseCode =
  | ErrorCode
  | 'path_identity_changed'
  | 'registration_changed'
  | 'inspection_failed'
  | 'caller_waiting'
  | 'interrupted'
  | 'worker_start_failed'
  | 'teardown_failed'
  | 'retained'
  | 'not_merged'
  | 'active_process';

/** A worktree kept with the condition that prevents teardown. */
export interface FinishKept {
  path: string;
  code: FinishCauseCode;
  detail?: string;
}

/** A read-only Git and Tern plan, saved before approval. */
export interface FinishPlan {
  id: string;
  repo: string;
  current: string | null;
  ready: boolean;
  candidates: FinishCandidate[];
  keep: FinishKept[];
  warnings: string[];
}

export type FinishChoice = 'current' | 'merged' | 'none';
export type FinishStatus = 'planned' | 'armed' | 'declined' | 'running' | 'completed';

/** A durable result. Execution does not add targets to selected. */
export interface FinishState extends FinishPlan {
  status: FinishStatus;
  selected: string[];
  removed: { path: string; branchDeleted: boolean; closedBlocks: number[] }[];
  errors: FinishKept[];
}

/** The response to a recorded approval or refusal. */
export interface FinishArmed {
  id: string;
  status: 'armed' | 'declined';
  selected: string[];
}
