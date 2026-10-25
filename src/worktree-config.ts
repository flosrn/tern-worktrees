/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This module validates unknown JSON fields at the file boundary. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isJsonObject, isString } from './json.ts';
import { expandHome } from './paths.ts';
import { CliError } from './proc.ts';

/** A Docker service shared by the worktrees of one repository. */
export interface Service {
  image: string;
  port: number;
  containerPort: number;
  env?: Record<string, string>;
  args?: string[];
  tmpfs?: string;
  memory?: string;
  ready?: string[];
}

/** Repository-owned worktree preparation settings. */
export interface WorktreeConfig {
  setup: string[];
  services: Record<string, Service>;
  env: Record<string, string>;
  heavy: { slotMemoryGb: number };
}

type Fail = (key: string, reason: string) => never;

interface RawService {
  image?: unknown;
  port?: unknown;
  containerPort?: unknown;
  env?: unknown;
  args?: unknown;
  tmpfs?: unknown;
  memory?: unknown;
  ready?: unknown;
}

interface RawWorktreeConfig {
  setup?: unknown;
  services?: unknown;
  env?: unknown;
  heavy?: unknown;
}

const rejectUnknownKeys = (keys: string[], known: readonly string[], prefix: string, fail: Fail): void => {
  for (const key of keys) {
    if (!known.includes(key)) {
      fail(`${prefix}${key}`, 'unknown key');
    }
  }
};

const stringList = (value: unknown, key: string, fail: Fail): string[] => {
  if (!Array.isArray(value) || !value.every(isString)) {
    return fail(key, 'expected an array of strings');
  }
  return value;
};

const EXPECTED_OBJECT = 'expected an object';

const nonEmptyString = (value: unknown, key: string, fail: Fail): string => (isString(value) && value.trim() !== '' ? value : fail(key, 'expected a non-empty string'));

const environment = (value: unknown, key: string, expand: boolean, fail: Fail): Record<string, string> => {
  if (!isJsonObject(value)) {
    return fail(key, EXPECTED_OBJECT);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        fail(`${key}.${name}`, 'expected an environment variable name');
      }
      if (!isString(entry)) {
        return fail(`${key}.${name}`, 'expected a string');
      }
      return [name, expand && entry.startsWith('~/') ? expandHome(entry) : entry];
    }),
  );
};

const portNumber = (value: unknown, key: string, fail: Fail): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(key, 'expected an integer between 1 and 65535');
  }
  return value >= 1 && value <= 65_535 ? value : fail(key, 'expected an integer between 1 and 65535');
};

const readService = (value: unknown, key: string, fail: Fail): Service => {
  if (!isJsonObject(value)) {
    return fail(key, EXPECTED_OBJECT);
  }
  rejectUnknownKeys(Object.keys(value), ['image', 'port', 'containerPort', 'env', 'args', 'tmpfs', 'memory', 'ready'], `${key}.`, fail);
  // SAFETY: the object check establishes the boundary. Fields stay unknown until validated below.
  const raw = value as RawService;
  const service: Service = {
    containerPort: portNumber(raw.containerPort, `${key}.containerPort`, fail),
    image: nonEmptyString(raw.image, `${key}.image`, fail),
    port: portNumber(raw.port, `${key}.port`, fail),
  };
  if ('env' in value) {
    service.env = environment(value.env, `${key}.env`, false, fail);
  }
  if ('args' in value) {
    service.args = stringList(value.args, `${key}.args`, fail);
  }
  if ('tmpfs' in value) {
    service.tmpfs = nonEmptyString(value.tmpfs, `${key}.tmpfs`, fail);
  }
  if ('memory' in value) {
    service.memory = nonEmptyString(value.memory, `${key}.memory`, fail);
  }
  if ('ready' in value) {
    service.ready = stringList(value.ready, `${key}.ready`, fail);
    if (service.ready.length === 0 || service.ready[0].trim() === '') {
      fail(`${key}.ready`, 'expected a non-empty command array');
    }
  }
  return service;
};

const decode = (file: string, fail: Fail): RawWorktreeConfig => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    return fail('(root)', error instanceof SyntaxError ? `invalid JSON: ${String(error)}` : `cannot read: ${String(error)}`);
  }
  return isJsonObject(decoded) ? decoded : fail('(root)', 'expected an object');
};

const readServices = (raw: RawWorktreeConfig, fail: Fail): WorktreeConfig['services'] => {
  const services: WorktreeConfig['services'] = {};
  if ('services' in raw) {
    if (!isJsonObject(raw.services)) {
      fail('services', EXPECTED_OBJECT);
    }
    const names = new Set<string>();
    for (const [name, value] of Object.entries(raw.services)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) {
        fail(`services.${name}`, 'expected a Docker service name');
      }
      if (names.has(name.toLowerCase())) {
        fail(`services.${name}`, 'duplicates a service name ignoring case');
      }
      names.add(name.toLowerCase());
      Object.defineProperty(services, name, { configurable: true, enumerable: true, value: readService(value, `services.${name}`, fail), writable: true });
    }
  }
  return services;
};

const readHeavy = (raw: RawWorktreeConfig, fail: Fail): WorktreeConfig['heavy'] => {
  let slotMemoryGb = 7;
  if ('heavy' in raw) {
    if (!isJsonObject(raw.heavy)) {
      fail('heavy', EXPECTED_OBJECT);
    }
    rejectUnknownKeys(Object.keys(raw.heavy), ['slotMemoryGb'], 'heavy.', fail);
    if ('slotMemoryGb' in raw.heavy) {
      const memory = raw.heavy.slotMemoryGb;
      if (typeof memory !== 'number' || !Number.isFinite(memory) || memory <= 0) {
        fail('heavy.slotMemoryGb', 'expected a positive finite number');
      }
      slotMemoryGb = memory;
    }
  }
  return { slotMemoryGb };
};

/** Reads `.tern/worktree.json`, using defaults for missing keys and reporting invalid file/key pairs. */
export const loadWorktreeConfig = (root: string): WorktreeConfig => {
  const file = path.join(root, '.tern', 'worktree.json');
  const fail: Fail = (key, reason) => {
    throw new CliError('worktree_config_invalid', `${file}: ${key}: ${reason}`);
  };
  const raw = existsSync(file) ? decode(file, fail) : {};
  rejectUnknownKeys(Object.keys(raw), ['setup', 'services', 'env', 'heavy'], '', fail);
  const setup = 'setup' in raw ? stringList(raw.setup, 'setup', fail) : [];
  for (const command of setup) {
    if (command.trim() === '' || /[\r\n]/u.test(command)) {
      fail('setup', 'expected non-empty commands without line breaks');
    }
  }
  return { env: 'env' in raw ? environment(raw.env, 'env', true, fail) : {}, heavy: readHeavy(raw, fail), services: readServices(raw, fail), setup };
};
