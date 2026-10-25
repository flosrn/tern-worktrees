import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CliError } from '../src/proc.ts';
import { loadWorktreeConfig } from '../src/worktree-config.ts';
import { tempDir, useSandbox } from './helpers.ts';

let root = '';
let file = '';

describe('repository configuration', () => {
  beforeEach(() => {
    useSandbox();
    root = tempDir('worktree-config');
    mkdirSync(path.join(root, '.tern'));
    file = path.join(root, '.tern', 'worktree.json');
  });

  describe(loadWorktreeConfig, () => {
    it('provides independent defaults for absent and empty files', () => {
      const config = loadWorktreeConfig(root);
      expect(config).toStrictEqual({ env: {}, heavy: { slotMemoryGb: 7 }, services: {}, setup: [] });
      config.setup.push('changed');
      config.heavy.slotMemoryGb = 1;
      writeFileSync(file, '{}');
      expect(loadWorktreeConfig(root)).toStrictEqual({ env: {}, heavy: { slotMemoryGb: 7 }, services: {}, setup: [] });
    });

    it('reads all service options and expands only leading home paths in worktree variables', () => {
      vi.stubEnv('HOME', '/home/test');
      const service = {
        args: ['postgres', '-c', 'fsync=off'],
        containerPort: 5432,
        env: { HOME_PATH: '~/inside-container', POSTGRES_PASSWORD: '$literal' },
        image: 'postgres:17',
        memory: '2g',
        port: 55_432,
        ready: ['pg_isready', '-U', 'postgres'],
        tmpfs: '/var/lib/postgresql/data:rw,size=1g',
      };
      writeFileSync(
        file,
        JSON.stringify({
          env: { CACHE: '~/cache', EMPTY: '', EXACT: '~', LITERAL: '$HOME/$USER', OTHER: '~other/cache' },
          heavy: { slotMemoryGb: 2.5 },
          services: { db: service },
          setup: ['vp install', 'echo "$HOME"'],
        }),
      );
      expect(loadWorktreeConfig(root)).toStrictEqual({
        env: { CACHE: '/home/test/cache', EMPTY: '', EXACT: '~', LITERAL: '$HOME/$USER', OTHER: '~other/cache' },
        heavy: { slotMemoryGb: 2.5 },
        services: { db: service },
        setup: ['vp install', 'echo "$HOME"'],
      });
    });

    it('accepts partial heavy settings and a minimal service', () => {
      writeFileSync(file, JSON.stringify({ heavy: {}, services: { redis: { containerPort: 65_535, image: 'redis:7', port: 1 } } }));
      expect(loadWorktreeConfig(root)).toStrictEqual({
        env: {},
        heavy: { slotMemoryGb: 7 },
        services: { redis: { containerPort: 65_535, image: 'redis:7', port: 1 } },
        setup: [],
      });
    });

    it.each([
      [null, '(root)'],
      [[], '(root)'],
      [{ unknown: true }, 'unknown'],
      [{ setup: 'vp install' }, 'setup'],
      [{ setup: [1] }, 'setup'],
      [{ setup: [''] }, 'setup'],
      [{ setup: ['   '] }, 'setup'],
      [{ setup: ['echo a\necho b'] }, 'setup'],
      [{ setup: ['echo a\recho b'] }, 'setup'],
      [{ env: [] }, 'env'],
      [{ env: { X: 1 } }, 'env.X'],
      [{ env: { 'BAD-NAME': 'x' } }, 'env.BAD-NAME'],
      [{ heavy: null }, 'heavy'],
      [{ heavy: [] }, 'heavy'],
      [{ heavy: { other: 3 } }, 'heavy.other'],
      [{ heavy: { slotMemoryGb: 0 } }, 'heavy.slotMemoryGb'],
      [{ heavy: { slotMemoryGb: -1 } }, 'heavy.slotMemoryGb'],
      [{ heavy: { slotMemoryGb: '7' } }, 'heavy.slotMemoryGb'],
      [{ services: [] }, 'services'],
      [{ services: { 'bad/name': {} } }, 'services.bad/name'],
      [{ services: { db: null } }, 'services.db'],
      [{ services: { db: { containerPort: 5432, extra: 1, image: 'postgres', port: 5432 } } }, 'services.db.extra'],
    ])('rejects invalid configuration %j at its key', (value, key) => {
      writeFileSync(file, JSON.stringify(value));
      let thrown: unknown;
      try {
        loadWorktreeConfig(root);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(thrown).toMatchObject({ code: 'worktree_config_invalid' });
      // SAFETY: the previous assertion checks the thrown value is a CliError.
      expect((thrown as CliError).message).toContain(`${file}: ${key}:`);
    });

    it.each([
      ['image', undefined],
      ['image', ''],
      ['image', 1],
      ['port', undefined],
      ['port', 0],
      ['port', 65_536],
      ['port', 1.5],
      ['port', '5432'],
      ['containerPort', 0],
      ['containerPort', 65_536],
      ['containerPort', 3.5],
      ['env', null],
      ['env', { PASSWORD: false }],
      ['env', { 'BAD=KEY': 'value' }],
      ['args', 'redis-server'],
      ['args', [1]],
      ['tmpfs', []],
      ['tmpfs', ''],
      ['memory', 2],
      ['memory', ''],
      ['ready', 'pg_isready'],
      ['ready', []],
      ['ready', ['']],
      ['ready', [1]],
    ])('rejects service %s = %j', (key, value) => {
      writeFileSync(file, JSON.stringify({ services: { db: { containerPort: 5432, image: 'postgres', port: 5432, [key]: value } } }));
      expect(() => loadWorktreeConfig(root)).toThrow(CliError);
      expect(() => loadWorktreeConfig(root)).toThrow(`${file}: services.db.${key}`);
    });

    it('rejects service names which would share a lowercased container', () => {
      const service = { containerPort: 6379, image: 'redis', port: 6379 };
      writeFileSync(file, JSON.stringify({ services: { Cache: service, cache: service } }));
      expect(() => loadWorktreeConfig(root)).toThrow(`${file}: services.cache:`);
    });

    it('reports malformed JSON and unreadable files with the filename', () => {
      writeFileSync(file, '{broken');
      expect(() => loadWorktreeConfig(root)).toThrow(`${file}: (root): invalid JSON:`);
    });

    it('reports a directory instead of a configuration file', () => {
      mkdirSync(file);
      expect(() => loadWorktreeConfig(root)).toThrow(`${file}: (root): cannot read:`);
    });
  });
});
