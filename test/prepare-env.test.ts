import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { main } from '../src/cli.ts';
import { must } from '../src/proc.ts';
import type { WorktreeConfig } from '../src/worktree-config.ts';
import { tmpRepo, useGithubOrigin, useSandbox } from './helpers.ts';

const configure = (root: string, value: Partial<WorktreeConfig>): void => {
  mkdirSync(path.join(root, '.tern'), { recursive: true });
  writeFileSync(path.join(root, '.tern/worktree.json'), JSON.stringify(value));
};

describe('prepare and env', () => {
  beforeEach(() => {
    useSandbox();
  });

  it('runs repository setup before user setup with the declared environment', async () => {
    const sandbox = useSandbox();
    const repo = await tmpRepo();
    await useGithubOrigin();
    configure(repo.dir, { env: { WORD: 'repository' }, setup: ['printf "%s\\n" "$WORD" > order'] });
    writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ setup: { 'virtusize/aoyama': ['printf "user\\n" >> order'] } }));
    const result = await main(['prepare', repo.dir]);
    expect(result.code).toBe(0);
    expect(readFileSync(path.join(repo.dir, 'order'), 'utf-8')).toBe('repository\nuser\n');
    expect(JSON.parse(result.stdout)).toMatchObject({
      env: { WORD: 'repository' },
      path: repo.dir,
      repo: 'virtusize/aoyama',
      services: [],
      setup: [{ exitCode: 0 }, { exitCode: 0 }],
      warnings: [],
    });
  });

  it('stops at the first failed setup and reports its exit code and last forty lines', async () => {
    const repo = await tmpRepo();
    configure(repo.dir, { setup: ['i=1; while [ "$i" -le 45 ]; do echo "line-$i"; i=$((i+1)); done; exit 23', 'touch not-run'] });
    const result = await main(['prepare', repo.dir]);
    // SAFETY: a failed prepare command prints the setup failure envelope.
    const parsed = JSON.parse(result.stdout) as { error: { code: string; exitCode: number; output: string } };
    expect(result.code).toBe(1);
    expect(parsed.error).toMatchObject({ code: 'setup_failed', exitCode: 23 });
    expect(parsed.error.output.split('\n')).toHaveLength(40);
    expect(parsed.error.output).toMatch(/^line-6\n/u);
    await expect(must(['sh', '-c', 'test ! -e not-run && echo stopped'], 'git_failed', { cwd: repo.dir })).resolves.toBe('stopped\n');
  });

  it('skips setup with --no-setup', async () => {
    const repo = await tmpRepo();
    configure(repo.dir, { setup: ['exit 19'] });
    const result = await main(['prepare', repo.dir, '--no-setup']);
    expect(result.code).toBe(0);
    // SAFETY: successful prepare prints its setup results.
    const parsed = JSON.parse(result.stdout) as { setup: { command: string; exitCode: number; ms: number }[] };
    expect(parsed.setup).toStrictEqual([]);
  });

  it('quotes single quotes and shell syntax without evaluating literal values', async () => {
    const repo = await tmpRepo();
    configure(repo.dir, { env: { EMPTY: '', VALUE: "it's $(echo wrong) $HOME" } });
    const json = await main(['env', repo.dir]);
    expect(JSON.parse(json.stdout)).toStrictEqual({ env: { EMPTY: '', VALUE: "it's $(echo wrong) $HOME" } });
    const shell = await main(['env', repo.dir, '--shell']);
    expect(shell.stdout).toBe("export EMPTY=''\nexport VALUE='it'\\''s $(echo wrong) $HOME'\n");
    const expanded = await must(['sh', '-c', `${shell.stdout}printf '%s' "$VALUE"`], 'git_failed');
    expect(expanded).toBe("it's $(echo wrong) $HOME");
  });

  it('reads the target linked worktree configuration rather than the main checkout', async () => {
    const repo = await tmpRepo();
    const linked = path.join(repo.dir, '..', 'linked');
    await must(['git', '-C', repo.dir, 'worktree', 'add', '-b', 'linked', linked], 'git_failed');
    configure(repo.dir, { env: { WHERE: 'main' } });
    configure(linked, { env: { WHERE: 'linked' } });
    const result = await main(['env', linked]);
    expect(JSON.parse(result.stdout)).toStrictEqual({ env: { WHERE: 'linked' } });
  });

  it.each(['env', 'prepare'])('rejects missing and extra paths for %s', async command => {
    const repo = await tmpRepo();
    const results = await Promise.all([main([command]), main([command, repo.dir, repo.dir])]);
    expect(results.map(result => result.code)).toStrictEqual([1, 1]);
    expect(results.every(result => result.stdout.includes('bad_args'))).toBeTruthy();
  });

  it('rejects a path outside a repository without running setup', async () => {
    const sandbox = useSandbox();
    const result = await main(['prepare', sandbox.tmp]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('not_a_repo');
  });
});
