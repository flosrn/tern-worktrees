/** The summary and the usage lines of a `tern-wt` command, for `tern-wt --help` and `tern-wt <command> --help`. */
interface CommandUsage {
  summary: string;
  usage: string[];
}

/** The help of each command module in `commands/`. `tern-wt --help` lists them in this order. */
export const COMMAND_USAGE = {
  'branches': {
    summary: 'List the branches, open pull requests and worktrees of a repository.',
    usage: ['tern-wt branches --repo <dir> [--offline]'],
  },
  'clean': {
    summary: 'Plan repository cleanup, or apply a new plan with --apply.',
    usage: ['tern-wt clean --repo <dir> [--apply]'],
  },
  'clone': {
    summary: 'Clone a GitHub repository to the clone root.',
    usage: ['tern-wt clone <owner/name>'],
  },
  'config': {
    summary: 'Print the options file with each default filled in.',
    usage: ['tern-wt config'],
  },
  'create': {
    summary: 'Make or reuse the worktree of a branch, an issue or a pull request, and open its tab.',
    usage: [
      'tern-wt create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab] [--enter]',
      'tern-wt create --issue <url|#n|n> [--repo <dir>] [--branch <name>] [--suggest] [--relocate] [--no-tab] [--enter]',
      '--enter: at the end of the turn, fork the calling omp session into the tab of the worktree and end it',
    ],
  },
  'enter': {
    summary: 'Move the calling omp session into a linked worktree at the end of its turn.',
    usage: ['tern-wt enter <worktree>'],
  },
  'env': {
    summary: 'Print the environment of a checkout as JSON or shell exports.',
    usage: ['tern-wt env <path> [--shell]'],
  },
  'finish': {
    summary: 'Plan, arm and inspect the teardown at the end of a delivery.',
    usage: [
      'tern-wt finish plan --repo <dir> [--current <worktree>] [--owned <path> ...] [--exclude <path> ...] [--pid <pid>] [--block <block>] [--session <id>]',
      'tern-wt finish arm <id> --choice current|merged|none [--selected <path> ...]',
      'tern-wt finish status <id>',
    ],
  },
  'heavy': {
    summary: 'Run a command in a host-wide slot, or report the slots.',
    usage: ['tern-wt heavy [--repo <dir>] -- <command> [args...]', 'tern-wt heavy [--repo <dir>] --status'],
  },
  'issue-ref': {
    summary: 'Parse one issue or pull request reference.',
    usage: ['tern-wt issue-ref -- <text>'],
  },
  'list': {
    summary: 'List the tern-managed worktrees, and the omp-owned ones with --all.',
    usage: ['tern-wt list [--repo <dir>] [--all]'],
  },
  'new-repo': {
    summary: 'Make a GitHub repository, then clone it.',
    usage: ['tern-wt new-repo <owner/name> --visibility private|public'],
  },
  'prepare': {
    summary: 'Start the services and run the setup commands of a checkout.',
    usage: ['tern-wt prepare <path> [--no-setup]'],
  },
  'remove': {
    summary: 'Tear down a tern-managed worktree and close its tabs.',
    usage: ['tern-wt remove <path> [--force] [--close-busy-tabs] [--keep-tab]'],
  },
  'repos': {
    summary: 'List the GitHub repositories of your user and organizations.',
    usage: ['tern-wt repos'],
  },
  'resolve': {
    summary: 'Give the repository root, name, owner and GitHub origin of each directory.',
    usage: ['tern-wt resolve <dir>...'],
  },
  'setup': {
    summary: 'Link tern-wt, the skill and the omp extension to this package.',
    usage: ['tern-wt setup'],
  },
} as const satisfies Readonly<Record<string, CommandUsage>>;

/** Tells if `name` is a command with help. */
const isCommand = (name: string): name is keyof typeof COMMAND_USAGE => Object.hasOwn(COMMAND_USAGE, name);

/** The text of `tern-wt --help`: each command with its summary. */
export const overview = (): string => {
  const width = Math.max(...Object.keys(COMMAND_USAGE).map(name => name.length));
  const rows = Object.entries(COMMAND_USAGE).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}\n`);
  return `tern-wt: git worktrees as Tern tabs. Each command prints one JSON object.\n\nCommands:\n${rows.join('')}\nRun tern-wt <command> --help for the arguments of a command.\n`;
};

/** The text of `tern-wt <command> --help`, or null for a name that is not a command. */
export const commandHelp = (name: string): string | null => {
  if (!isCommand(name)) {
    return null;
  }
  const { summary, usage } = COMMAND_USAGE[name];
  const lines = usage.map(line => `  ${line}\n`).join('');
  return `${summary}\n\n${lines}`;
};
