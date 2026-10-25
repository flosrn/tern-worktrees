import { parseArgs } from 'node:util';
import { loadConfig, setupCommands } from '../config.ts';
import { worktreeRoot } from '../environment.ts';
import { readOrigin } from '../github.ts';
import { CliError, run as runProcess } from '../proc.ts';
import { repoKey } from '../repo-ref.ts';
import { ensureServices } from '../services.ts';
import { loadWorktreeConfig } from '../worktree-config.ts';

/** Starts shared services, then runs repository and user setup in order. */
export const run = async (args: string[]): Promise<object> => {
  const { positionals, values } = parseArgs({ allowPositionals: true, args, options: { 'no-setup': { type: 'boolean' } } });
  if (positionals.length !== 1) {
    throw new CliError('bad_args', 'prepare requires one worktree path');
  }
  const root = await worktreeRoot(positionals[0]);
  const config = loadWorktreeConfig(root);
  const origin = await readOrigin(root);
  const services = await ensureServices(root, config);
  const commands = [...config.setup, ...(origin.github ? setupCommands(loadConfig(), origin.github) : [])];
  const setup: { command: string; exitCode: number; ms: number }[] = [];
  if (values['no-setup'] !== true) {
    for (const command of commands) {
      const started = performance.now();
      // Setup must finish successfully before the next command starts.
      // eslint-disable-next-line no-await-in-loop
      const result = await runProcess(['sh', '-c', command], { cwd: root, env: config.env });
      setup.push({ command, exitCode: result.status, ms: Math.round(performance.now() - started) });
      if (result.status !== 0) {
        const output = `${result.stdout}${result.stderr}`.trimEnd().split('\n').slice(-40).join('\n');
        throw new CliError('setup_failed', `setup command failed: ${command}`, { command, exitCode: result.status, output });
      }
    }
  }
  return { env: config.env, path: root, repo: origin.github ? repoKey(origin.github) : null, services, setup, warnings: [] };
};
