import type { FinishCauseCode, FinishKept } from './finish-types.ts';
import { isString } from './json.ts';
import { CliError } from './proc.ts';

/** The most files a `dirty_worktree` detail names. The teardown toast in `window.luau` shows as many and selects them the same way. */
const MAX_LISTED_FILES = 10;

/**
 * The message of `error`. When it carries the `changes` and `hardToRebuild` of a `dirty_worktree`, the message is followed by `: ` and at
 * most {@link MAX_LISTED_FILES} of those files. The selection puts hard-to-rebuild files first and fills the remaining positions with changes.
 * The changes are written before the `!! <path>` entries, and `and <n> more` counts the files left out. Other errors, and a refusal without
 * files, keep the message alone.
 */
const keptDetail = (error: Error): string => {
  if (!(error instanceof CliError)) {
    return error.message;
  }
  const { changes: changed, hardToRebuild } = error.extra;
  const changes = Array.isArray(changed) ? changed.filter(isString) : [];
  const ignored = Array.isArray(hardToRebuild) ? hardToRebuild.filter(isString).map(file => `!! ${file}`) : [];
  const ignoredShown = Math.min(ignored.length, MAX_LISTED_FILES);
  const changesShown = Math.min(changes.length, MAX_LISTED_FILES - ignoredShown);
  const shown = [...changes.slice(0, changesShown), ...ignored.slice(0, ignoredShown)];
  const omitted = changes.length + ignored.length - shown.length;
  if (omitted > 0) {
    shown.push(`and ${omitted} more`);
  }
  return shown.length === 0 ? error.message : `${error.message}: ${shown.join(', ')}`;
};

/** The finish cause of the worktree at `target` for a thrown `error`: its CLI code, else `fallback`, with the files a `dirty_worktree` names. */
export const keptFor = (target: string, error: Error | string, fallback: FinishCauseCode): FinishKept => ({
  code: error instanceof CliError ? error.code : fallback,
  detail: error instanceof Error ? keptDetail(error) : error,
  path: target,
});
