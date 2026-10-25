import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, fstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CliError, must, run, runInherited } from '../src/proc.ts';
import { REPO_DIR, tempDir, useSandbox } from './helpers.ts';

describe('proc', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(run, () => {
    it('collects the exit status and both streams', async () => {
      await expect(run(['sh', '-c', 'printf out; printf err >&2; exit 3'])).resolves.toStrictEqual({ status: 3, stderr: 'err', stdout: 'out' });
    });

    it('runs in cwd with extra env on top of process.env', async () => {
      const dir = tempDir('proc');
      await expect(run(['sh', '-c', 'printf "%s %s %s" "$PWD" "$EXTRA" "$GIT_AUTHOR_NAME"'], { cwd: dir, env: { EXTRA: 'yes' } })).resolves.toStrictEqual({
        status: 0,
        stderr: '',
        stdout: `${dir} yes Test`,
      });
    });

    it('reports a program that does not start as status 127', async () => {
      const result = await run(['/nonexistent/program']);
      expect(result).toStrictEqual({ status: 127, stderr: 'Error: spawn /nonexistent/program ENOENT', stdout: '' });
    });

    it('gives the program no stdin, so a reader sees end of file', async () => {
      await expect(run(['cat'])).resolves.toStrictEqual({ status: 0, stderr: '', stdout: '' });
    });

    it('keeps multibyte text whole', async () => {
      await expect(run(['sh', '-c', 'printf "\\303"; sleep 0.05; printf "\\251 ok"'])).resolves.toStrictEqual({ status: 0, stderr: '', stdout: 'é ok' });
    });

    it('reports a process killed by a signal as status 1', async () => {
      await expect(run(['sh', '-c', 'printf partial; kill -9 $$'])).resolves.toStrictEqual({ status: 1, stderr: '', stdout: 'partial' });
    });
  });

  describe(must, () => {
    it('returns stdout on success', async () => {
      await expect(must(['sh', '-c', 'printf "$EXTRA"'], 'git_failed', { env: { EXTRA: 'ok' } })).resolves.toBe('ok');
    });

    it('runs in opts.cwd', async () => {
      const dir = tempDir('must');
      await expect(must(['pwd'], 'git_failed', { cwd: dir })).resolves.toBe(`${dir}\n`);
    });

    it('throws the code with the trimmed stderr', async () => {
      const failing = must(['sh', '-c', 'echo "  bad thing  " >&2; exit 2'], 'gh_failed');
      await expect(failing).rejects.toThrow(CliError);
      await expect(failing).rejects.toMatchObject({ code: 'gh_failed', extra: {}, message: 'bad thing', name: 'CliError' });
    });

    it('names the program and status without stderr', async () => {
      await expect(must(['sh', '-c', 'exit 4'], 'tern_failed')).rejects.toMatchObject({ code: 'tern_failed', message: 'sh exited 4' });
    });
  });

  describe(CliError, () => {
    it('carries extra fields', () => {
      const error = new CliError('path_conflict', 'taken', { path: '/x' });
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: 'path_conflict', extra: { path: '/x' }, message: 'taken' });
    });
  });

  describe(runInherited, () => {
    it('passes both streams to the caller of a separate process', () => {
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '-e',
          "import { runInherited } from './src/proc.ts'; process.exitCode = await runInherited(['sh', '-c', 'printf inherited-out; printf inherited-err >&2'])",
        ],
        { cwd: REPO_DIR, encoding: 'utf-8' },
      );
      expect(result).toMatchObject({ status: 0, stderr: 'inherited-err', stdout: 'inherited-out' });
      expect(result.stdout).not.toBe('');
      expect(result.stderr).not.toBe('');
    });

    it('gives the child the caller standard streams, not pipes', async () => {
      const marker = path.join(tempDir('proc-stdio'), 'fds');
      const stdout = fstatSync(1);
      const stderr = fstatSync(2);
      const status = await runInherited([
        process.execPath,
        '-e',
        'const fs = require("node:fs"); const out = fs.fstatSync(1); const err = fs.fstatSync(2); fs.writeFileSync(process.argv[1], out.dev + ":" + out.ino + String.fromCharCode(10) + err.dev + ":" + err.ino)',
        marker,
      ]);
      expect(status).toBe(0);
      expect(readFileSync(marker, 'utf-8')).toBe(`${stdout.dev}:${stdout.ino}\n${stderr.dev}:${stderr.ino}`);
    });

    it('keeps the abort handler while the child runs and removes it afterwards', async () => {
      const ready = path.join(tempDir('proc-abort'), 'ready');
      const cancellation = new AbortController();
      const execution = runInherited([process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {},1000)", ready], {
        signal: cancellation.signal,
      });
      while (!existsSync(ready)) {
        // Wait until the child publishes readiness.
        // oxlint-disable-next-line no-await-in-loop
        await delay(10);
      }
      expect(getEventListeners(cancellation.signal, 'abort')).toHaveLength(1);
      cancellation.abort('SIGTERM');
      await expect(execution).resolves.toBe(143);
      expect(getEventListeners(cancellation.signal, 'abort')).toHaveLength(0);
    });

    it('writes the spawn error before reporting exit 127', async () => {
      const missing = path.join(tempDir('proc-spawn'), 'missing');
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await expect(runInherited([missing])).resolves.toBe(127);
        expect(stderr).toHaveBeenCalledExactlyOnceWith(`Error: spawn ${missing} ENOENT\n`);
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
