import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './git.ts';
import { isJsonObject, isString } from './json.ts';
import { envVar, isUnder } from './paths.ts';
import { CliError, must, run } from './proc.ts';

/** A pane of a Tern tab, as `tern ls --json` prints it. */
export interface TernBlock {
  id: number;
  cwd: string | null;
  title: string;
}

/** A tab of a Tern session. */
export interface TernTab {
  id: number;
  name: string;
  blocks: TernBlock[];
}

/** A Tern session. */
export interface TernSession {
  id: number;
  name: string;
  tabs: TernTab[];
}

/** The output of `tern ls --json`. */
export interface TernListing {
  sessions: TernSession[];
}

/** A block with the session and tab that hold it. */
export interface PlacedBlock {
  session: TernSession;
  tab: TernTab;
  block: TernBlock;
}

interface CreatedBlock {
  block: number;
}

/** Where the macOS app bundle keeps the Tern binary. */
export const TERN_APP_BIN = '/Applications/Tern.app/Contents/MacOS/tern';

/** The Tern binary: `$TERN_BIN`, else the binary of the app bundle when the bundle is on disk, else `tern` from `PATH`. */
export const ternBin = (appBin: string = TERN_APP_BIN): string => envVar('TERN_BIN') ?? (existsSync(appBin) ? appBin : 'tern');

const tern = async (args: string[]): Promise<string> => await must([ternBin(), ...args, '--json'], 'tern_failed');

/** All sessions, tabs and blocks of the Tern window. */
export const ls = async (): Promise<TernListing> =>
  // SAFETY: `tern ls --json` prints the TernListing layout.
  JSON.parse(await tern(['ls'])) as TernListing;

/** A process reported by `tern process --json`. */
export interface TernProcess {
  pid: number;
  name: string;
  argv: string[];
  cwd: string | null;
}

/** The terminal child and its foreground process group, sampled by the daemon. */
export interface TernProcessSnapshot {
  child: TernProcess | null;
  foreground: TernProcess | null;
  pane: number;
  group: number | null;
}

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate numbers at the external Tern JSON boundary.
const isNumber = (value: unknown): value is number => typeof value === 'number';

interface RawProcess {
  argv?: unknown;
  cwd?: unknown;
  name?: unknown;
  pid?: unknown;
}

interface RawProcessSnapshot {
  child?: unknown;
  foreground?: unknown;
  group?: unknown;
  pane?: unknown;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External Tern JSON must be validated before its shape is trusted.
const parseProcess = (value: unknown): TernProcess | null => {
  if (value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    throw new Error('Tern process must be an object');
  }
  // SAFETY: the object can omit fields. The code validates each value before use.
  const raw = value as RawProcess;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Keep the complete process boundary contract together before narrowing its fields.
    !isNumber(raw.pid) ||
    !isString(raw.name) ||
    !Array.isArray(raw.argv) ||
    !raw.argv.every(isString) ||
    !(raw.cwd === null || isString(raw.cwd))
  ) {
    throw new Error('Invalid Tern process');
  }
  return { argv: raw.argv, cwd: raw.cwd, name: raw.name, pid: raw.pid };
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External Tern JSON must be validated before its shape is trusted.
const parseProcessSnapshot = (value: unknown): TernProcessSnapshot => {
  if (!isJsonObject(value)) {
    throw new Error('Tern process snapshot must be an object');
  }
  // SAFETY: the object can omit fields. The code validates each value before use.
  const raw = value as RawProcessSnapshot;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Validate every snapshot field before parsing its nullable processes.
    !isNumber(raw.pane) ||
    !(raw.group === null || isNumber(raw.group)) ||
    !('child' in raw) ||
    !('foreground' in raw)
  ) {
    throw new Error('Invalid Tern process snapshot');
  }
  return { child: parseProcess(raw.child), foreground: parseProcess(raw.foreground), group: raw.group, pane: raw.pane };
};

/** Samples a block's foreground process without sending input to it. */
export const processOf = async (block: number): Promise<TernProcessSnapshot> => {
  try {
    const output = await tern(['process', String(block)]);
    return parseProcessSnapshot(JSON.parse(output));
  } catch (error) {
    throw new CliError('tern_failed', `Cannot inspect block ${block}: ${String(error)}`);
  }
};

const newBlock = async (args: string[]): Promise<number> => {
  // SAFETY: `tern new --json` prints the id of the new block in the `block` field.
  const created = JSON.parse(await tern(['new', ...args])) as CreatedBlock;
  return created.block;
};

