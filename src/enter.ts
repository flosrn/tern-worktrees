import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isJsonObject, isString } from './json.ts';
import { envVar, pluginData } from './paths.ts';
import { CliError } from './proc.ts';

const SESSION_ID = /^[\w-]+$/u;

/**
 * The file where `enter` and `create --enter` record the worktree that the omp session `sessionId` moves into at the end of its turn.
 * The bundled omp extension tests for it after each tool call.
 */
export const enterRequestFile = (sessionId: string): string => {
  if (!SESSION_ID.test(sessionId)) {
    throw new CliError('bad_args', `invalid omp session id ${sessionId}`);
  }
  return path.join(pluginData(), 'enter', `${sessionId}.json`);
};

/** The omp session that runs this command, from `$PI_SESSION_ID`, which omp sets for its shell commands. Throws `bad_args` when no omp session or Tern pane runs it. */
export const callerSession = (): string => {
  const session = envVar('PI_SESSION_ID');
  if (session === undefined) {
    throw new CliError('bad_args', '--enter and enter need an omp session: PI_SESSION_ID is not set');
  }
  if (envVar('TERN_PANE') === undefined) {
    throw new CliError('bad_args', '--enter and enter need a Tern pane: TERN_PANE is not set');
  }
  enterRequestFile(session);
  return session;
};

/** Records `dir` as the worktree that the omp session `sessionId` moves into at the end of its turn. A subsequent request of the same session replaces it. */
export const requestEnter = (sessionId: string, dir: string): void => {
  const file = enterRequestFile(sessionId);
  mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  writeFileSync(file, `${JSON.stringify({ path: dir })}\n`, { mode: 0o600 });
};

/** The `path` of the JSON text of a request, or null when the text is not a request. */
const requestedPath = (text: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) && 'path' in parsed && isString(parsed.path) ? parsed.path : null;
  } catch {
    return null;
  }
};

/** Removes the request of the omp session `sessionId` and gives its worktree, or null when the session has no request. */
export const takeEnterRequest = (sessionId: string): string | null => {
  const file = enterRequestFile(sessionId);
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  const requested = requestedPath(text);
  if (requested === null) {
    throw new CliError('bad_args', `invalid enter request in ${file}`);
  }
  return requested;
};
