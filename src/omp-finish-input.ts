import { isDeepStrictEqual } from 'node:util';
import type { FinishArmed, FinishCandidate, FinishChoice, FinishKept, FinishPlan } from './finish-types.ts';
import { isJsonObject, isString } from './json.ts';
import type { FinishEvent, FinishExtensionAPI, PendingFinish, SessionFinish } from './omp-finish-types.ts';

const finishLabels: Record<FinishChoice, string> = {
  current: 'Supprimer seulement mes worktrees',
  merged: 'Supprimer aussi les autres PR fusionnées du dépôt',
  none: 'Ne rien supprimer',
};
const finishLegend = 'La livraison est terminée. Quels worktrees souhaitez-vous supprimer après le bilan final ?';

/** Parse output owned by the finish CLI, rejecting invalid envelopes before use. */
export const parseFinishPlan = (text: string): FinishPlan => {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value) || !('id' in value) || !isString(value.id)) {
    throw new Error('Invalid finish plan identifier');
  }
  if (!('candidates' in value) || !Array.isArray(value.candidates)) {
    throw new Error('Invalid finish plan response');
  }
  // SAFETY: The sibling finish CLI owns FinishPlan. Its object envelope and candidate list were examined above.
  return value as FinishPlan;
};

/** Parse the CLI arm envelope before comparing its selection with the saved targets. */
export const parseFinishArm = (text: string): FinishArmed => {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value) || !('id' in value) || !isString(value.id)) {
    throw new Error('Invalid finish arm identifier');
  }
  if (!('selected' in value) || !Array.isArray(value.selected)) {
    throw new Error('Invalid finish arm response');
  }
  // SAFETY: The sibling CLI owns FinishArmed. Selection and identifier were examined above. The consumer compares status.
  return value as FinishArmed;
};

/** The native tool must be active and attributed to the built-in source. */
export const nativeFinishAsk = (pi: FinishExtensionAPI): boolean =>
  pi.getActiveTools().includes('ask') && pi.getAllTools().some(tool => tool.name === 'ask' && tool.sourceInfo?.source === 'builtin' && tool.sourceInfo.path === '<builtin:ask>');

/** Identify only finish forms. Unrelated ask calls pass through untouched. */
export const isFinishAsk = (event: FinishEvent): boolean =>
  isJsonObject(event.input) && 'html' in event.input && isString(event.input.html) && event.input.html.includes('tern-wt-finish:');

const matchesNativeAnswer = (details: FinishEvent['details'], name: string, choice: FinishChoice): boolean => {
  if (!isJsonObject(details)) {
    return false;
  }
  if ('timedOut' in details && details.timedOut !== false) {
    return false;
  }
  if (Object.keys(details).some(key => key !== 'answers' && key !== 'timedOut')) {
    return false;
  }
  if (!('answers' in details) || !Array.isArray(details.answers) || details.answers.length !== 1) {
    return false;
  }
  return isDeepStrictEqual(details.answers[0], { answer: finishLabels[choice], name, question: finishLegend });
};

const nativeAnswerContent = (content: FinishEvent['content']): string | null => {
  if (!Array.isArray(content) || content.length !== 1) {
    return null;
  }
  const [block] = content;
  if (!isJsonObject(block) || !('type' in block) || block.type !== 'text') {
    return null;
  }
  if (!('text' in block) || !isString(block.text) || !block.text.startsWith('User answers:\n')) {
    return null;
  }
  return block.text.slice('User answers:\n'.length);
};

const parseNativeChoice = (encoded: string, name: string): FinishChoice | null => {
  if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/u.test(encoded)) {
    return null;
  }
  let values: unknown;
  try {
    values = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!isJsonObject(values) || Object.keys(values).length !== 1 || !Object.hasOwn(values, name)) {
    return null;
  }
  // SAFETY: The single string-valued JSON field and its own name were validated above.
  const fields = values as Record<string, string>;
  const choice = fields[name];
  return choice === 'current' || choice === 'merged' || choice === 'none' ? choice : null;
};

