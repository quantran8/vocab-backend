import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { CONTENT_STATUS, DEFAULT_ACCENT, LEARNING_LANGUAGE, MEANING_ORIGIN } from '../../common/constants/domain';
import { newId } from '../../common/ids';
import { Executor, Tx } from '../../db/db';
import {
  activeMeaningPublications, collectionLocalizations, collections, exampleLocalizations, meaningExamples, meaningLocalizations,
  meaningPublications, meanings, pronunciations, topicLocalizations, topicMeanings, topics, words, wordTypes,
} from '../../db/schema';
import { MeaningSnapshot } from '../../modules/practice-resolver/task.types';
import { chunk } from '../jsonl';
import { LoadPlan } from './load-plan';

// Keeps every statement below Postgres' 65535 bind-parameter limit; one statement per chunk, not per row.
const ROWS_PER_STATEMENT = 1000;
async function inChunks<T>(rows: T[], write: (part: T[]) => Promise<unknown>) {
  for (const part of chunk(rows, ROWS_PER_STATEMENT)) await write(part);
}

const lemmaKey = sql`lower(btrim(${words.lemma}))`;

/** Upserts the plan's catalog and word tree. Ids come from the build files, so a re-run updates rows in place. */
export async function writeContent(tx: Tx, plan: LoadPlan, editorialState: string) {
  const [collection] = await tx
    .insert(collections)
    .values({ slug: plan.collection.slug, title: plan.collection.title, color: plan.collection.color, status: CONTENT_STATUS.PUBLISHED })
    .onConflictDoUpdate({ target: collections.slug, set: { title: plan.collection.title, color: plan.collection.color, status: CONTENT_STATUS.PUBLISHED } })
    .returning({ id: collections.id });
  const topicRows = await tx
    .insert(topics)
    // An empty topic stays hidden until a later run fills it.
    .values(plan.topics.map((t) => ({
      collectionId: collection.id, slug: t.slug, title: t.title, iosIcon: t.iosIcon, status: t.meaningIds.length > 0 ? CONTENT_STATUS.PUBLISHED : CONTENT_STATUS.DRAFT,
    })))
    .onConflictDoUpdate({ target: [topics.collectionId, topics.slug], set: { title: sql`excluded.title`, iosIcon: sql`excluded.ios_icon`, status: sql`excluded.status` } })
    .returning({ id: topics.id, slug: topics.slug });
  const topicId = new Map(topicRows.map((t) => [t.slug, t.id]));

  const catalog = plan.catalogLocalizations;
  if (catalog.length > 0) {
    await tx
      .insert(collectionLocalizations)
      .values(catalog.map((c) => ({ collectionId: collection.id, locale: c.locale, ...c.collection })))
      .onConflictDoUpdate({ target: [collectionLocalizations.collectionId, collectionLocalizations.locale], set: { title: sql`excluded.title`, description: sql`excluded.description` } });
    const topicLocales = catalog.flatMap((c) => plan.topics.flatMap((t) => (c.topics[t.slug] ? [{ topicId: topicId.get(t.slug)!, locale: c.locale, ...c.topics[t.slug] }] : [])));
    await inChunks(topicLocales, (part) => tx
      .insert(topicLocalizations)
      .values(part)
      .onConflictDoUpdate({ target: [topicLocalizations.topicId, topicLocalizations.locale], set: { title: sql`excluded.title`, description: sql`excluded.description` } }));
  }

  // Attach to an existing word (a seed or a learner's custom word) before creating one; unkeyed words win.
  const lemmas = [...new Set(plan.meanings.map((m) => m.lemma))];
  const existing = await tx
    .select({ id: words.id, lemma: lemmaKey })
    .from(words)
    .where(and(eq(words.language, LEARNING_LANGUAGE), inArray(lemmaKey, lemmas)))
    .orderBy(sql`${words.homographKey} NULLS LAST`);
  const wordId = new Map<string, string>();
  for (const w of existing.toReversed()) wordId.set(w.lemma as string, w.id);
  const newWords = lemmas.filter((l) => !wordId.has(l)).map((lemma) => ({ id: newId(), language: LEARNING_LANGUAGE, lemma }));
  await inChunks(newWords, (part) => tx.insert(words).values(part));
  for (const w of newWords) wordId.set(w.lemma, w.id);

  const typePairs = [...new Map(plan.meanings.map((m) => [`${m.lemma}|${m.pos}`, { wordId: wordId.get(m.lemma)!, partOfSpeech: m.pos }])).values()];
  const typeRows: { id: string; wordId: string; partOfSpeech: string }[] = [];
  await inChunks(typePairs, async (part) => typeRows.push(...await tx
    .insert(wordTypes)
    .values(part.map((p) => ({ id: newId(), ...p })))
    .onConflictDoUpdate({ target: [wordTypes.wordId, wordTypes.partOfSpeech], set: { partOfSpeech: sql`excluded.part_of_speech` } })
    .returning({ id: wordTypes.id, wordId: wordTypes.wordId, partOfSpeech: wordTypes.partOfSpeech })));
  const typeId = new Map(typeRows.map((t) => [`${t.wordId}|${t.partOfSpeech}`, t.id]));

  await inChunks(plan.meanings, (part) => tx
    .insert(meanings)
    .values(part.map((m) => ({
      id: m.meaningId, typeId: typeId.get(`${wordId.get(m.lemma)}|${m.pos}`)!, cefrLevel: m.cefrLevel, coreDefinition: m.coreDefinition,
      popularity: m.popularity, origin: MEANING_ORIGIN.CURATED,
    })))
    .onConflictDoUpdate({ target: meanings.id, set: { cefrLevel: sql`excluded.cefr_level`, coreDefinition: sql`excluded.core_definition`, popularity: sql`excluded.popularity` } }));

  // Audio is set elsewhere; only the IPA comes from the pipeline.
  await inChunks(plan.meanings, (part) => tx
    .insert(pronunciations)
    .values(part.map((m) => ({ id: newId(), meaningId: m.meaningId, accentLocale: DEFAULT_ACCENT, ipa: m.ipaUs })))
    .onConflictDoUpdate({ target: [pronunciations.meaningId, pronunciations.accentLocale], set: { ipa: sql`excluded.ipa` } }));

  const examples = plan.meanings.flatMap((m) => m.examples.map((e) => ({ id: e.exampleId, meaningId: m.meaningId, sourceText: e.text, targetLocator: { start: e.start, end: e.end } })));
  await inChunks(examples, (part) => tx
    .insert(meaningExamples)
    .values(part)
    .onConflictDoUpdate({ target: meaningExamples.id, set: { sourceText: sql`excluded.source_text`, targetLocator: sql`excluded.target_locator` } }));

  const localizations = plan.meanings.flatMap((m) => m.localizations.map((l) => ({ m, l })));
  await inChunks(localizations, (part) => tx
    .insert(meaningLocalizations)
    .values(part.map(({ m, l }) => ({
      meaningId: m.meaningId, locale: l.locale, meaningText: l.meaningText, definitionText: l.definitionText,
      editorialState: editorialState as never, origin: MEANING_ORIGIN.CURATED,
    })))
    .onConflictDoUpdate({
      target: [meaningLocalizations.meaningId, meaningLocalizations.locale],
      set: { meaningText: sql`excluded.meaning_text`, definitionText: sql`excluded.definition_text`, editorialState: sql`excluded.editorial_state`, updatedAt: sql`now()` },
    }));
  const exampleTranslations = localizations.flatMap(({ m, l }) => m.examples.map((e, i) => ({ exampleId: e.exampleId, locale: l.locale, translationText: l.exampleTranslations[i] })));
  await inChunks(exampleTranslations, (part) => tx
    .insert(exampleLocalizations)
    .values(part)
    .onConflictDoUpdate({ target: [exampleLocalizations.exampleId, exampleLocalizations.locale], set: { translationText: sql`excluded.translation_text` } }));

  // Ranks are rewritten as a whole: curated_rank is unique per topic.
  const links = plan.topics.flatMap((t) => t.meaningIds.map((meaningId, i) => ({ topicId: topicId.get(t.slug)!, meaningId, curatedRank: i + 1 })));
  await tx.delete(topicMeanings).where(inArray(topicMeanings.topicId, [...topicId.values()]));
  await inChunks(links, (part) => tx.insert(topicMeanings).values(part));

  return { collectionId: collection.id, words: newWords.length };
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v));