/** Opens a tab in `session` at `cwd` and returns its block id. */
export const newTab = async (session: string, cwd: string): Promise<number> => await newBlock(['tab', session, '--cwd', cwd]);

/** Opens a session named `name` at `cwd` and returns its block id. */
export const newSession = async (name: string, cwd: string): Promise<number> => await newBlock(['session', name, '--cwd', cwd]);

/**
 * Opens a block at `cwd` adjacent to `block`, on its right, that runs `command` and returns its id. Tern runs a command of one item as shell text, and quotes each item of a command with two or more items.
 * Give two or more items, so `command` needs no shell quoting. `--json` goes before `--`: after it, Tern reads it as an item of the command.
 */
export const split = async (block: number, cwd: string, command: string[]): Promise<number> => {
  // SAFETY: `tern split --json` prints the id of the new block in the `block` field.
  const created = JSON.parse(await must([ternBin(), 'split', String(block), 'right', '--json', '--cwd', cwd, '--', ...command], 'tern_failed')) as CreatedBlock;
  return created.block;
};

/** Names the tab that holds `block`. */
export const rename = async (block: number, name: string): Promise<void> => {
  await tern(['rename', String(block), name]);
};

/** Shows `block` in all windows. */
export const focus = async (block: number): Promise<void> => {
  await tern(['focus', String(block)]);
};

/** Closes `block`. */
export const close = async (block: number): Promise<void> => {
  await tern(['close', String(block)]);
};

/** Types `line` and Enter into the shell of `block`. Unlike the other calls, it passes no `--json`, so `tern run` gets only the line to type. */
export const typeInto = async (block: number, line: string): Promise<void> => {
  await must([ternBin(), 'run', String(block), line], 'tern_failed');
};

/** Waits a maximum of `seconds` for the shell of `block` to show its prompt. Gives true at the prompt and false on a timeout (exit 124). Throws `tern_failed` on a different exit status. */
export const waitForPrompt = async (block: number, seconds: number): Promise<boolean> => {
  const bin = ternBin();
  const result = await run([bin, 'wait', String(block), '--until', 'prompt', '--timeout', String(seconds)]);
  if (result.status === 124) {
    return false;
  }
  if (result.status !== 0) {
    throw new CliError('tern_failed', result.stderr.trim() || `${bin} exited ${result.status}`);
  }
  return true;
};

const placedBlocks = (listing: TernListing): PlacedBlock[] => listing.sessions.flatMap(session => session.tabs.flatMap(tab => tab.blocks.map(block => ({ block, session, tab }))));

const cwdOf = (block: TernBlock): string | null => (block.cwd === '' ? null : block.cwd);

/** All blocks of `listing` whose `cwd` is `dir` or a directory in it. */
export const blocksUnder = (listing: TernListing, dir: string): PlacedBlock[] =>
  placedBlocks(listing).filter(({ block }) => {
    const cwd = cwdOf(block);
    return cwd !== null && isUnder(cwd, dir);
  });

/** The first session of `listing` with a block whose `cwd` is in the repository at `root`, or null. It calls `repoRoot` one time for each different `cwd`, not one time for each block. */
export const sessionForRepo = async (listing: TernListing, root: string): Promise<TernSession | null> => {
  const placed = placedBlocks(listing);
  const cwds = [...new Set(placed.map(({ block }) => cwdOf(block)))];
  const roots = new Map(await Promise.all(cwds.map(async cwd => [cwd, cwd === null ? null : await repoRoot(cwd)] as const)));
  return placed.find(({ block }) => roots.get(cwdOf(block)) === root)?.session ?? null;
};

/** The Tern tab that shows a worktree: a block in it, the name of its session, and `opened`, true when the tab is new. */
export interface WorktreeTab {
  block: number;
  opened: boolean;
  session: string;
}

/**
 * Focuses the first block in `dir`, a worktree of the repository with the main checkout `root`. When no block is in `dir`, opens a tab named `name` at `dir`
 * in the session of that repository, or a session named after the folder of `root` when no session has the repository.
 */
export const openWorktreeTab = async (root: string, dir: string, name: string): Promise<WorktreeTab> => {
  const listing = await ls();
  const existingBlock = blocksUnder(listing, dir).at(0);
  if (existingBlock) {
    await focus(existingBlock.block.id);
    return { block: existingBlock.block.id, opened: false, session: existingBlock.session.name };
  }
  const repoName = path.basename(root);
  const session = await sessionForRepo(listing, root);
  const block = session === null ? await newSession(repoName, dir) : await newTab(session.name, dir);
  await rename(block, name);
  return { block, opened: true, session: session?.name ?? repoName };
};