/** The two native representations must agree. Text entered through Other is not consent. */
export const finishChoice = (event: FinishEvent, pending: PendingFinish): FinishChoice | null => {
  if (event.isError === true || !isDeepStrictEqual(event.input, { html: pending.form })) {
    return null;
  }
  const encoded = nativeAnswerContent(event.content);
  if (encoded === null) {
    return null;
  }
  const name = `tern-wt-finish:${pending.plan.id}`;
  const choice = parseNativeChoice(encoded, name);
  if (choice === null || !matchesNativeAnswer(event.details, name, choice)) {
    return null;
  }
  return choice;
};

/** Freeze the targets of a current-only selection in this declared run. */
export const finishSelection = (plan: FinishPlan, state: SessionFinish, choice: Exclude<FinishChoice, 'none'>): string[] => {
  const own = new Set(state.owned);
  if (plan.current !== null) {
    own.add(plan.current);
  }
  return plan.candidates.filter(candidate => choice === 'merged' || own.has(candidate.path)).map(candidate => candidate.path);
};

/** The backend can keep a candidate, but must not expand the approved selection. */
export const validateFinishArm = (armed: FinishArmed, pending: PendingFinish, state: SessionFinish, choice: FinishChoice): void => {
  if (armed.id !== pending.plan.id || armed.status !== (choice === 'none' ? 'declined' : 'armed')) {
    throw new Error('Invalid finish arm response');
  }
  if (!isDeepStrictEqual(armed.selected.toSorted(), pending.approved[choice].toSorted())) {
    throw new Error('Invalid finish arm selection');
  }
  if (armed.selected.some(selected => state.retained?.includes(selected) === true)) {
    throw new Error('Retained finish target selected');
  }
};

const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const emptyPreview = '<p>Aucun.</p>';
const htmlPreview = (text: string): string => `<p>${escapeHtml(text)}</p>`;

const candidatePreview = (candidate: FinishCandidate): string =>
  [candidate.path, `PR #${candidate.pr.number} ${candidate.pr.url}`, `HEAD ${candidate.head}`, `PR HEAD ${candidate.pr.headRefOid}`].map(htmlPreview).join('\n');

const keptPreview = (item: FinishKept): string => {
  const lines = [item.path, item.code];
  if (item.detail !== undefined) {
    lines.push(item.detail);
  }
  return lines.map(htmlPreview).join('\n');
};

/** One semantic form shows each immutable target once, with explicit selection scopes. */
export const finishForm = (plan: FinishPlan, state: SessionFinish): string => {
  const name = escapeHtml(`tern-wt-finish:${plan.id}`);
  const current = new Set(finishSelection(plan, state, 'current'));
  const preview = (own: boolean): string =>
    plan.candidates
      .filter(candidate => current.has(candidate.path) === own)
      .map(candidatePreview)
      .join('\n') || emptyPreview;
  const kept = plan.keep.map(keptPreview).join('\n') || emptyPreview;
  return `<form id="${name}" name="${name}">
<fieldset><legend>${finishLegend}</legend>
<label><input type="radio" name="${name}" value="current" aria-describedby="${name}:current-scope">${finishLabels.current}</label>
<p id="${name}:current-scope">J’approuve uniquement la suppression des chemins de ma session et de ce run listés dans « Mes worktrees » ci-dessous, après le bilan final.</p>
<label><input type="radio" name="${name}" value="merged" aria-describedby="${name}:merged-scope">${finishLabels.merged}</label>
<p id="${name}:merged-scope">J’approuve la suppression de tous les chemins listés dans « Mes worktrees » et « Autres PR fusionnées » ci-dessous, sans ajout ultérieur, après le bilan final.</p>
<label><input type="radio" name="${name}" value="none" checked aria-describedby="${name}:none-scope">${finishLabels.none}</label>
<p id="${name}:none-scope">Je conserve tous les worktrees et cet onglet. Aucune suppression n’est approuvée.</p>
</fieldset>
<section><h2>Mes worktrees</h2>${preview(true)}</section>
<section><h2>Autres PR fusionnées</h2>${preview(false)}</section>
<section><h2>Worktrees conservés</h2>${kept}</section>
<section><h2>Avertissements</h2>${plan.warnings.map(htmlPreview).join('\n') || emptyPreview}</section>
</form>`;
};