/** Adds a revision only where the snapshot changed, so re-running the load leaves published content alone. */
export async function publishSnapshots(tx: Executor, locale: string, snapshots: MeaningSnapshot[], now: Date) {
  if (snapshots.length === 0) return 0;
  const ids = snapshots.map((s) => s.meaningId);
  const active = await tx
    .select({ meaningId: activeMeaningPublications.meaningId, snapshot: meaningPublications.snapshot, recalledAt: activeMeaningPublications.recalledAt })
    .from(activeMeaningPublications)
    .innerJoin(meaningPublications, eq(meaningPublications.id, activeMeaningPublications.publicationId))
    .where(and(eq(activeMeaningPublications.locale, locale), inArray(activeMeaningPublications.meaningId, ids)));
  const current = new Map(active.map((a) => [a.meaningId, a.recalledAt ? null : canonical(a.snapshot)]));
  const changed = snapshots.filter((s) => current.get(s.meaningId) !== canonical(s));
  if (changed.length === 0) return 0;

  const revisions = await tx
    .select({ meaningId: meaningPublications.meaningId, revision: max(meaningPublications.revision) })
    .from(meaningPublications)
    .where(and(eq(meaningPublications.locale, locale), inArray(meaningPublications.meaningId, changed.map((s) => s.meaningId))))
    .groupBy(meaningPublications.meaningId);
  const lastRevision = new Map(revisions.map((r) => [r.meaningId, r.revision ?? 0]));
  const rows = changed.map((snapshot) => ({
    id: newId(), meaningId: snapshot.meaningId, locale, revision: (lastRevision.get(snapshot.meaningId) ?? 0) + 1, snapshot, approvedAt: now, publishedAt: now,
  }));
  await inChunks(rows, (part) => tx.insert(meaningPublications).values(part));
  await inChunks(rows, (part) => tx
    .insert(activeMeaningPublications)
    .values(part.map((r) => ({ meaningId: r.meaningId, locale, publicationId: r.id })))
    .onConflictDoUpdate({
      target: [activeMeaningPublications.meaningId, activeMeaningPublications.locale],
      set: { publicationId: sql`excluded.publication_id`, recalledAt: null },
    }));
  return rows.length;
}

