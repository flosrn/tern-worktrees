interface StopWords {
  readonly [word: string]: boolean | undefined;
}
const STOP_WORDS: StopWords = {
  a: true,
  an: true,
  and: true,
  au: true,
  aux: true,
  de: true,
  des: true,
  du: true,
  en: true,
  et: true,
  for: true,
  in: true,
  la: true,
  le: true,
  les: true,
  of: true,
  on: true,
  the: true,
  to: true,
  un: true,
  une: true,
};

/** Derives the issue branch name from its title, type and the configured fix labels. */
export const issueBranchName = (number: number, title: string, issueType: { name: string } | null | undefined, labels: { name: string }[], fixLabels: string[]): string => {
  const prefix = issueType?.name === 'Bug' || labels.some(label => fixLabels.some(fixLabel => fixLabel.toLowerCase() === label.name.toLowerCase())) ? 'fix' : 'feat';
  const words = title
    .replace(/^\s*\[[^\]]*\]/u, '')
    .replaceAll(/\(#[0-9]+\)|#[0-9]+/gu, '')
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/['"‘’‚‛“”„‟«»‹›]/gu, '')
    .split(/[^a-z0-9]/u)
    .filter(word => word !== '' && STOP_WORDS[word] !== true)
    .slice(0, 5);
  let slug = '';
  for (const word of words) {
    const candidate = slug === '' ? word : `${slug}-${word}`;
    if (candidate.length > 40) {
      break;
    }
    slug = candidate;
  }
  const suffix = slug === '' ? '' : `-${slug}`;
  return `${prefix}/${number}${suffix}`;
};
