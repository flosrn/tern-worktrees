import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { expandHome } from './paths.ts';

/** Parses directory operands, expanding home paths while keeping the caller's positional lookup keys. */
export const directoryArgs = <const T extends ParseArgsConfig>(options: T) => {
  const parsed = parseArgs(options);
  const originalPositionals = parsed.positionals;
  // SAFETY: directory commands declare --repo as a string argument, or omit it.
  const values = parsed.values as { repo?: string };
  if (values.repo !== undefined) {
    values.repo = expandHome(values.repo);
  }
  return { ...parsed, originalPositionals, positionals: originalPositionals.map(expandHome) };
};
