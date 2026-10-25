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
  stderr = state.silent ? '' : 'injected ' + args[0] + ' failure';
} else if (args[0] === 'inspect') {
  const name = args.at(-1);
  if (Object.hasOwn(state.containers, name)) stdout = String(state.containers[name]);
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

    it('reports docker_missing without attempting a start when Docker is absent', async () => {
      rmSync(path.join(bin, 'docker'));
      await expect(ensureServices(root, config)).rejects.toMatchObject({ code: 'docker_missing' });
      expect(state().calls).toStrictEqual([]);
    });

    it.each(['info', 'inspect', 'rm', 'run'])('reports service_failed for a Docker %s failure without continuing', async command => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: { 'tern-wt-myowner-myrepo-db': false }, fail: command }));
      await expect(ensureServices(root, config)).rejects.toMatchObject({ code: 'service_failed', extra: { service: 'DB' }, message: `injected ${command} failure` });
      expect(state().calls.at(-1)?.[0]).toBe(command);
    });

    it.each(['info', 'inspect', 'exec'])('reports docker_missing when Docker disappears during %s', async command => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, fail: command, failStatus: 127 }));
      const configured = { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } };
      await expect(ensureServices(root, configured)).rejects.toMatchObject({ code: 'docker_missing', message: `injected ${command} failure` });
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

    it.each(['inspect', 'exec'])('reports missing Docker without stderr during %s', async command => {
      writeFileSync(stateFile, JSON.stringify({ calls: [], containers: {}, fail: command, failStatus: 127, silent: true }));
      await expect(ensureServices(root, { ...config, services: { DB: { ...config.services.DB, ready: ['check'] } } })).rejects.toMatchObject({
        code: 'docker_missing',
        message: 'docker is not installed',
      });
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
});
