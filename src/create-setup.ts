import { loadConfig, setupCommands } from './config.ts';
import { worktreeEnvironment } from './environment.ts';
import { ensureServices } from './services.ts';
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

/** Loads a new worktree's environment and starts shared services only when it will open a tab. */
export const prepareSetup = async (dir: string, created: boolean, noTab: boolean): Promise<WorktreeConfig | null> => {
  if (!created) {
    return null;
  }
  const config = await worktreeEnvironment(dir);
  if (!noTab) {
    await ensureServices(dir, config);
  }
  return config;
};
