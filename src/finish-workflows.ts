import type { FinishPullRequest } from './finish-types.ts';
import { ghRun } from './github.ts';
import { isJsonObject, isString } from './json.ts';
import { run as runProcess } from './proc.ts';

type JsonValue = string | number | boolean | null | JsonValue[] | JsonFields;
interface JsonFields {
  [key: string]: JsonValue;
}
type Validator<T> = (value: unknown) => value is T;

const unavailable = (): never => {
  throw new Error('GitHub workflow proof unavailable');
};
const isFields = (value: unknown): value is JsonFields => isJsonObject(value);
const decode = <T>(text: string, accepts: Validator<T>): T => {
  const value: unknown = JSON.parse(text);
  return accepts(value) ? value : unavailable();
};
const api = async <T>(repo: string, endpoint: string, accepts: Validator<T>): Promise<T> => {
  const result = await ghRun('api', `repos/${repo}/${endpoint}`);
  return result.status === 0 ? decode(result.stdout, accepts) : unavailable();
};

interface TreeEntry {
  path: string;
  type: string;
  mode?: string;
}
interface MergeTree {
  truncated: boolean;
  tree: TreeEntry[];
}
const isTreeEntry = (value: unknown): value is TreeEntry => {
  if (!isFields(value)) {
    return false;
  }
  return isString(value.path) && isString(value.type);
};
const isMergeTree = (value: unknown): value is MergeTree => {
  if (!isFields(value)) {
    return false;
  }
  return value.truncated === false && Array.isArray(value.tree) && value.tree.every(isTreeEntry);
};
const workflowPaths = async (repo: string, sha: string): Promise<string[]> => {
  const tree = await api(repo, `git/trees/${sha}?recursive=1`, isMergeTree);
  return tree.tree
    .filter(entry => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(entry.path))
    .map(entry => {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode ?? '')) {
        return unavailable();
      }
      return entry.path;
    });
};

