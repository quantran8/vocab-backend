import { DEFAULT_LOCALE } from '../../common/constants/domain';
import { GeneratedEntry, TranslatedMeaning } from '../build.types';
import { JsonlStore } from '../jsonl';
import { meaningSourceHash } from './translate';

/** The locale whose learners decide whether two meanings can be told apart. */
export const CLASH_LOCALE = DEFAULT_LOCALE;

/** Equivalents in a meaningText ("cầm, nắm (bằng tay)" → cầm, nắm), so near-synonym lists compare term by term. */
export function terms(meaningText: string): string[] {
  return meaningText
    .toLowerCase()
    .replace(/[(（][^)）]*[)）]/g, ' ')
    .split(/[,;/、，；]/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

interface Side { key: string; meaningId: string }
export interface Clash { a: Side; b: Side; problem: string }

/** Pairs of meanings of one word that share a Vietnamese equivalent: as two cards a learner could not tell them apart. */
export function translationClashes(entries: GeneratedEntry[], translations: JsonlStore<TranslatedMeaning>): Clash[] {
  const byLemma = new Map<string, { entry: GeneratedEntry; gloss: string; meaningId: string; terms: string[] }[]>();
  for (const entry of entries) {
    for (const m of entry.meanings) {
      const t = translations.rows.get(m.meaningId);
      if (!t || t.sourceHash !== meaningSourceHash(entry, m)) continue;
      byLemma.set(entry.lemma, [...(byLemma.get(entry.lemma) ?? []), { entry, gloss: m.gloss, meaningId: m.meaningId, terms: terms(t.meaningText) }]);
    }
  }
  return [...byLemma.values()].flatMap((meanings) => meanings.flatMap((a, i) => meanings.slice(i + 1).flatMap((b): Clash[] => {
    const shared = a.terms.filter((t) => b.terms.includes(t));
    if (shared.length === 0) return [];
    return [{
      a: { key: a.entry.key, meaningId: a.meaningId },
      b: { key: b.entry.key, meaningId: b.meaningId },
      problem: `duplicate (${a.entry.pos} "${a.gloss}" and ${b.entry.pos} "${b.gloss}"): both translate as "${shared.join(', ')}" in Vietnamese, so a learner cannot tell them apart; merge them into one meaning or drop one`,
    }];
  })));
}

/** Problems per entry key, fed back to the generator like a reviewer's. */
export function clashProblems(clashes: Clash[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { a, b, problem } of clashes) {
    for (const key of new Set([a.key, b.key])) out.set(key, [...(out.get(key) ?? []), problem]);
  }
  return out;
}

/** Meanings held back from loading until their entry is fixed. */
export const clashingMeaningIds = (clashes: Clash[]) => new Set(clashes.flatMap(({ a, b }) => [a.meaningId, b.meaningId]));
