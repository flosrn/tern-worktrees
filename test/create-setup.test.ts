import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import type { WorktreeConfig } from '../src/worktree-config.ts';
import { cliJson, contract, FIXTURE_BIN, git, logGitCalls, managedPath, readLog, tempDir, ternLog, tmpRepo, useGithubOrigin, useOmp, useSandbox, writeTernLs } from './helpers.ts';
import type { RepoFixture, Sandbox } from './helpers.ts';

const LINE = 'npm ci && npm test';

const WAIT = 'wait 42 --until prompt --timeout 30';

let sandbox: Sandbox;
let repo: RepoFixture;
let originShimDir: string;

const writeSetup = (setup: Record<string, string[]>): void => {
  writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ setup }));
};

const setupCalls = (): string[] => ternLog().filter(line => /^(?:run|wait) /u.test(line));

const writeRepositoryConfig = async (config: Partial<WorktreeConfig>): Promise<void> => {
  mkdirSync(path.join(repo.dir, '.tern'), { recursive: true });
  writeFileSync(path.join(repo.dir, '.tern', 'worktree.json'), JSON.stringify(config));
  await git(repo.dir, 'add', '.tern/worktree.json');
  await git(repo.dir, 'commit', '--quiet', '-m', 'Configure worktree environment');
  await git(repo.dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature/x');
};

describe('create command', () => {
  beforeEach(async () => {
    sandbox = useSandbox();
    repo = await tmpRepo('aoyama');
    await repo.pushBranch('feature/x');
    originShimDir = await useGithubOrigin();
    writeSetup({ 'virtusize/aoyama': ['npm ci', 'npm test'] });
    writeTernLs({ work: [repo.dir] });
  });

  describe('setup commands', () => {
    it('types the setup commands into the new worktree tab at the prompt', async () => {
      const result = await run(['--repo', repo.dir, '--branch', 'feature/x']);
      expect(result).toMatchObject({ setup: { line: LINE, typed: true }, status: 'created', tab: { block: 42, opened: true, session: 'work' }, warnings: [] });
      expect(Object.keys(result)).toStrictEqual(['branch', 'carried', 'owner', 'path', 'repo', 'setup', 'status', 'tab', 'warnings']);
      expect(ternLog()).toStrictEqual(['ls --json', `new tab work --cwd ${managedPath('feature-x')} --json`, 'rename 42 feature/x --json', WAIT, `run 42 ${LINE}`]);
    });
  });

  describe('repository environment', () => {
    it('loads the created branch configuration and runs repository setup before options setup', async () => {
      await writeRepositoryConfig({ env: { APP_MODE: 'worktree' }, setup: ['npm run prepare'] });
      writeFileSync(path.join(repo.dir, '.tern', 'worktree.json'), JSON.stringify({ setup: ['wrong checkout'] }));
      const line = 'eval "$(tern-wt env . --shell)" && npm run prepare && npm ci && npm test';
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ setup: { line, typed: true }, warnings: [] });
      expect(setupCalls()).toStrictEqual([WAIT, `run 42 ${line}`]);
    });

    it('returns repository setup without requiring a GitHub origin or environment variables', async () => {
      await writeRepositoryConfig({ setup: ['npm run prepare'] });
      vi.stubEnv(
        'PATH',
        process.env.PATH?.split(':')
          .filter(dir => dir !== originShimDir)
          .join(':'),
      );
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({
        setup: { line: 'npm run prepare', typed: false },
        tab: null,
        warnings: [],
      });
      expect(ternLog()).toStrictEqual([]);
    });

    it.each<WorktreeConfig['services']>([{}, { db: { containerPort: 5432, image: 'postgres:17', port: 5433 } }])(
      'returns environment activation without opening a tab or starting services %j',
      async services => {
        writeSetup({});
        await writeRepositoryConfig({ env: { APP_MODE: 'worktree' }, services });
        const shimDir = tempDir('docker-shim');
        const log = path.join(shimDir, 'docker.log');
        writeFileSync(path.join(shimDir, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
        vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
        await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({
          setup: { line: 'eval "$(tern-wt env . --shell)"', typed: false },
          tab: null,
          warnings: [],
        });
        expect(existsSync(log)).toBeFalsy();
        expect(ternLog()).toStrictEqual([]);
      },
    );

    it('makes shared services ready before opening the new worktree tab', async () => {
      await writeRepositoryConfig({ services: { db: { containerPort: 5432, image: 'postgres:17', port: 5433, ready: ['pg_isready'] } } });
      const shimDir = tempDir('docker-shim');
      const ready = path.join(shimDir, 'ready');
      const early = path.join(shimDir, 'opened-before-ready');
      writeFileSync(path.join(shimDir, 'docker'), `#!/bin/sh\nif [ "$1" = exec ]; then touch '${ready}'; fi\nexit 0\n`, { mode: 0o755 });
      const tern = path.join(shimDir, 'tern');
      writeFileSync(tern, `#!/bin/sh\nif [ "$1" = new ] && [ ! -f '${ready}' ]; then touch '${early}'; fi\nexec '${path.join(FIXTURE_BIN, 'tern')}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
      vi.stubEnv('TERN_BIN', tern);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ status: 'created', tab: { opened: true }, warnings: [] });
      expect(existsSync(ready)).toBeTruthy();
      expect(existsSync(early)).toBeFalsy();
      expect(ternLog()).toContain(`new tab work --cwd ${managedPath('feature-x')} --json`);
    });

    it('does not open a tab when shared services cannot be prepared', async () => {
      await writeRepositoryConfig({ services: { db: { containerPort: 5432, image: 'postgres:17', port: 5433 } } });
      const shimDir = tempDir('docker-shim');
      writeFileSync(path.join(shimDir, 'docker'), '#!/bin/sh\necho "Docker unavailable" >&2\nexit 1\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).rejects.toThrow('Docker unavailable');
      expect(ternLog()).toStrictEqual([]);
    });
  });

  describe('options setup commands', () => {
    it('leaves the setup commands to the caller with --no-tab', async () => {
      await expect(cliJson(['create', '--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toStrictEqual(
        contract('create-setup-no-tab', { branch: 'feature/x', repo: repo.dir, worktree: managedPath('feature-x') }),
      );
      expect(ternLog()).toStrictEqual([]);
    });

    it('matches a mixed-case origin URL', async () => {
      await useGithubOrigin('git@github.com:Virtusize/AOYAMA.git');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ setup: { line: LINE, typed: true } });
      expect(setupCalls()).toStrictEqual([WAIT, `run 42 ${LINE}`]);
    });

    it('gives no setup commands to a reused worktree', async () => {
      await run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab']);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ setup: null, status: 'reused', tab: { opened: true } });
      expect(setupCalls()).toStrictEqual([]);
    });

    it('gives no setup commands to a relocated worktree', async () => {
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', path.join(tempDir('elsewhere'), 'wt'), 'origin/feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--relocate'])).resolves.toMatchObject({ setup: null, status: 'relocated', tab: { opened: true } });
      expect(setupCalls()).toStrictEqual([]);
    });

    it('gives no setup commands to an omp-owned worktree', async () => {
      const base = tempDir('omp-wt');
      useOmp({ base, clone: false });
      const ompOwned = path.join(base, 'feature-x-abc1234');
      await git(repo.dir, 'worktree', 'add', '--quiet', '--track', '-b', 'feature/x', ompOwned, 'origin/feature/x');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ path: ompOwned, setup: null, status: 'reused', tab: { opened: true } });
      expect(setupCalls()).toStrictEqual([]);
    });

    it.each([[{ 'other/repo': ['npm ci'] }], [{ 'virtusize/aoyama': [] }]])('gives no setup commands to a repository without commands in %j', async setup => {
      writeSetup(setup);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ setup: null, status: 'created', tab: { opened: true } });
      expect(setupCalls()).toStrictEqual([]);
    });

    it('gives no setup commands to a repository without a GitHub origin', async () => {
      vi.stubEnv(
        'PATH',
        process.env.PATH?.split(':')
          .filter(dir => dir !== originShimDir)
          .join(':'),
      );
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ setup: null, status: 'created', tab: { opened: true } });
      expect(setupCalls()).toStrictEqual([]);
    });

    it('keeps the worktree and warns when the shell shows no prompt', async () => {
      vi.stubEnv('FAKE_TERN_WAIT_STATUS', '124');
      await expect(cliJson(['create', '--repo', repo.dir, '--branch', 'feature/x'])).resolves.toStrictEqual(
        contract('create-setup-no-prompt', { repo: repo.dir, worktree: managedPath('feature-x') }),
      );
      expect(setupCalls()).toStrictEqual([WAIT]);
      expect(existsSync(managedPath('feature-x'))).toBeTruthy();
    });

    it.each([
      ['wait', [WAIT]],
      ['run', [WAIT, `run 42 ${LINE}`]],
    ])('keeps the worktree and warns when tern %s fails', async (verb, calls) => {
      vi.stubEnv('FAKE_TERN_FAIL', verb);
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        setup: { line: LINE, typed: false },
        status: 'created',
        warnings: [`setup not run: fake tern: ${verb} failed`],
      });
      expect(setupCalls()).toStrictEqual(calls);
      expect(existsSync(managedPath('feature-x'))).toBeTruthy();
    });

    it('warns and types nothing when a tab already shows the new worktree', async () => {
      writeTernLs({ work: [repo.dir, path.join(managedPath('feature-x'), 'src')] });
      await expect(cliJson(['create', '--repo', repo.dir, '--branch', 'feature/x'])).resolves.toStrictEqual(
        contract('create-setup-open-before', { repo: repo.dir, worktree: managedPath('feature-x') }),
      );
      expect(setupCalls()).toStrictEqual([]);
    });

    it('gives only the tab warning when the tab does not open', async () => {
      vi.stubEnv('FAKE_TERN_FAIL', 'new');
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({
        setup: { line: LINE, typed: false },
        status: 'created',
        tab: null,
        warnings: ['tab not opened: fake tern: new failed'],
      });
      expect(setupCalls()).toStrictEqual([]);
    });
  });

  describe('origin', () => {
    it('reads the origin once for a created worktree', async () => {
      const log = await logGitCalls();
      await expect(run(['--repo', repo.dir, '--branch', 'feature/x'])).resolves.toMatchObject({ setup: { line: LINE }, status: 'created' });
      expect(readLog(log).filter(line => line.includes('remote get-url origin'))).toHaveLength(1);
    });
  });
});
