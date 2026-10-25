import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ensureServices } from '../src/services.ts';
import type { WorktreeConfig } from '../src/worktree-config.ts';
import { tempDir, useSandbox } from './helpers.ts';

interface DockerState {
  containers: Record<string, boolean>;
  calls: string[][];
  fail?: string;
  failStatus?: number;
  silent?: boolean;
  readyFailures?: number;
  concurrentStart?: boolean;
  conflictDelay?: number;
}

let root = '';
let bin = '';
let stateFile = '';
const config: WorktreeConfig = {
  env: {},
  heavy: { slotMemoryGb: 7 },
  services: { DB: { containerPort: 5432, image: 'postgres:17', port: 55_432 } },
  setup: [],
};
// SAFETY: only the fake Docker and typed test fixtures write this state file.
const state = (): DockerState => JSON.parse(readFileSync(stateFile, 'utf-8')) as DockerState;

describe('service preparation', () => {
  beforeEach(() => {
    useSandbox();
    root = tempDir('services');
    bin = tempDir('docker-bin');
    stateFile = path.join(root, 'docker.json');
    writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {} }));
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "git@github.com:MyOwner/MyRepo.git"\n', { mode: 0o755 });
    writeFileSync(
      path.join(bin, 'docker'),
      `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
let status = 0;
let stdout = '';
let stderr = '';
if (state.fail === args[0]) {
  status = state.failStatus ?? 1;
  stderr = state.silent ? '' : state.concurrentStart ? 'Conflict. The container name ' + args[args.indexOf('--name') + 1] + ' is already in use' : 'injected ' + args[0] + ' failure';
  if (args[0] === 'run' && state.concurrentStart && !state.winnerVanishes) state.conflictDelay = 1;
} else if (args[0] === 'inspect') {
  const name = args.at(-1);
  if (Object.hasOwn(state.containers, name)) stdout = String(state.containers[name]);
  else if (state.conflictDelay) { state.conflictDelay--; stdout = 'false'; if (!state.conflictDelay) state.containers[name] = true; }
  else { status = 1; stderr = 'Error: No such object: ' + name; }
} else if (args[0] === 'rm') {
  delete state.containers[args.at(-1)];
} else if (args[0] === 'run') {
  state.containers[args[args.indexOf('--name') + 1]] = true;
  stdout = 'container-id';
} else if (args[0] === 'exec' && state.readyFailures > 0) {
  state.readyFailures--;
  status = 1;
  stderr = 'not ready';
}
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status;
`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', bin);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe(ensureServices, () => {
    it('does not require git or Docker when the repository has no services', async () => {
      vi.stubEnv('PATH', '');
      await expect(ensureServices(root, { ...config, services: {} })).resolves.toStrictEqual([]);
      expect(state().calls).toStrictEqual([]);
    });

    it('starts a lowercase repository-shared container with every configured argument', async () => {
      const configured: WorktreeConfig = {
        ...config,
        services: {
          DB: {
            ...config.services.DB,
            args: ['postgres', '-c', 'fsync=off'],
            env: { EMPTY: '', PASSWORD: '$literal space' },
            memory: '2g',
            tmpfs: '/data:size=1g',
          },
        },
      };
      await expect(ensureServices(root, configured)).resolves.toStrictEqual([{ container: 'tern-wt-myowner-myrepo-db', name: 'DB', status: 'started' }]);
      expect(state().calls).toStrictEqual([
        ['info'],
        ['inspect', '--format', '{{.State.Running}}', 'tern-wt-myowner-myrepo-db'],
        [
          'run',
          '--detach',
          '--restart',
          'unless-stopped',
          '--name',
          'tern-wt-myowner-myrepo-db',
          '--label',
          'tern-wt.service=myowner/myrepo/db',
          '--publish',
          '127.0.0.1:55432:5432',
          '--env',
          'EMPTY=',
          '--env',
          'PASSWORD=$literal space',
          '--tmpfs',
          '/data:size=1g',
          '--memory',
          '2g',
          'postgres:17',
          'postgres',
          '-c',
          'fsync=off',
        ],
      ]);
    });

    it('reuses a running container without updating it when configuration changes', async () => {
      await ensureServices(root, config);
      const before = state();
      writeFileSync(stateFile, JSON.stringify({ ...before, calls: [] }));
      await expect(ensureServices(root, { ...config, services: { DB: { containerPort: 2, image: 'different', port: 1 } } })).resolves.toStrictEqual([
        { container: 'tern-wt-myowner-myrepo-db', name: 'DB', status: 'running' },
      ]);
      expect(state().calls.map(call => call[0])).toStrictEqual(['info', 'inspect']);
    });

    it('removes a stopped container including its anonymous volumes before replacing it', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: { 'tern-wt-myowner-myrepo-db': false } }));
      const [started] = await ensureServices(root, config);
      expect(started.status).toBe('started');
      expect(state().calls.slice(2)).toStrictEqual([
        ['rm', '-fv', 'tern-wt-myowner-myrepo-db'],
        [
          'run',
          '--detach',
          '--restart',
          'unless-stopped',
          '--name',
          'tern-wt-myowner-myrepo-db',
          '--label',
          'tern-wt.service=myowner/myrepo/db',
          '--publish',
          '127.0.0.1:55432:5432',
          'postgres:17',
        ],
      ]);
    });

    it('keeps distinct named services in the same repository separate', async () => {
      await expect(ensureServices(root, { ...config, services: { ...config.services, cache: { containerPort: 6379, image: 'redis', port: 6379 } } })).resolves.toStrictEqual([
        { container: 'tern-wt-myowner-myrepo-db', name: 'DB', status: 'started' },
        { container: 'tern-wt-myowner-myrepo-cache', name: 'cache', status: 'started' },
      ]);
    });

    it('waits for the ready argv both for new and reused services', async () => {
      const readyConfig = { ...config, services: { DB: { ...config.services.DB, ready: ['pg_isready', '-U', 'postgres'] } } };
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, readyFailures: 1 }));
      await ensureServices(root, readyConfig);
      await ensureServices(root, readyConfig);
      expect(state().calls.filter(call => call[0] === 'exec')).toStrictEqual([
        ['exec', 'tern-wt-myowner-myrepo-db', 'pg_isready', '-U', 'postgres'],
        ['exec', 'tern-wt-myowner-myrepo-db', 'pg_isready', '-U', 'postgres'],
        ['exec', 'tern-wt-myowner-myrepo-db', 'pg_isready', '-U', 'postgres'],
      ]);
    });

    it('reports readiness failure after the sixty-second deadline', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, readyFailures: 99 }));
      vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60_000);
      const preparation = ensureServices(root, { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } });
      await expect(preparation).rejects.toMatchObject({ code: 'service_failed' });
      await expect(preparation).rejects.toThrow('60 seconds');
      expect(state().calls.filter(call => call[0] === 'exec')).toHaveLength(1);
    });
  });

  describe('service failures', () => {
    it('reports docker_missing without attempting a start when Docker is absent', async () => {
      rmSync(path.join(bin, 'docker'));
      await expect(ensureServices(root, config)).rejects.toMatchObject({ code: 'docker_missing' });
      expect(state().calls).toStrictEqual([]);
    });

    it.each(['info', 'inspect', 'rm', 'run'])('reports service_failed for a Docker %s failure without continuing', async command => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: { 'tern-wt-myowner-myrepo-db': false }, fail: command }));
      await expect(ensureServices(root, config)).rejects.toMatchObject({ code: 'service_failed', extra: { service: 'DB' }, message: `injected ${command} failure` });
      expect(state().calls.filter(call => call[0] === command)).toHaveLength(1);
    });

    it.each(['info', 'inspect', 'exec', 'run'])('classifies Docker exit 127 from %s', async command => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, fail: command, failStatus: 127 }));
      const configured = { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } };
      await expect(ensureServices(root, configured)).rejects.toMatchObject({
        code: command === 'info' ? 'docker_missing' : 'service_failed',
        message: `injected ${command} failure`,
      });
    });

    it.each([
      ['info', 'docker info exited 1'],
      ['inspect', 'tern-wt-myowner-myrepo-db: docker inspect failed'],
      ['exec', '60 seconds'],
    ])('reports a useful fallback when %s fails without stderr', async (command, message) => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, fail: command, silent: true }));
      vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60_000);
      const configured = { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } };
      const preparation = ensureServices(root, configured);
      await expect(preparation).rejects.toMatchObject({ code: 'service_failed', extra: { service: 'DB' } });
      await expect(preparation).rejects.toThrow(message);
    });

    it.each([
      ['inspect', 'tern-wt-myowner-myrepo-db: docker inspect failed'],
      ['exec', 'tern-wt-myowner-myrepo-db: readiness command exited 127'],
    ])('reports container failure without stderr during %s', async (command, message) => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, fail: command, failStatus: 127, silent: true }));
      await expect(ensureServices(root, { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } })).rejects.toMatchObject({
        code: 'service_failed',
        message,
      });
    });

    it('reuses the container when another prepare wins the creation race', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], concurrentStart: true, containers: {}, fail: 'run' }));
      await expect(ensureServices(root, config)).resolves.toStrictEqual([{ container: 'tern-wt-myowner-myrepo-db', name: 'DB', status: 'running' }]);
      expect(state().calls.map(call => call[0])).toStrictEqual(['info', 'inspect', 'run', 'inspect', 'inspect']);
    });

    it('reports the name conflict when the other prepare never starts its container within sixty seconds', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], concurrentStart: true, containers: {}, fail: 'run', winnerVanishes: true }));
      vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60_000);
      await expect(ensureServices(root, config)).rejects.toThrow('is already in use');
      expect(state().calls.map(call => call[0])).toStrictEqual(['info', 'inspect', 'run', 'inspect']);
    });

    it('stops waiting for the other prepare once cancellation has arrived', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], concurrentStart: true, containers: {}, fail: 'run', winnerVanishes: true }));
      const cancellation = new AbortController();
      const pending = ensureServices(root, config, cancellation.signal);
      await vi.waitFor(
        () => {
          expect(state().calls.filter(call => call[0] === 'inspect')).toHaveLength(2);
        },
        { timeout: 10_000 },
      );
      cancellation.abort('SIGINT');
      await expect(pending).rejects.toThrow('is already in use');
    });

    it('preserves a generic run failure without polling for another prepare', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], concurrentStart: false, containers: {}, fail: 'run' }));
      await expect(ensureServices(root, config)).rejects.toMatchObject({ code: 'service_failed', message: 'injected run failure' });
      expect(state().calls.map(call => call[0])).toStrictEqual(['info', 'inspect', 'run']);
    });

    it('attributes a failure in a later service to that service', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: { 'tern-wt-myowner-myrepo-db': true }, fail: 'run' }));
      await expect(ensureServices(root, { ...config, services: { ...config.services, cache: { containerPort: 6379, image: 'redis', port: 6379 } } })).rejects.toMatchObject({
        code: 'service_failed',
        extra: { service: 'cache' },
      });
    });

    it('rejects a missing or non-GitHub origin before Docker side effects', async () => {
      writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "https://example.com/owner/repo.git"\n', { mode: 0o755 });
      await expect(ensureServices(root, config)).rejects.toMatchObject({ code: 'service_failed', extra: { service: 'DB' } });
      expect(state().calls).toStrictEqual([]);
    });
  });

  describe('service cancellation', () => {
    it('stops readiness polling when cancellation arrives', async () => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, readyFailures: 100 }));
      const cancellation = new AbortController();
      const pending = ensureServices(root, { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } }, cancellation.signal);
      await vi.waitFor(
        () => {
          expect(state().calls.some(call => call[0] === 'exec')).toBeTruthy();
        },
        { timeout: 10_000 },
      );
      cancellation.abort('SIGINT');
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
