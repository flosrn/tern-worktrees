import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run as setup } from '../src/commands/setup.ts';
import { CliError } from '../src/proc.ts';
import { REPO_DIR, tempDir, useSandbox } from './helpers.ts';

const PKG = realpathSync(REPO_DIR);
const binTarget = path.join(PKG, 'bin', 'tern-wt');
const skillTarget = path.join(PKG, 'skills', 'tern-worktrees');
const ompTarget = path.join(PKG, 'omp');
const NOT_A_SYMLINK = 'exists and is not a symbolic link';
let home: string;
let binLink: string;
let skillLink: string;
let ompLink: string;

const isAbsent = (target: string): boolean => lstatSync(target, { throwIfNoEntry: false }) === undefined;

const expectedLinks = (binAction: string, skillAction: string = binAction, ompAction: string = binAction): object[] => [
  { action: binAction, path: binLink, target: binTarget },
  { action: skillAction, path: skillLink, target: skillTarget },
  { action: ompAction, path: ompLink, target: ompTarget },
];

const expectPathConflict = (blocked: string, message: string): void => {
  let failure: CliError | null = null;
  try {
    setup([]);
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'path_conflict', extra: { path: blocked } });
  expect(failure?.message).toContain(message);
};

describe('OMP extension installation', () => {
  beforeEach(() => {
    useSandbox();
    home = tempDir('home');
    vi.stubEnv('HOME', home);
    binLink = path.join(home, '.local', 'bin', 'tern-wt');
    skillLink = path.join(home, '.agents', 'skills', 'tern-worktrees');
    ompLink = path.join(home, '.omp', 'agent', 'extensions', 'tern-worktrees-omp');
  });

  it('installs the OMP factory as a native extension without changing user settings or plugin state', () => {
    const extension = path.join(home, '.omp', 'agent', 'extensions', 'tern-worktrees-omp');
    const settings = path.join(home, '.omp', 'agent', 'config.yml');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, 'model: keep-me\n');
    const result = setup([]);
    expect(result.links).toContainEqual({ action: 'created', path: extension, target: path.join(PKG, 'omp') });
    expect(readlinkSync(extension)).toBe(path.join(PKG, 'omp'));
    expect(readFileSync(settings, 'utf-8')).toBe('model: keep-me\n');
    expect(isAbsent(path.join(home, '.omp', 'plugins'))).toBeTruthy();
    expect(setup([]).links).toContainEqual({ action: 'kept', path: extension, target: path.join(PKG, 'omp') });
  });

  it('installs for the active profile rather than the default agent override', () => {
    vi.stubEnv('PI_CONFIG_DIR', '.custom-omp');
    vi.stubEnv('OMP_PROFILE', 'work');
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(home, 'another-agent'));
    const extension = path.join(home, '.custom-omp', 'profiles', 'work', 'agent', 'extensions', 'tern-worktrees-omp');
    expect(setup([]).links).toContainEqual({ action: 'created', path: extension, target: ompTarget });
    expect(readlinkSync(extension)).toBe(ompTarget);
    expect(isAbsent(path.join(home, 'another-agent'))).toBeTruthy();
  });

  it('installs for the default agent and every existing profile without following foreign profile links', () => {
    const profiles = path.join(home, '.omp', 'profiles');
    const workAgent = path.join(profiles, 'work', 'agent');
    const reviewAgent = path.join(profiles, 'review', 'agent');
    const foreign = tempDir('foreign-profile');
    mkdirSync(workAgent, { recursive: true });
    mkdirSync(reviewAgent, { recursive: true });
    symlinkSync(foreign, path.join(profiles, 'foreign'));
    mkdirSync(path.join(profiles, 'not a profile'));
    const result = setup([]);
    expect(result.links).toStrictEqual([
      ...expectedLinks('created'),
      { action: 'created', path: path.join(reviewAgent, 'extensions', 'tern-worktrees-omp'), target: ompTarget },
      { action: 'created', path: path.join(workAgent, 'extensions', 'tern-worktrees-omp'), target: ompTarget },
    ]);
    expect(isAbsent(path.join(foreign, 'agent'))).toBeTruthy();
    expect(isAbsent(path.join(profiles, 'not a profile', 'agent'))).toBeTruthy();
  });

  it('does not enumerate a foreign directory linked as the profiles root', () => {
    const foreign = tempDir('foreign-profiles');
    mkdirSync(path.join(foreign, 'work', 'agent'), { recursive: true });
    mkdirSync(path.join(home, '.omp'), { recursive: true });
    symlinkSync(foreign, path.join(home, '.omp', 'profiles'));
    expect(setup([])).toStrictEqual({ links: expectedLinks('created') });
    expect(isAbsent(path.join(foreign, 'work', 'agent', 'extensions'))).toBeTruthy();
  });

  it('rejects a foreign extension symlink before creating the CLI or skill link', () => {
    const foreign = tempDir('foreign-extension');
    mkdirSync(path.dirname(ompLink), { recursive: true });
    writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ name: 'another-plugin' }));
    symlinkSync(foreign, ompLink);
    expectPathConflict(ompLink, 'does not point to the bundled OMP extension');
    expect(readlinkSync(ompLink)).toBe(foreign);
    expect([isAbsent(binLink), isAbsent(skillLink)]).toStrictEqual([true, true]);
  });

  it('rejects an extension file before changing any installation link', () => {
    mkdirSync(path.dirname(ompLink), { recursive: true });
    writeFileSync(ompLink, 'mine');
    expectPathConflict(ompLink, NOT_A_SYMLINK);
    expect([isAbsent(binLink), isAbsent(skillLink)]).toStrictEqual([true, true]);
    expect(readFileSync(ompLink, 'utf-8')).toBe('mine');
  });

  it('rejects an extension directory before changing any installation link', () => {
    mkdirSync(ompLink, { recursive: true });
    expectPathConflict(ompLink, NOT_A_SYMLINK);
    expect([isAbsent(binLink), isAbsent(skillLink)]).toStrictEqual([true, true]);
    expect(lstatSync(ompLink).isDirectory()).toBeTruthy();
  });

  it('checks every profile extension before creating any installation link', () => {
    const workExtension = path.join(home, '.omp', 'profiles', 'work', 'agent', 'extensions', 'tern-worktrees-omp');
    mkdirSync(workExtension, { recursive: true });
    expectPathConflict(workExtension, NOT_A_SYMLINK);
    expect([isAbsent(binLink), isAbsent(skillLink), isAbsent(ompLink)]).toStrictEqual([true, true, true]);
    expect(lstatSync(workExtension).isDirectory()).toBeTruthy();
  });

  it('keeps a relative extension link that already resolves to this package', () => {
    mkdirSync(path.dirname(ompLink), { recursive: true });
    const target = path.relative(path.dirname(ompLink), ompTarget);
    symlinkSync(target, ompLink);
    expect(setup([])).toStrictEqual({ links: expectedLinks('created', 'created', 'kept') });
    expect(readlinkSync(ompLink)).toBe(target);
  });

  it('installs to the explicit default agent directory as well as the normal default', () => {
    const agent = path.join(home, 'custom-agent');
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    expect(setup([]).links).toStrictEqual([...expectedLinks('created'), { action: 'created', path: path.join(agent, 'extensions', 'tern-worktrees-omp'), target: ompTarget }]);
  });

  it('replaces an extension link to a previous tern-worktrees installation', () => {
    const previous = tempDir('previous-package');
    const extension = path.join(previous, 'omp');
    mkdirSync(extension);
    writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: 'tern-worktrees' }));
    writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'tern-worktrees-omp', omp: { extensions: ['index.ts'] } }));
    mkdirSync(path.dirname(ompLink), { recursive: true });
    symlinkSync(path.relative(path.dirname(ompLink), extension), ompLink);
    expect(setup([])).toStrictEqual({ links: expectedLinks('created', 'created', 'replaced') });
    expect(readlinkSync(ompLink)).toBe(ompTarget);
  });

  it.each([
    ['wrong parent', JSON.stringify({ name: 'another-package' }), JSON.stringify({ name: 'tern-worktrees-omp' })],
    ['wrong extension', JSON.stringify({ name: 'tern-worktrees' }), JSON.stringify({ name: 'another-extension' })],
    ['invalid manifest', JSON.stringify({ name: 'tern-worktrees' }), '{'],
    ['missing extension name', JSON.stringify({ name: 'tern-worktrees' }), '{}'],
    ['non-object extension manifest', JSON.stringify({ name: 'tern-worktrees' }), 'null'],
    ['missing parent name', '{}', JSON.stringify({ name: 'tern-worktrees-omp' })],
    ['non-object parent manifest', 'null', JSON.stringify({ name: 'tern-worktrees-omp' })],
  ])('preserves a same-named extension with %s', (_label, parent, manifest) => {
    const pkg = tempDir('impostor-package');
    const extension = path.join(pkg, 'omp');
    mkdirSync(extension);
    writeFileSync(path.join(pkg, 'package.json'), parent);
    writeFileSync(path.join(extension, 'package.json'), manifest);
    mkdirSync(path.dirname(ompLink), { recursive: true });
    symlinkSync(extension, ompLink);
    expectPathConflict(ompLink, 'does not point to the bundled OMP extension');
    expect([readlinkSync(ompLink), isAbsent(binLink), isAbsent(skillLink)]).toStrictEqual([extension, true, true]);
  });
});
