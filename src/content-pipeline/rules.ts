import { CEFR_LEVELS, CefrLevel } from '../common/constants/domain';

// Code-side checks on AI output: docs/content-sources.md §5.
export const ABOVE_LEVEL_ALLOWANCE = 2;

const levelIndex = (level: string) => CEFR_LEVELS.indexOf(level as CefrLevel);

/** Finds `target` in `text` and accepts it only when it is a known form of the headword. */
export function locateTarget(text: string, target: string, forms: string[]): { start: number; end: number } | null {
  const wanted = target.trim();
  if (!wanted) return null;
  const known = new Set(forms.map((f) => f.toLowerCase()));
  if (!known.has(wanted.toLowerCase())) return null;
  const pattern = new RegExp(`(?<![\\p{L}'])${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu');
  const match = pattern.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

const IRREGULAR_NEGATIVES: Record<string, string> = { ca: 'can', wo: 'will', sha: 'shall' };

function baseOfContraction(word: string) {
  const negative = /^(.+)n['’]t$/.exec(word);
  if (negative) return IRREGULAR_NEGATIVES[negative[1]] ?? negative[1];
  return word.replace(/['’](s|re|ve|ll|d|m)$/, '');
}

export function tokens(text: string): { word: string; capitalizedMidSentence: boolean }[] {
  const out: { word: string; capitalizedMidSentence: boolean }[] = [];
  const re = /\p{L}+(?:['’]\p{L}+)*/gu;
  let sentenceStart = true;
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (/[.!?]/.test(text.slice(last, match.index))) sentenceStart = true;
    out.push({ word: baseOfContraction(match[0].toLowerCase()), capitalizedMidSentence: !sentenceStart && /^\p{Lu}/u.test(match[0]) });
    sentenceStart = false;
    last = match.index + match[0].length;
  }
  return out;
}

/** Words in an example that a learner at `level` is not expected to know, ignoring the headword and names. */
export function wordsAboveLevel(text: string, level: CefrLevel, levelOfForm: Record<string, CefrLevel>, headwordForms: string[]) {
  const own = new Set(headwordForms.map((f) => f.toLowerCase()));
  return tokens(text)
    .filter((t) => !t.capitalizedMidSentence && !own.has(t.word) && t.word.length > 1)
    .filter((t) => {
      const known = levelOfForm[t.word];
      return !known || levelIndex(known) > levelIndex(level);
    })
    .map((t) => t.word);
}

const IPA = /^\/[a-zæɑɒɔəɚɛɜɝɪʊʌθðʃʒŋɡɹɾʔːˈˌ.‿ ̩̃]+\/$/u;
export const isValidIpa = (ipa: string) => IPA.test(ipa);

export const isLevelAtLeast = (level: string, floor: string) => levelIndex(level) >= levelIndex(floor);
export const isLevelAtMost = (level: string, ceiling: string) => levelIndex(level) >= 0 && levelIndex(level) <= levelIndex(ceiling);
