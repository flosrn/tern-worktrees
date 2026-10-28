import type { CleanLinks } from './clean-linked.ts';
import type { CleanProcess, ResourcePlan } from './clean-resources.ts';
import type { Worktree } from './git.ts';
import type { TernListing } from './tern.ts';

interface Kept {
  kind: string;
  id: string;
  reason: string;
}

/** A removal decision that needs a durable recovery copy. */
export interface RemovalDetail {
  kind: 'worktree' | 'branch';
  id: string;
  reason: string;
  recovery: true;
  recoveryPath?: string;
}

/** The clean command output, with the original removal arrays and additive recovery details. */
export interface CleanPlan {
  repo: string;
  default: string;
  remove: { worktrees: string[]; branches: string[]; processes: CleanProcess[]; containers: string[]; paths: string[] };
  removalDetails?: RemovalDetail[];
  keep: Kept[];
  warnings: string[];
  applied?: true;
}

/** The tips sampled before the plan makes its removal decisions. */
export interface PlannedHeads {
  branches: Map<string, string>;
  worktrees: Map<string, string>;
}

/** Evidence shared by inspection, recovery and guarded removal in one invocation. */
export interface PlanContext {
  result: CleanPlan;
  heads: PlannedHeads;
  listing: TernListing | null;
  entries: Worktree[];
  paths: string[];
  prunableWorktrees: string[];
  resources: ResourcePlan;
  cwd: string;
  safeBranches: Set<string>;
  branchReasons: Map<string, string>;
  links: CleanLinks;
  proven: Set<string>;
  local: Set<string>;
  details: RemovalDetail[];
  defaultTree: string | null;
}
