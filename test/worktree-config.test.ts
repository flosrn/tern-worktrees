import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CliError } from '../src/proc.ts';
import { loadWorktreeConfig } from '../src/worktree-config.ts';
import { tempDir, useSandbox } from './helpers.ts';

let root = '';
let file = '';

const thrown = (): CliError => {
  try {
    loadWorktreeConfig(root);
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    return error;
  }
  throw new Error('loadWorktreeConfig did not throw');
};

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
      expect(config).toStrictEqual({ env: {}, heavy: { slotMemoryGb: 7 }, rebuildable: [], services: {}, setup: [] });
      config.setup.push('changed');
      config.rebuildable.push('changed');
      config.heavy.slotMemoryGb = 1;
      writeFileSync(file, '{}');
      expect(loadWorktreeConfig(root)).toStrictEqual({ env: {}, heavy: { slotMemoryGb: 7 }, rebuildable: [], services: {}, setup: [] });
    });

    it('reads all service options and expands only leading home paths in worktree variables', () => {
      vi.stubEnv('HOME', '/home/test');
      const service = {
        args: ['postgres', '-c', 'fsync=off'],
        containerPort: 5432,
        env: { HOME_PATH: '~/inside-container', POSTGRES_PASSWORD: '$literal', TERN_WT_PORT: 'container-only' },
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
        rebuildable: [],
        services: { db: service },
        setup: ['vp install', 'echo "$HOME"'],
      });
    });

    it('accepts partial heavy settings and a minimal service', () => {
      writeFileSync(file, JSON.stringify({ heavy: {}, services: { redis: { containerPort: 65_535, image: 'redis:7', port: 1 } } }));
      expect(loadWorktreeConfig(root)).toStrictEqual({
        env: {},
        heavy: { slotMemoryGb: 7 },
        rebuildable: [],
        services: { redis: { containerPort: 65_535, image: 'redis:7', port: 1 } },
        setup: [],
      });
    });

    it('reads declared rebuildable path segments', () => {
      writeFileSync(file, JSON.stringify({ rebuildable: ['server.log', '.demo'] }));
      expect(loadWorktreeConfig(root).rebuildable).toStrictEqual(['server.log', '.demo']);
    });

    it('reads a configuration linked from outside the checkout unless it declares rebuildable segments', () => {
      const shared = path.join(tempDir('shared-config'), 'worktree.json');
      writeFileSync(shared, JSON.stringify({ setup: ['vp install'] }));
      symlinkSync(shared, file);
      expect(loadWorktreeConfig(root).setup).toStrictEqual(['vp install']);
      writeFileSync(shared, JSON.stringify({ rebuildable: ['server.log'] }));
      expect(thrown()).toMatchObject({ code: 'worktree_config_invalid', message: `${file}: rebuildable: expected a declaration in the main checkout` });
    });

    it('reads rebuildable segments from a configuration linked inside the checkout', () => {
      mkdirSync(path.join(root, 'config'));
      writeFileSync(path.join(root, 'config', 'worktree.json'), JSON.stringify({ rebuildable: ['server.log'] }));
      symlinkSync(path.join('..', 'config', 'worktree.json'), file);
      expect(loadWorktreeConfig(root).rebuildable).toStrictEqual(['server.log']);
    });

    it.each([
      [null, '(root): expected an object'],
      [[], '(root): expected an object'],
      [{ unknown: true }, 'unknown: unknown key'],
      [{ setup: 'vp install' }, 'setup: expected an array of strings'],
      [{ setup: [1] }, 'setup: expected an array of strings'],
      [{ setup: [1, 'vp install'] }, 'setup: expected an array of strings'],
      [{ setup: [''] }, 'setup: expected non-empty commands without line breaks'],
      [{ setup: ['   '] }, 'setup: expected non-empty commands without line breaks'],
      [{ setup: ['echo a\necho b'] }, 'setup: expected non-empty commands without line breaks'],
      [{ setup: ['echo a\recho b'] }, 'setup: expected non-empty commands without line breaks'],
      [{ env: [] }, 'env: expected an object'],
      [{ env: { X: 1 } }, 'env.X: expected a string'],
      [{ env: { 'BAD-NAME': 'x' } }, 'env.BAD-NAME: expected an environment variable name'],
      [{ heavy: null }, 'heavy: expected an object'],
      [{ heavy: [] }, 'heavy: expected an object'],
      [{ heavy: { other: 3 } }, 'heavy.other: unknown key'],
      [{ heavy: { slotMemoryGb: 0 } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ heavy: { slotMemoryGb: -1 } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ heavy: { slotMemoryGb: '7' } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ heavy: { slotMemoryGb: Number.NaN } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ heavy: { slotMemoryGb: true } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ heavy: { slotMemoryGb: {} } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ heavy: { slotMemoryGb: Number.POSITIVE_INFINITY } }, 'heavy.slotMemoryGb: expected a positive finite number'],
      [{ services: [] }, 'services: expected an object'],
      [{ services: { 'bad/name': {} } }, 'services.bad/name: expected a Docker service name'],
      [{ services: { db: null } }, 'services.db: expected an object'],
      [{ services: { db: { containerPort: 5432, extra: 1, image: 'postgres', port: 5432 } } }, 'services.db.extra: unknown key'],
      [{ rebuildable: 'server.log' }, 'rebuildable: expected an array of strings'],
      [{ rebuildable: ['server.log', 1] }, 'rebuildable: expected an array of strings'],
      [{ rebuildable: [''] }, 'rebuildable: expected path segments without "/", other than "." and ".."'],
      [{ rebuildable: ['logs', 'a/b'] }, 'rebuildable: expected path segments without "/", other than "." and ".."'],
      [{ rebuildable: ['.'] }, 'rebuildable: expected path segments without "/", other than "." and ".."'],
      [{ rebuildable: ['..'] }, 'rebuildable: expected path segments without "/", other than "." and ".."'],
    ])('rejects invalid configuration %j at its key', (value, reason) => {
      writeFileSync(file, JSON.stringify(value));
      expect(thrown()).toMatchObject({ code: 'worktree_config_invalid', message: `${file}: ${reason}` });
    });

    it.each([
      ['image', undefined, 'expected a non-empty string'],
      ['image', '', 'expected a non-empty string'],
      ['image', '   ', 'expected a non-empty string'],
      ['image', 1, 'expected a non-empty string'],
      ['port', undefined, 'expected an integer between 1 and 65535'],
      ['port', 0, 'expected an integer between 1 and 65535'],
      ['port', 65_536, 'expected an integer between 1 and 65535'],
      ['port', 1.5, 'expected an integer between 1 and 65535'],
      ['port', '5432', 'expected an integer between 1 and 65535'],
      ['port', true, 'expected an integer between 1 and 65535'],
      ['port', {}, 'expected an integer between 1 and 65535'],
      ['containerPort', 0, 'expected an integer between 1 and 65535'],
      ['containerPort', 65_536, 'expected an integer between 1 and 65535'],
      ['containerPort', 3.5, 'expected an integer between 1 and 65535'],
      ['env', null, 'expected an object'],
      ['env', { PASSWORD: false }, 'expected a string', '.PASSWORD'],
      ['env', { 'BAD=KEY': 'value' }, 'expected an environment variable name', '.BAD=KEY'],
      ['args', 'redis-server', 'expected an array of strings'],
      ['args', [1], 'expected an array of strings'],
      ['args', [1, 'redis-server'], 'expected an array of strings'],
      ['tmpfs', [], 'expected a non-empty string'],
      ['tmpfs', '', 'expected a non-empty string'],
      ['tmpfs', '   ', 'expected a non-empty string'],
      ['memory', 2, 'expected a non-empty string'],
      ['memory', '', 'expected a non-empty string'],
      ['memory', '   ', 'expected a non-empty string'],
      ['ready', 'pg_isready', 'expected an array of strings'],
      ['ready', [], 'expected a non-empty command array'],
      ['ready', [''], 'expected a non-empty command array'],
      ['ready', ['   '], 'expected a non-empty command array'],
      ['ready', [1], 'expected an array of strings'],
      ['ready', [1, 'pg_isready'], 'expected an array of strings'],
    ])('rejects service %s = %j', (key, value, reason, suffix = '') => {
      writeFileSync(file, JSON.stringify({ services: { db: { containerPort: 5432, image: 'postgres', port: 5432, [key]: value } } }));
      expect(thrown()).toMatchObject({ code: 'worktree_config_invalid', message: `${file}: services.db.${key}${suffix}: ${reason}` });
    });

    it('rejects service names which would share a lowercased container', () => {
      const service = { containerPort: 6379, image: 'redis', port: 6379 };
      writeFileSync(file, JSON.stringify({ services: { Cache: service, cache: service } }));
      expect(thrown()).toMatchObject({ code: 'worktree_config_invalid', message: `${file}: services.cache: duplicates a service name ignoring case` });
    });

    it('reports malformed JSON and unreadable files with the filename', () => {
      writeFileSync(file, '{broken');
      const error = thrown();
      expect(error).toMatchObject({ code: 'worktree_config_invalid' });
      expect(error.message).toContain(`${file}: (root): invalid JSON:`);
    });

    it('reports a directory instead of a configuration file', () => {
      mkdirSync(file);
      const error = thrown();
      expect(error).toMatchObject({ code: 'worktree_config_invalid' });
      expect(error.message).toContain(`${file}: (root): cannot read:`);
    });
  });
});
