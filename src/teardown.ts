import { gitRun, isAncestor } from './git.ts';
import { listPullRequests } from './github.ts';
import { CliError } from './proc.ts';
import type { BusyBlock } from './proc.ts';
import type { GithubRepoRef } from './repo-ref.ts';
import { processOf } from './tern.ts';
import type { PlacedBlock, TernProcess, TernProcessSnapshot } from './tern.ts';

const IDLE_SHELLS = {
  'bash': true,
  'cmd.exe': true,
  'csh': true,
  'dash': true,
  'fish': true,
  'ksh': true,
  'nu': true,
  'powershell': true,
  'pwsh': true,
  'sh': true,
  'tcsh': true,
  'zsh': true,
} satisfies Readonly<Record<string, true>>;

/** Tells if a sampled block has foreground work other than its idle shell. */
export const isBusyProcess = (snapshot: TernProcessSnapshot): snapshot is TernProcessSnapshot & { foreground: TernProcess } => {
  const { child, foreground } = snapshot;
  return foreground !== null && !(child?.pid === foreground.pid && Object.hasOwn(IDLE_SHELLS, child.name));
};

/** Refuses to close blocks with a foreground process other than their idle shell. */
export const guardBusyTabs = async (blocks: PlacedBlock[]): Promise<void> => {
  const snapshots = await Promise.all(blocks.map(async entry => ({ ...entry, snapshot: await processOf(entry.block.id) })));
  const busy: BusyBlock[] = [];
  const descriptions = [];
  for (const { block, tab, session, snapshot } of snapshots) {
    if (isBusyProcess(snapshot)) {
      const { foreground } = snapshot;
      busy.push({ block: block.id, process: foreground, session: session.id, tab: tab.id });
      descriptions.push(`${block.id} in tab ${JSON.stringify(tab.name)} (${foreground.argv.join(' ') || foreground.name})`);
    }
  }
  if (busy.length > 0) {
    throw new CliError('busy_tabs', `Foreground processes in blocks: ${descriptions.join(', ')}; use --close-busy-tabs to close them after the user agrees`, { blocks: busy });
  }
};

/** Checks ancestry or a merged PR that still contains the full local branch head, without fetching. */
export const isMerged = async (root: string, branch: string, base: string, repoRef: GithubRepoRef | null, warnings: string[]): Promise<boolean> => {
  if (await isAncestor(root, `refs/heads/${branch}`, `origin/${base}`)) {
    return true;
  }
  if (repoRef === null) {
    return false;
  }
  const { error, prs } = await listPullRequests(repoRef, [`--head=${branch}`, '--state', 'merged'], ['headRefOid']);
  if (error !== null) {
    warnings.push(`merged PR check failed: ${error}`);
    return false;
  }
  const held = await Promise.all(prs.map(async pr => await isAncestor(root, `refs/heads/${branch}`, pr.headRefOid)));
  return held.includes(true);
};

/** Proves integration for clean using ancestry, the shared merged PR heads, or an unchanged merge tree. */
export const isCleanMerged = async (root: string, branch: string, base: string, mergedHeads: string[], defaultTree: string | null): Promise<boolean> => {
  const ref = `refs/heads/${branch}`;
  if (await isAncestor(root, ref, `origin/${base}`)) {
    return true;
  }
  for (const head of mergedHeads) {
    // Stop at the first proof.
    // eslint-disable-next-line no-await-in-loop
    if (await isAncestor(root, ref, head)) {
      return true;
    }
  }
  if (defaultTree === null) {
    return false;
  }
  const merged = await gitRun(root, 'merge-tree', '--write-tree', `origin/${base}`, ref);
  return merged.status === 0 && merged.stdout.trim() === defaultTree;
};
