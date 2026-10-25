import { loadConfig, setupCommands } from './config.ts';
import type { Origin } from './github.ts';
import type { WorktreeConfig } from './worktree-config.ts';

/** Joins environment activation, repository setup and user setup for a new worktree, or gives null when none applies. */
export const setupLine = (origin: Origin, config: WorktreeConfig | null): string | null => {
  if (config === null) {
    return null;
  }
  const commands = [...config.setup, ...(origin.github === null ? [] : setupCommands(loadConfig(), origin.github))];
  if (Object.keys(config.env).length > 0) {
    commands.unshift('eval "$(tern-wt env . --shell)"');
  }
  return commands.length === 0 ? null : commands.join(' && ');
};
