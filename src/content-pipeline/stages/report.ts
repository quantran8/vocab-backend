import { EntryReview, GeneratedEntry, TranslatedMeaning } from '../build.types';
import { CLASH_LOCALE, translationClashes } from './clashes';
import { localizedMeaning, TARGET_LOCALES, translationsPath, translationStores } from './translate';
import { canRetranslate, isTranslationRejected, translationReviewStores } from './translation-review';
import { CollectionSpec } from '../collections/collection.types';
import { JsonlStore, readJson } from '../jsonl';
import { Lexicon } from '../lexicon/lexicon.types';
import { LEXICON_FILE } from '../paths';
import { currentEntries, generatedPath, MAX_ATTEMPTS, selectEntries } from './generate';
import { rejectedKeys, reviewsPath } from './review';
import { planFromBuild } from './load';

/** What a load would write now, and which generated meanings need another run or a human look. */
export function report(spec: CollectionSpec, verbose: boolean) {
  const selected = selectEntries(spec, readJson<Lexicon>(LEXICON_FILE));
  const store = new JsonlStore<GeneratedEntry>(generatedPath(spec));
  const rows = selected.flatMap((e) => store.rows.get(e.key) ?? []);
  const issues = rows.flatMap((r) => Object.entries(r.issues).flatMap(([meaningId, list]) => list.map((issue) => ({ key: r.key, meaningId, issue }))));
  const byKind = new Map<string, number>();
  for (const { issue } of issues) {
    const kind = issue.replace(/"[^"]*"/g, '…').replace(/:.*/, '').replace(/example \d+/, 'example');
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }

  console.log(`${spec.slug}: ${selected.length} selected, ${rows.length} generated, ${selected.length - rows.length} pending`);
  console.log(`skipped by model: ${rows.filter((r) => r.skipped).length}`);
  console.log('rule issues:', Object.fromEntries([...byKind].sort((a, b) => b[1] - a[1])));
  if (verbose) for (const { key, issue } of issues) console.log(`  ${key}: ${issue}`);
  const reviews = new JsonlStore<EntryReview>(reviewsPath(spec));
  const current = new Set(rows.filter((r) => r.promptVersion === spec.promptVersion).map((r) => r.key));
  const rejected = new Set([...rejectedKeys(store, reviews)].filter((k) => current.has(k)));
  const stuck = [...rejected].filter((k) => (store.rows.get(k)!.attempts ?? 1) >= MAX_ATTEMPTS);
  console.log(`review: ${rejected.size} entries rejected, ${stuck.length} of them after ${MAX_ATTEMPTS} attempts (need a human)`);
  const lexicon = readJson<Lexicon>(LEXICON_FILE);
  const live = currentEntries(spec, lexicon, store);
  const clashes = translationClashes(live, new JsonlStore<TranslatedMeaning>(translationsPath(spec, CLASH_LOCALE)));
  console.log(`translation clashes (${CLASH_LOCALE}): ${clashes.length}`);
  for (const c of clashes) console.log(`  ${c.problem}`);
  if (verbose || stuck.length) {
    for (const key of verbose ? rejected : stuck) {
      for (const p of reviews.rows.get(key)!.problems) console.log(`  ${key} ${p.kind}${p.gloss ? ` (${p.gloss})` : ''}: ${p.note}`);
    }
  }
  // A translation rejected MAX_ATTEMPTS times is left for a human, like a stuck entry.
  const translations = translationStores(spec);
  const translationReviews = translationReviewStores(spec);
  for (const locale of TARGET_LOCALES) {
    const reviewsOf = translationReviews.get(locale)!;
    const rejectedHere = live.flatMap((e) => e.meanings.flatMap((m) => {
      const t = localizedMeaning(locale, e, m, translations.get(locale)!) as TranslatedMeaning | null;
      return t && isTranslationRejected(t, reviewsOf) ? [{ e, m, t }] : [];
    }));
    const stuckHere = rejectedHere.filter(({ t }) => !canRetranslate(t));
    if (rejectedHere.length) console.log(`translation review ${locale}: ${rejectedHere.length} rejected, ${stuckHere.length} after ${MAX_ATTEMPTS} attempts (need a human)`);
    for (const { e, m, t } of verbose ? rejectedHere : stuckHere) {
      for (const p of reviewsOf.rows.get(m.meaningId)!.problems) console.log(`  ${locale} ${e.lemma} "${m.gloss}" = "${t.meaningText}": ${p.kind}: ${p.note}`);
    }
  }
  const plan = planFromBuild(spec);
  console.log('load plan:', JSON.stringify(plan.report));
  console.log('topics:', Object.fromEntries(plan.topics.map((t) => [t.slug, t.meaningIds.length])));
}
