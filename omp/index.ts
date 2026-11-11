import enterExtension from '../src/omp-enter.ts';
import type { EnterExtensionAPI } from '../src/omp-enter.ts';
import finishExtension from '../src/omp-finish.ts';
import type { FinishExtensionAPI } from '../src/omp-finish-types.ts';

/** Registers the delivery finish lifecycle and `worktree_enter` in each omp session. */
export default function ternWorktreesExtension(pi: FinishExtensionAPI & EnterExtensionAPI): void {
  finishExtension(pi);
  enterExtension(pi);
}
