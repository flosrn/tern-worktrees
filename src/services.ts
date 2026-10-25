/* oxlint-disable no-await-in-loop -- Docker lifecycle steps and readiness retries must complete in order. */
import { setTimeout as delay } from 'node:timers/promises';
import { readOrigin } from './github.ts';
import { CliError, run } from './proc.ts';
import { repoKey } from './repo-ref.ts';
import type { Service, WorktreeConfig } from './worktree-config.ts';

/** The shared container that preparation started or reused for a named service. */
export interface ServiceResult {
  name: string;
  container: string;
  status: 'started' | 'running';
}

const docker = async (args: string[]): Promise<string> => {
  const result = await run(['docker', ...args]);
  if (result.status !== 0) {
    const code = args[0] === 'info' && result.status === 127 ? 'docker_missing' : 'service_failed';
    throw new CliError(code, result.stderr.trim() || `docker ${args[0]} exited ${result.status}`);
  }
  return result.stdout;
};

const waitUntilReady = async (container: string, command: string[], signal?: AbortSignal): Promise<void> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    signal?.throwIfAborted();
    const result = await run(['docker', 'exec', container, ...command]);
    if (result.status === 0) {
      return;
    }
    if (result.status === 127) {
      throw new CliError('service_failed', result.stderr.trim() || `${container}: readiness command exited 127`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const detail = result.stderr.trim();
      throw new CliError('service_failed', `${container}: readiness command did not succeed within 60 seconds: ${detail}`);
    }
    await delay(Math.min(1000, remaining), undefined, { signal });
  }
};

const startService = async (container: string, label: string, service: Service): Promise<void> => {
  const args = [
    'run',
    '--detach',
    '--restart',
    'unless-stopped',
    '--name',
    container,
    '--label',
    `tern-wt.service=${label}`,
    '--publish',
    `127.0.0.1:${service.port}:${service.containerPort}`,
  ];
  for (const [key, value] of Object.entries(service.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  if (service.tmpfs !== undefined) {
    args.push('--tmpfs', service.tmpfs);
  }
  if (service.memory !== undefined) {
    args.push('--memory', service.memory);
  }
  args.push(service.image, ...(service.args ?? []));
  await docker(args);
};

const startOrReuseService = async (container: string, label: string, service: Service, signal?: AbortSignal): Promise<boolean> => {
  try {
    await startService(container, label, service);
    return false;
  } catch (error) {
    if (!(error instanceof CliError) || !/Conflict/u.test(error.message)) {
      throw error;
    }
    const deadline = Date.now() + 60_000;
    for (;;) {
      const concurrent = await run(['docker', 'inspect', '--format', '{{.State.Running}}', container]);
      if (concurrent.stdout.trim() === 'true') {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted === true) {
        throw error;
      }
      await delay(Math.min(250, remaining));
    }
  }
};

const ensureService = async (container: string, label: string, service: Service, signal?: AbortSignal): Promise<'started' | 'running'> => {
  const inspected = await run(['docker', 'inspect', '--format', '{{.State.Running}}', container]);
  if (inspected.status !== 0 && !/no such (?:object|container)/iu.test(inspected.stderr)) {
    throw new CliError('service_failed', inspected.stderr.trim() || `${container}: docker inspect failed`);
  }
  let running = inspected.status === 0 && inspected.stdout.trim() === 'true';
  if (!running) {
    if (inspected.status === 0) {
      await docker(['rm', '-fv', container]);
    }
    running = await startOrReuseService(container, label, service, signal);
  }
  if (service.ready !== undefined) {
    await waitUntilReady(container, service.ready, signal);
  }
  return running ? 'running' : 'started';
};

/** Starts repository-shared Docker services and keeps running containers unchanged. */
export const ensureServices = async (root: string, config: WorktreeConfig, signal?: AbortSignal): Promise<ServiceResult[]> => {
  const entries = Object.entries(config.services);
  if (entries.length === 0) {
    return [];
  }
  let [[currentService]] = entries;
  try {
    const origin = await readOrigin(root);
    if (origin.github === null) {
      throw new CliError('service_failed', `${root}: services require a GitHub origin with an owner and repository name`);
    }
    const repository = repoKey(origin.github);
    signal?.throwIfAborted();
    await docker(['info']);
    const results: ServiceResult[] = [];
    for (const [name, service] of entries) {
      signal?.throwIfAborted();
      currentService = name;
      const container = `tern-wt-${origin.github.owner}-${origin.github.name}-${name}`.toLowerCase();
      const status = await ensureService(container, `${repository}/${name.toLowerCase()}`, service, signal);
      signal?.throwIfAborted();
      results.push({ container, name, status });
    }
    return results;
  } catch (error) {
    if (error instanceof CliError && error.code === 'service_failed') {
      throw new CliError(error.code, error.message, { ...error.extra, service: currentService });
    }
    throw error;
  }
};
