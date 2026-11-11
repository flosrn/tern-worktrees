import { CliOutput } from './cli-output.ts';
import { loadConfig } from './config.ts';
import { CliError } from './proc.ts';
import { commandHelp, overview } from './usage.ts';

/** What the process prints and how it exits. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A command module: `run(args)` returns the JSON result of the command, or a Promise of it. */
export interface CommandModule {
  run: (args: string[]) => object | Promise<object>;
}

/** Finds the command module for a command name. */
export type CommandLoader = (name: string) => Promise<CommandModule>;

const COMMAND_NAME = /^[a-z-]+$/u;

/** Returns `name` when it is lowercase letters and dashes only, the form of a command module name. Else it throws `bad_args`. */
const checkCommandName = (name: string): string => {
  if (!COMMAND_NAME.test(name)) {
    throw new CliError('bad_args', `unknown command ${name}`);
  }
  return name;
};

/** Makes a {@link CommandLoader} that checks the name, then imports the module with `importCommand`. A module that fails to load gives `bad_args`. */
export const commandLoader =
  (importCommand: CommandLoader): CommandLoader =>
  async name => {
    checkCommandName(name);
    try {
      return await importCommand(name);
    } catch {
      throw new CliError('bad_args', `unknown command ${name}`);
    }
  };

const loadCommand = commandLoader(
  async name =>
    // SAFETY: each module in `commands/` exports `run(args)`.
    (await import(`./commands/${name}.ts`)) as CommandModule,
);

const toCliError = (cause: unknown): CliError => {
  if (cause instanceof CliError) {
    return cause;
  }
  if (!(cause instanceof Error)) {
    return new CliError('git_failed', String(cause));
  }
  // SAFETY: a Node error has an optional string `code`, and other errors have no `code`.
  const { code } = cause as NodeJS.ErrnoException;
  return new CliError(code?.startsWith('ERR_PARSE_ARGS_') === true ? 'bad_args' : 'git_failed', cause.message);
};

const HELP_FLAGS = { '--help': true, '-h': true } as const;

/**
 * The help text that `argv` asks for, or null when `argv` runs a command. No arguments, `help`, `--help` and `-h` ask for the overview, and `help <command>` or
 * `<command> --help` for one command. A `--help` after `--` is an argument of the command, for example the text of `issue-ref`.
 */
const helpFor = (argv: string[]): string | null => {
  const [name = '', ...args] = argv;
  if (name === '' || name === 'help' || Object.hasOwn(HELP_FLAGS, name)) {
    const topic = name === 'help' ? args.at(0) : undefined;
    if (topic === undefined) {
      return overview();
    }
    const text = commandHelp(topic);
    if (text === null) {
      throw new CliError('bad_args', `unknown command ${topic}`);
    }
    return text;
  }
  const end = args.indexOf('--');
  const flags = end === -1 ? args : args.slice(0, end);
  return flags.some(arg => Object.hasOwn(HELP_FLAGS, arg)) ? commandHelp(name) : null;
};

/** Runs one `tern-wt` command and returns its JSON output and exit code, or the help text that `argv` asks for. A failure gives the error envelope. */
export const main = async (argv: string[], load: CommandLoader = loadCommand): Promise<CliResult> => {
  const [name = '', ...args] = argv;
  try {
    const help = helpFor(argv);
    if (help !== null) {
      return { code: 0, stderr: '', stdout: help };
    }
    loadConfig();
    const command = await load(name);
    const result = await command.run(args);
    if (result instanceof CliOutput) {
      return { code: result.exitCode, stderr: '', stdout: result.output };
    }
    return { code: 0, stderr: '', stdout: `${JSON.stringify(result)}\n` };
  } catch (error) {
    const failure = toCliError(error);
    const envelope = { error: { code: failure.code, message: failure.message, ...failure.extra } };
    return { code: 1, stderr: `${failure.message}\n`, stdout: `${JSON.stringify(envelope)}\n` };
  }
};