interface Collection {
  total_count: number;
  workflows?: JsonValue[];
  workflow_runs?: JsonValue[];
}
const isCollection = (value: unknown): value is Collection => {
  if (!isFields(value)) {
    return false;
  }
  return Number.isSafeInteger(value.total_count);
};
const readCollection = async <T>(repo: string, endpoint: string, field: 'workflows' | 'workflow_runs', accepts: Validator<T>, page = 1, entries: T[] = []): Promise<T[]> => {
  const result = await api(repo, `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, isCollection);
  const values = result[field];
  if (!Array.isArray(values)) {
    return unavailable();
  }
  const accepted = values.map(value => (accepts(value) ? value : unavailable()));
  entries.push(...accepted);
  if (entries.length === result.total_count) {
    return entries;
  }
  if (values.length === 0 || entries.length > result.total_count || entries.length >= 1000) {
    return unavailable();
  }
  return await readCollection(repo, endpoint, field, accepts, page + 1, entries);
};

interface WorkflowIdentity {
  id: number;
  path: string;
  state: string;
}
const isWorkflowIdentity = (value: unknown): value is WorkflowIdentity => {
  if (!isFields(value) || !Number.isSafeInteger(value.id)) {
    return false;
  }
  return isString(value.path) && isString(value.state);
};
interface WorkflowSource {
  type: 'file';
  path: string;
  encoding: 'base64';
  content: string;
}
const isWorkflowSource = (value: unknown): value is WorkflowSource => {
  if (!isFields(value) || value.type !== 'file' || value.encoding !== 'base64') {
    return false;
  }
  return isString(value.path) && isString(value.content);
};

const BRANCH_IGNORE = 'branches-ignore';
const PATH_IGNORE = 'paths-ignore';
const TAG_IGNORE = 'tags-ignore';
interface BranchFilters {
  'branches'?: string[];
  'branches-ignore'?: string[];
}
interface PushFilters extends BranchFilters {
  'tags'?: string[];
  'tags-ignore'?: string[];
  'paths'?: string[];
  'paths-ignore'?: string[];
}
interface ChainFilters extends BranchFilters {
  workflows: string[];
  types?: string[];
}
const isPatterns = (value: JsonValue | undefined): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isString);
const isBranchFilters = (value: JsonFields): value is JsonFields & BranchFilters => {
  const branches = value.branches === undefined || isPatterns(value.branches);
  const ignored = value[BRANCH_IGNORE] === undefined || isPatterns(value[BRANCH_IGNORE]);
  return branches && ignored;
};
const isPushFilters = (value: unknown): value is PushFilters => {
  if (!isFields(value)) {
    return false;
  }
  const allowed = new Set(['branches', BRANCH_IGNORE, 'tags', TAG_IGNORE, 'paths', PATH_IGNORE]);
  return Object.entries(value).every(([key, patterns]) => allowed.has(key) && isPatterns(patterns));
};
const isChainFilters = (value: unknown): value is ChainFilters => {
  if (!isFields(value) || !isBranchFilters(value) || !isPatterns(value.workflows)) {
    return false;
  }
  return value.types === undefined || isPatterns(value.types);
};

const KNOWN_EVENTS = new Set([
  'branch_protection_rule',
  'check_run',
  'check_suite',
  'create',
  'delete',
  'deployment',
  'deployment_status',
  'discussion',
  'discussion_comment',
  'fork',
  'gollum',
  'image_version',
  'issue_comment',
  'issues',
  'label',
  'merge_group',
  'milestone',
  'page_build',
  'public',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_target',
  'push',
  'registry_package',
  'release',
  'repository_dispatch',
  'schedule',
  'status',
  'watch',
  'workflow_call',
  'workflow_dispatch',
  'workflow_run',
]);
const workflowEvents = (trigger: JsonValue | undefined): JsonFields => {
  if (isString(trigger)) {
    return { [trigger]: null };
  }
  if (isPatterns(trigger)) {
    return Object.fromEntries(trigger.map(event => [event, null]));
  }
  if (Array.isArray(trigger) || !isJsonObject(trigger)) {
    return unavailable();
  }
  return trigger;
};
interface Workflow {
  id: number;
  name: string;
  push?: PushFilters | null;
  chain?: ChainFilters;
}
const workflowConfig = (document: JsonFields, path: string, id: number): Workflow => {
  const events = workflowEvents(document.on);
  const names = Object.keys(events);
  if (names.length === 0 || names.some(name => !KNOWN_EVENTS.has(name))) {
    return unavailable();
  }
  const workflow: Workflow = { id, name: isString(document.name) ? document.name : path };
  if (Object.hasOwn(events, 'push')) {
    if (events.push !== null && !isPushFilters(events.push)) {
      return unavailable();
    }
    workflow.push = events.push;
  }
  if (Object.hasOwn(events, 'workflow_run')) {
    if (!isChainFilters(events.workflow_run)) {
      return unavailable();
    }
    workflow.chain = events.workflow_run;
  }
  return workflow;
};
const readWorkflow = async (repo: string, sha: string, path: string, id: number): Promise<Workflow> => {
  const encoded = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const file = await api(repo, `contents/${encoded}?ref=${sha}`, isWorkflowSource);
  if (file.path !== path) {
    return unavailable();
  }
  const source = Buffer.from(file.content, 'base64').toString('utf-8');
  const parsed = await runProcess(['bun', '-e', 'console.log(JSON.stringify(Bun.YAML.parse(process.argv[1])))', source]);
  if (parsed.status !== 0) {
    return unavailable();
  }
  return workflowConfig(decode(parsed.stdout, isFields), path, id);
};
const activeWorkflows = async (repo: string, sha: string, paths: string[]): Promise<Workflow[]> => {
  const configured = await readCollection(repo, 'actions/workflows', 'workflows', isWorkflowIdentity);
  const workflows = await Promise.all(
    paths.map(async path => {
      const identities = configured.filter(identity => identity.path === path);
      const [identity] = identities;
      if (identities.length !== 1) {
        return unavailable();
      }
      if (identity.state === 'active') {
        return await readWorkflow(repo, sha, path, identity.id);
      }
      if (!['deleted', 'disabled_fork', 'disabled_inactivity', 'disabled_manually'].includes(identity.state)) {
        return unavailable();
      }
      return null;
    }),
  );
  return workflows.filter(workflow => workflow !== null);
};

interface WorkflowRun {
  id: number;
  workflow_id: number;
  head_sha: string;
  event: string;
  head_branch: string;
  status: string | null;
  conclusion: string | null;
}
const isWorkflowRun = (value: unknown): value is WorkflowRun => {
  if (!isFields(value) || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.workflow_id)) {
    return false;
  }
  const identity = isString(value.head_sha) && isString(value.event) && isString(value.head_branch);
  const status = value.status === null || isString(value.status);
  const conclusion = value.conclusion === null || isString(value.conclusion);
  return identity && status && conclusion;
};
const readRuns = async (repo: string, sha: string): Promise<WorkflowRun[]> => {
  const executions = await readCollection(repo, `actions/runs?head_sha=${sha}`, 'workflow_runs', isWorkflowRun);
  return executions.every(execution => execution.head_sha === sha) ? executions : unavailable();
};
const successful = (execution: WorkflowRun): boolean =>
  execution.status === 'completed' && ['success', 'neutral', 'skipped'].some(conclusion => conclusion === execution.conclusion);

const glob = (pattern: string): RegExp => {
  if (pattern.length === 0 || /\?|\+|\[|\]|\\/u.test(pattern)) {
    return unavailable();
  }
  const tokens = [...pattern.matchAll(/\*\*\/|\*\*|\*|[^*]/gu)].map(match => match[0]);
  const expression = tokens
    .map(token => {
      switch (token) {
        case '**/': {
          return '(?:.*/)?';
        }
        case '**': {
          return '.*';
        }
        case '*': {
          return '[^/]*';
        }
        default: {
          return token.replaceAll(/[.(){}^$|]/gu, '\\$&');
        }
      }
    })
    .join('');
  return new RegExp(`^${expression}$`, 'u');
};
const matches = (value: string, patterns: string[], exclude = false): boolean => {
  const entries = patterns.map(pattern => {
    const negative = pattern.startsWith('!');
    if (exclude && negative) {
      return unavailable();
    }
    return { negative, regex: glob(negative ? pattern.slice(1) : pattern) };
  });
  if (!entries.some(entry => !entry.negative)) {
    return unavailable();
  }
  let included = false;
  for (const entry of entries) {
    if (entry.regex.test(value)) {
      included = !entry.negative;
    }
  }
  return exclude ? !included : included;
};
const branchMatches = (config: BranchFilters, branch: string): boolean => {
  if (config.branches && config[BRANCH_IGNORE]) {
    return unavailable();
  }
  if (config.branches) {
    return matches(branch, config.branches);
  }
  return config[BRANCH_IGNORE] ? matches(branch, config[BRANCH_IGNORE], true) : true;
};

interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}
interface CommitFiles {
  sha: string;
  files: ChangedFile[];
}
const isChangedFile = (value: unknown): value is ChangedFile => {
  if (!isFields(value) || !isString(value.filename) || !isString(value.status)) {
    return false;
  }
  return value.status !== 'renamed' || isString(value.previous_filename);
};
const isCommitFiles = (value: unknown): value is CommitFiles => {
  if (!isFields(value) || !isString(value.sha)) {
    return false;
  }
  return Array.isArray(value.files) && value.files.every(isChangedFile);
};
const changedPaths = async (repo: string, sha: string, page = 1, paths: string[] = [], count = 0): Promise<string[]> => {
  const commit = await api(repo, `commits/${sha}?per_page=100&page=${page}`, isCommitFiles);
  if (commit.sha !== sha) {
    return unavailable();
  }
  for (const file of commit.files) {
    paths.push(file.filename);
    if (file.previous_filename !== undefined) {
      paths.push(file.previous_filename);
    }
  }
  const total = count + commit.files.length;
  if (total >= 3000) {
    return unavailable();
  }
  return commit.files.length < 100 ? paths : await changedPaths(repo, sha, page + 1, paths, total);
};
const pushApplies = (push: PushFilters | null | undefined, branch: string, files: string[]): boolean => {
  if (push === undefined) {
    return false;
  }
  if (push === null) {
    return true;
  }
  const tagsOnly = (push.tags !== undefined || push[TAG_IGNORE] !== undefined) && !push.branches && !push[BRANCH_IGNORE];
  if (tagsOnly || !branchMatches(push, branch)) {
    return false;
  }
  if (push.paths && push[PATH_IGNORE]) {
    return unavailable();
  }
  const included = push.paths;
  if (included) {
    return files.some(file => matches(file, included));
  }
  const ignored = push[PATH_IGNORE];
  return ignored ? files.some(file => matches(file, ignored, true)) : true;
};

interface PullBase {
  base: { ref: string };
}
const isPullBase = (value: unknown): value is PullBase => {
  if (!isFields(value) || !isFields(value.base)) {
    return false;
  }
  return isString(value.base.ref);
};
type ExpectedRuns = Map<number, Set<string>>;
const chainApplies = (workflow: Workflow, workflows: Workflow[], executions: WorkflowRun[], branch: string, expected: ExpectedRuns): boolean => {
  const { chain } = workflow;
  if (!chain || !branchMatches(chain, branch)) {
    return false;
  }
  if (chain.types?.some(type => !['completed', 'requested', 'in_progress'].includes(type)) === true) {
    return unavailable();
  }
  return workflows.some(candidate => {
    if (!matches(candidate.name, chain.workflows)) {
      return false;
    }
    return expected.has(candidate.id) || executions.some(execution => execution.workflow_id === candidate.id && execution.head_branch === branch);
  });
};
const addChains = (workflows: Workflow[], executions: WorkflowRun[], branch: string, expected: ExpectedRuns): void => {
  for (const workflow of workflows) {
    if (chainApplies(workflow, workflows, executions, branch, expected)) {
      const events = expected.get(workflow.id) ?? new Set<string>();
      events.add('workflow_run');
      expected.set(workflow.id, events);
    }
  }
};
const expectedComplete = (executions: WorkflowRun[], branch: string, expected: ExpectedRuns): boolean => {
  for (const [id, events] of expected) {
    for (const event of events) {
      if (!executions.some(execution => execution.workflow_id === id && execution.event === event && execution.head_branch === branch)) {
        return false;
      }
    }
  }
  return true;
};

/** Checks workflows for the merged commit. Missing evidence does not permit teardown. */
export const postMergeReady = async (repo: string, proof: FinishPullRequest): Promise<boolean> => {
  try {
    const paths = await workflowPaths(repo, proof.mergeCommit);
    if (paths.length === 0) {
      return true;
    }
    const workflows = await activeWorkflows(repo, proof.mergeCommit, paths);
    const executions = await readRuns(repo, proof.mergeCommit);
    if (!executions.every(successful)) {
      return false;
    }
    if (workflows.every(workflow => workflow.push === undefined && !workflow.chain)) {
      return true;
    }
    const pull = await api(repo, `pulls/${proof.number}`, isPullBase);
    const needsFiles = workflows.some(workflow => workflow.push?.paths ?? workflow.push?.[PATH_IGNORE]);
    const files = needsFiles ? await changedPaths(repo, proof.mergeCommit) : [];
    const expected: ExpectedRuns = new Map();
    for (const workflow of workflows) {
      if (pushApplies(workflow.push, pull.base.ref, files)) {
        expected.set(workflow.id, new Set(['push']));
      }
    }
    addChains(workflows, executions, pull.base.ref, expected);
    return expectedComplete(executions, pull.base.ref, expected);
  } catch {
    return false;
  }
};
