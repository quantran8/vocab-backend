import { APP_LOCALES, CEFR_LEVELS, CefrLevel, PartOfSpeech } from '../../common/constants/domain';
import { EntryReview, GeneratedEntry, GeneratedExample, RankedLemma, TranslatedMeaning, TranslationReview } from '../build.types';
import { CollectionSpec } from '../collections/collection.types';
import { JsonlStore } from '../jsonl';
import { Lexicon } from '../lexicon/lexicon.types';
import { CLASH_LOCALE, clashingMeaningIds, translationClashes } from './clashes';
import { lemmaGroups, popularities } from './rank';
import { isReviewCurrent } from './review';
import { localizedCatalog, localizedMeaning, SOURCE_LOCALE } from './translate';
import { isTranslationApproved, isTranslationReviewCurrent } from './translation-review';

/** A meaning ships in every app locale or not at all. */
export const REQUIRED_LOCALES: readonly string[] = APP_LOCALES;

export interface PlannedLocalization { locale: string; meaningText: string; definitionText: string; exampleTranslations: string[] }

export interface PlannedMeaning {
  meaningId: string;
  lemma: string;
  pos: PartOfSpeech;
  cefrLevel: CefrLevel;
  coreDefinition: string;
  popularity: number;
  ipaUs: string;
  topic: string;
  examples: GeneratedExample[];
  localizations: PlannedLocalization[];
}

export interface LoadPlan {
  collection: { slug: string; title: string; color: string };
  topics: { slug: string; title: string; iosIcon: string; meaningIds: string[] }[];
  catalogLocalizations: { locale: string; collection: { title: string; description: string }; topics: Record<string, { title: string; description: string }> }[];
  meanings: PlannedMeaning[];
  report: {
    entries: number; meanings: number; ruleFailures: number; unreviewed: number; rejectedByReview: number; translationClashes: number; unranked: number;
    missingRequiredLocale: number; untranslated: Record<string, number>;
    /** Translations with no current review, or rejected by it; neither ships. */
    translationUnreviewed: Record<string, number>; translationRejected: Record<string, number>;
  };
}

/** Everything the load stage writes, decided from build files alone so it can be tested without a model or a database. */
export function buildLoadPlan(
  spec: CollectionSpec, lexicon: Lexicon, entries: GeneratedEntry[], locales: string[], translations: Map<string, JsonlStore<TranslatedMeaning>>,
  ranks: JsonlStore<RankedLemma>, reviews: JsonlStore<EntryReview>, translationReviews: Map<string, JsonlStore<TranslationReview>>,
): LoadPlan {
  const rankOf = new Map(lexicon.entries.map((e) => [e.key, e.ngslRank ?? Number.MAX_SAFE_INTEGER]));
  const untranslated: Record<string, number> = Object.fromEntries(locales.map((l) => [l, 0]));
  const translationUnreviewed: Record<string, number> = Object.fromEntries(locales.map((l) => [l, 0]));
  const translationRejected: Record<string, number> = Object.fromEntries(locales.map((l) => [l, 0]));
  let ruleFailures = 0;
  let unranked = 0;
  let unreviewed = 0;
  let rejectedByReview = 0;
  let clashing = 0;
  const vi = translations.get(CLASH_LOCALE);
  const clashes = vi ? clashingMeaningIds(translationClashes(entries, vi)) : new Set<string>();
  let missingRequiredLocale = 0;
  const popularity = new Map<string, number>();
  for (const group of lemmaGroups(entries, lexicon)) {
    for (const [id, value] of popularities(group, ranks.rows.get(group.lemma)) ?? []) popularity.set(id, value);
  }

  const meanings = entries.flatMap((entry) => entry.meanings.flatMap((m): PlannedMeaning[] => {
    if (entry.issues[m.meaningId]) { ruleFailures += 1; return []; }
    if (!isReviewCurrent(entry, reviews)) { unreviewed += 1; return []; }
    if (reviews.rows.get(entry.key)!.problems.length > 0) { rejectedByReview += 1; return []; }
    if (clashes.has(m.meaningId)) { clashing += 1; return []; }
    if (!popularity.has(m.meaningId)) { unranked += 1; return []; }
    const localizations = locales.flatMap((locale) => {
      const text = localizedMeaning(locale, entry, m, translations.get(locale) ?? null);
      if (!text) { untranslated[locale] += 1; return []; }
      if (locale !== SOURCE_LOCALE && !isTranslationApproved(text as TranslatedMeaning, translationReviews.get(locale))) {
        if (isTranslationReviewCurrent(text as TranslatedMeaning, translationReviews.get(locale))) translationRejected[locale] += 1;
        else translationUnreviewed[locale] += 1;
        return [];
      }
      return [{ locale, meaningText: text.meaningText, definitionText: text.definitionText, exampleTranslations: text.exampleTranslations }];
    });
    if (REQUIRED_LOCALES.some((locale) => !localizations.some((l) => l.locale === locale))) { missingRequiredLocale += 1; return []; }
    return [{
      meaningId: m.meaningId, lemma: entry.lemma, pos: entry.pos, cefrLevel: m.cefrLevel, coreDefinition: m.definition,
      popularity: popularity.get(m.meaningId)!, ipaUs: m.ipaUs, topic: m.topic, examples: m.examples, localizations,
    }];
  }));

  // Easier and more frequent words first inside each topic.
  const rank = (m: PlannedMeaning) => rankOf.get(`${m.lemma}|${m.pos}`) ?? Number.MAX_SAFE_INTEGER;
  const ranked = [...meanings].sort((a, b) =>
    CEFR_LEVELS.indexOf(a.cefrLevel) - CEFR_LEVELS.indexOf(b.cefrLevel) || rank(a) - rank(b) || b.popularity - a.popularity);

  return {
    collection: { slug: spec.slug, title: spec.title, color: spec.color },
    topics: spec.topics.map((t) => ({ slug: t.slug, title: t.title, iosIcon: t.iosIcon, meaningIds: ranked.filter((m) => m.topic === t.slug).map((m) => m.meaningId) })),
    catalogLocalizations: locales.flatMap((locale) => {
      const catalog = localizedCatalog(spec, locale);
      return catalog ? [{ locale, ...catalog }] : [];
    }),
    meanings,
    report: { entries: entries.length, meanings: meanings.length, ruleFailures, unreviewed, rejectedByReview, translationClashes: clashing, unranked, missingRequiredLocale, untranslated, translationUnreviewed, translationRejected },
  };
}
