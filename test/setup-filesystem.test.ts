import fs, { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run as setup } from '../src/commands/setup.ts';
import { CliError } from '../src/proc.ts';
import { REPO_DIR, tempDir, useSandbox } from './helpers.ts';

const PKG = realpathSync(REPO_DIR);
const binTarget = path.join(PKG, 'bin', 'tern-wt');
const skillTarget = path.join(PKG, 'skills', 'tern-worktrees');
const ompTarget = path.join(PKG, 'omp');
let home: string;
let binLink: string;
let skillLink: string;
let ompLink: string;

const isAbsent = (target: string): boolean => lstatSync(target, { throwIfNoEntry: false }) === undefined;

const expectedLinks = (): object[] => [
  { action: 'created', path: binLink, target: binTarget },
  { action: 'created', path: skillLink, target: skillTarget },
  { action: 'created', path: ompLink, target: ompTarget },
];

const putLink = (link: string, target: string): void => {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
};

const expectConflict = (blocked: string): void => {
  let failure: unknown;
  try {
    setup([]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({ code: 'path_conflict', extra: { path: blocked } });
};

describe('setup filesystem installation', () => {
  beforeEach(() => {
    useSandbox();
    home = tempDir('setup-filesystem-home');
    vi.stubEnv('HOME', home);
    binLink = path.join(home, '.local', 'bin', 'tern-wt');
    skillLink = path.join(home, '.agents', 'skills', 'tern-worktrees');
    ompLink = path.join(home, '.omp', 'agent', 'extensions', 'tern-worktrees-omp');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('preserves every old installation link when a later profile extension has valid manifests outside an omp directory', () => {
    const previous = tempDir('previous-setup');
    const previousBin = path.join(previous, 'bin', 'tern-wt');
    const previousSkill = path.join(previous, 'skills', 'tern-worktrees');
    const previousExtension = path.join(previous, 'omp');
    mkdirSync(previousSkill, { recursive: true });
    mkdirSync(previousExtension);
    writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: 'tern-worktrees' }));
    writeFileSync(path.join(previousExtension, 'package.json'), JSON.stringify({ name: 'tern-worktrees-omp' }));
    putLink(binLink, previousBin);
    putLink(skillLink, previousSkill);
    putLink(ompLink, previousExtension);
    const legacy = path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees');
    putLink(legacy, previousSkill);

    const foreignPackage = tempDir('foreign-setup');
    const foreignExtension = path.join(foreignPackage, 'not-omp');
    mkdirSync(foreignExtension);
    writeFileSync(path.join(foreignPackage, 'package.json'), JSON.stringify({ name: 'tern-worktrees' }));
    writeFileSync(path.join(foreignExtension, 'package.json'), JSON.stringify({ name: 'tern-worktrees-omp' }));
    const profileExtension = path.join(home, '.omp', 'profiles', 'work', 'agent', 'extensions', 'tern-worktrees-omp');
    putLink(profileExtension, foreignExtension);

    expectConflict(profileExtension);
    expect([readlinkSync(binLink), readlinkSync(skillLink), readlinkSync(ompLink), readlinkSync(legacy), readlinkSync(profileExtension)]).toStrictEqual([
      previousBin,
      previousSkill,
      previousExtension,
      previousSkill,
      foreignExtension,
    ]);
    expect(readFileSync(path.join(foreignExtension, 'package.json'), 'utf-8')).toBe('{"name":"tern-worktrees-omp"}');
  });

  it('installs the custom default, active profile and discovered profiles without leaking an inherited agent override', () => {
    vi.stubEnv('PI_CONFIG_DIR', '.custom-omp');
    vi.stubEnv('OMP_PROFILE', 'work');
    vi.stubEnv('PI_PROFILE', 'legacy');
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(home, 'inherited-agent'));
    const root = path.join(home, '.custom-omp');
    const defaultExtension = path.join(root, 'agent', 'extensions', 'tern-worktrees-omp');
    const workExtension = path.join(root, 'profiles', 'work', 'agent', 'extensions', 'tern-worktrees-omp');
    const reviewExtension = path.join(root, 'profiles', 'review', 'agent', 'extensions', 'tern-worktrees-omp');
    mkdirSync(path.join(root, 'profiles', 'review'), { recursive: true });

    expect(setup([])).toStrictEqual({
      links: [
        { action: 'created', path: binLink, target: binTarget },
        { action: 'created', path: skillLink, target: skillTarget },
        { action: 'created', path: defaultExtension, target: ompTarget },
        { action: 'created', path: workExtension, target: ompTarget },
        { action: 'created', path: reviewExtension, target: ompTarget },
      ],
    });
    expect([readlinkSync(defaultExtension), readlinkSync(workExtension), readlinkSync(reviewExtension)]).toStrictEqual([ompTarget, ompTarget, ompTarget]);
    expect([isAbsent(path.join(home, '.omp')), isAbsent(path.join(home, 'inherited-agent')), isAbsent(path.join(root, 'profiles', 'legacy'))]).toStrictEqual([true, true, true]);
  });

  it('reports real profiles in name order even when punctuation differs from filesystem byte order', () => {
    const profiles = path.join(home, '.omp', 'profiles');
    for (const name of ['alphabeta', 'alpha.beta', 'alpha-beta', 'alpha_beta']) {
      mkdirSync(path.join(profiles, name), { recursive: true });
    }
    const underscore = path.join(profiles, 'alpha_beta', 'agent', 'extensions', 'tern-worktrees-omp');
    const hyphen = path.join(profiles, 'alpha-beta', 'agent', 'extensions', 'tern-worktrees-omp');
    const dot = path.join(profiles, 'alpha.beta', 'agent', 'extensions', 'tern-worktrees-omp');
    const plain = path.join(profiles, 'alphabeta', 'agent', 'extensions', 'tern-worktrees-omp');

    expect(setup([])).toStrictEqual({
      links: [
        ...expectedLinks(),
        { action: 'created', path: underscore, target: ompTarget },
        { action: 'created', path: hyphen, target: ompTarget },
        { action: 'created', path: dot, target: ompTarget },
        { action: 'created', path: plain, target: ompTarget },
      ],
    });
    expect([readlinkSync(underscore), readlinkSync(hyphen), readlinkSync(dot), readlinkSync(plain)]).toStrictEqual([ompTarget, ompTarget, ompTarget, ompTarget]);
  });

  it('does not invent a normalized profile from a real directory with surrounding spaces', () => {
    const profiles = path.join(home, '.omp', 'profiles');
    const spaced = path.join(profiles, ' work ');
    mkdirSync(spaced, { recursive: true });
    writeFileSync(path.join(spaced, 'notes.txt'), 'keep this directory');

    expect(setup([])).toStrictEqual({ links: expectedLinks() });
    expect([isAbsent(path.join(profiles, 'work')), isAbsent(path.join(spaced, 'agent'))]).toStrictEqual([true, true]);
    expect(readFileSync(path.join(spaced, 'notes.txt'), 'utf-8')).toBe('keep this directory');
  });

  it.each(['file', 'directory'])('preserves a bundled symlink that replaces a legacy %s after its filesystem inspection', kind => {
    const previous = tempDir('racing-legacy-setup');
    const target = path.join(previous, 'skills', 'tern-worktrees');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: 'tern-worktrees' }));
    const legacy = path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees');
    mkdirSync(path.dirname(legacy), { recursive: true });
    if (kind === 'file') {
      writeFileSync(legacy, 'user-owned skill');
    } else {
      mkdirSync(legacy);
    }
    const relativeTarget = path.relative(path.dirname(legacy), target);
    const original = fs.lstatSync;
    let replaced = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const stat = original(file, options);
      if (file === legacy && !replaced) {
        replaced = true;
        rmSync(legacy, { recursive: true });
        symlinkSync(relativeTarget, legacy);
      }
      return stat;
    });
    syncBuiltinESMExports();

    expect(setup([])).toStrictEqual({ links: expectedLinks() });
    expect(replaced).toBeTruthy();
    expect(readlinkSync(legacy)).toBe(relativeTarget);
    expect([readlinkSync(binLink), readlinkSync(skillLink), readlinkSync(ompLink)]).toStrictEqual([binTarget, skillTarget, ompTarget]);
  });

  it.each([
    ['missing extension manifest', 'extension', 'missing'],
    ['extension manifest directory', 'extension', 'directory'],
    ['invalid extension manifest', 'extension', 'invalid'],
    ['missing package manifest', 'package', 'missing'],
    ['package manifest directory', 'package', 'directory'],
    ['invalid package manifest', 'package', 'invalid'],
  ])('preserves the old CLI, skill and legacy links on %s', (_label, owner, fault) => {
    const previous = tempDir('unreadable-setup');
    const extension = path.join(previous, 'omp');
    const oldSkill = path.join(previous, 'skills', 'tern-worktrees');
    mkdirSync(extension);
    mkdirSync(oldSkill, { recursive: true });
    const manifests = [
      { file: path.join(previous, 'package.json'), name: 'tern-worktrees', owner: 'package' },
      { file: path.join(extension, 'package.json'), name: 'tern-worktrees-omp', owner: 'extension' },
    ];
    for (const manifest of manifests) {
      if (manifest.owner !== owner) {
        writeFileSync(manifest.file, JSON.stringify({ name: manifest.name }));
      } else if (fault === 'directory') {
        mkdirSync(manifest.file);
      } else if (fault === 'invalid') {
        writeFileSync(manifest.file, '{');
      }
    }
    const oldBin = path.join(previous, 'bin', 'tern-wt');
    const legacy = path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees');
    putLink(binLink, oldBin);
    putLink(skillLink, oldSkill);
    putLink(ompLink, extension);
    putLink(legacy, oldSkill);

    expectConflict(ompLink);
    expect([readlinkSync(binLink), readlinkSync(skillLink), readlinkSync(ompLink), readlinkSync(legacy)]).toStrictEqual([oldBin, oldSkill, extension, oldSkill]);
  });

  it.each(['null', '[]', '"tern-worktrees"', 'false', '17'])('preserves a legacy skill whose package manifest is %s', manifest => {
    const previous = tempDir('legacy-setup');
    const target = path.join(previous, 'skills', 'tern-worktrees');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(previous, 'package.json'), manifest);
    const legacy = path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees');
    putLink(legacy, target);

    expect(setup([])).toStrictEqual({ links: expectedLinks() });
    expect(readlinkSync(legacy)).toBe(target);
    expect(readFileSync(path.join(previous, 'package.json'), 'utf-8')).toBe(manifest);
    expect([readlinkSync(binLink), readlinkSync(skillLink), readlinkSync(ompLink)]).toStrictEqual([binTarget, skillTarget, ompTarget]);
  });
});
