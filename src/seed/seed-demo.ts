import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CefrLevel, CONTENT_STATUS, DEFAULT_ACCENT, DEFAULT_LOCALE, EDITORIAL_STATE, ITEM_STATUS, LEARNING_LANGUAGE, PartOfSpeech, Template, Variant,
} from '../common/constants/domain';
import { Db } from '../db/db';
import {
  activeMeaningPublications, collectionLocalizations, collections, exampleLocalizations, meaningExamples,
  meaningLocalizations, meaningPublications, meanings, practiceItemLocalizations, practiceItems, practiceItemTargets,
  pronunciations, topicLocalizations, topicMeanings, topics, words, wordTypes,
} from '../db/schema';
import { newId } from '../common/ids';
import { MeaningSnapshot } from '../modules/practice-resolver/task.types';
import { AuthoredItem, toRuntimeContent } from './curated-items';
import curatedItems from './data/curated-items.json';
import vocabPack2 from './data/vocab-pack-2.json';
import vocab from './data/vocab.json';

const SNAPSHOT_REVISION = 1;

// Ids come from the data files so curated items can reference them; everything is idempotent.
export async function seedDemoContent(db: Db) {
  const now = new Date();
  const topicRows = [...vocab.collections.flatMap((c) => c.topics.map((t) => ({ ...t, collectionId: c.id }))), ...vocabPack2.topics];
  const wordList = [...vocab.words, ...vocabPack2.words];
  const publicationIds = new Map(wordList.map((w) => [w.meaning.id, newId()]));
  const authoredItems = [...curatedItems.items, ...vocabPack2.items] as unknown as AuthoredItem[];

  await db.transaction(async (tx) => {
    await tx.insert(collections).values(vocab.collections.map((c) => ({ id: c.id, slug: c.slug, title: c.title, status: CONTENT_STATUS.PUBLISHED }))).onConflictDoNothing();
    await tx.insert(collectionLocalizations).values(vocab.collections.map((c) => ({ collectionId: c.id, locale: DEFAULT_LOCALE, ...c.vi }))).onConflictDoNothing();
    await tx.insert(topics).values(topicRows.map((t) => ({ id: t.id, collectionId: t.collectionId, slug: t.slug, title: t.title, status: CONTENT_STATUS.PUBLISHED }))).onConflictDoNothing();
    await tx.insert(topicLocalizations).values(topicRows.map((t) => ({ topicId: t.id, locale: DEFAULT_LOCALE, ...t.vi }))).onConflictDoNothing();

    // A custom word may already own a lemma, so attach to its rows. NULLS LAST lets the unkeyed word win in the Map.
    const existingWords = await tx
      .select({ id: words.id, lemma: sql<string>`lower(btrim(${words.lemma}))` })
      .from(words)
      .where(and(eq(words.language, LEARNING_LANGUAGE), inArray(sql`lower(btrim(${words.lemma}))`, wordList.map((w) => w.lemma.toLowerCase()))))
      .orderBy(sql`${words.homographKey} NULLS LAST`);
    const existingWordIds = new Map(existingWords.map((w) => [w.lemma, w.id]));
    const newWords = wordList.filter((w) => !existingWordIds.has(w.lemma.toLowerCase()));
    if (newWords.length > 0) await tx.insert(words).values(newWords.map((w) => ({ id: w.id, language: LEARNING_LANGUAGE, lemma: w.lemma })));
    const wordIdOf = (lemma: string, fallback: string) => existingWordIds.get(lemma.toLowerCase()) ?? fallback;

    // The no-op update makes RETURNING yield the existing row on conflict.
    const typeRows = await tx
      .insert(wordTypes)
      .values(wordList.map((w) => ({ id: w.typeId, wordId: wordIdOf(w.lemma, w.id), partOfSpeech: w.partOfSpeech as PartOfSpeech })))
      .onConflictDoUpdate({ target: [wordTypes.wordId, wordTypes.partOfSpeech], set: { partOfSpeech: sql`excluded.part_of_speech` } })
      .returning({ id: wordTypes.id, wordId: wordTypes.wordId, partOfSpeech: wordTypes.partOfSpeech });
    const typeIds = new Map(typeRows.map((t) => [`${t.wordId}:${t.partOfSpeech}`, t.id]));
    const typeIdOf = (w: (typeof wordList)[number]) => typeIds.get(`${wordIdOf(w.lemma, w.id)}:${w.partOfSpeech}`)!;

    // Same rule as a pool write: a row left by a private meaning gives way, one behind shared content stays.
    await tx
      .insert(pronunciations)
      .values(wordList.map((w) => ({ id: w.pronunciation.id, typeId: typeIdOf(w), accentLocale: DEFAULT_ACCENT, ipa: w.pronunciation.ipa })))
      .onConflictDoUpdate({
        target: [pronunciations.typeId, pronunciations.accentLocale],
        set: { ipa: sql`excluded.ipa` },
        setWhere: sql`NOT EXISTS (SELECT 1 FROM meanings m WHERE m.type_id = pronunciations.type_id AND m.owner_user_id IS NULL)`,
      });
    const pronunciationRows = await tx
      .select({ id: pronunciations.id, typeId: pronunciations.typeId, ipa: pronunciations.ipa })
      .from(pronunciations)
      .where(and(inArray(pronunciations.typeId, typeRows.map((t) => t.id)), eq(pronunciations.accentLocale, DEFAULT_ACCENT)));
    const pronunciationByType = new Map(pronunciationRows.map((p) => [p.typeId, p]));
    const pronunciationOf = (w: (typeof wordList)[number]) => pronunciationByType.get(typeIdOf(w))!;
    const pronunciationIds = new Map(wordList.map((w) => [w.pronunciation.id, pronunciationOf(w).id]));

    const snapshots = wordList.map((w): MeaningSnapshot => {
      const pronunciation = pronunciationOf(w);
      return {
        wordId: wordIdOf(w.lemma, w.id),
        lemma: w.lemma,
        typeId: typeIdOf(w),
        partOfSpeech: w.partOfSpeech,
        meaningId: w.meaning.id,
        cefrLevel: w.meaning.cefrLevel,
        meaningText: w.meaning.text,
        definitionText: w.meaning.definition,
        pronunciations: [{ id: pronunciation.id, accentLocale: DEFAULT_ACCENT, ipa: pronunciation.ipa ?? w.pronunciation.ipa, audioUrl: null }],
        examples: [{ text: w.example.text, translation: w.example.translation, targetLocator: { start: w.example.start, end: w.example.end } }],
      };
    });
    const lookup = {
      ipaByPronunciation: new Map(wordList.map((w) => [w.pronunciation.id, pronunciationOf(w).ipa ?? w.pronunciation.ipa])),
      meaningTextByMeaning: new Map(wordList.map((w) => [w.meaning.id, w.meaning.text])),
    };
    const items = authoredItems.map((item) => ({ item, content: toRuntimeContent(item, lookup) }));

    await tx.insert(meanings).values(wordList.map((w) => ({ id: w.meaning.id, typeId: typeIdOf(w), cefrLevel: w.meaning.cefrLevel as CefrLevel, coreDefinition: w.meaning.coreDefinition }))).onConflictDoNothing();
    await tx.insert(meaningExamples).values(wordList.map((w) => ({
      id: w.example.id, meaningId: w.meaning.id, sourceText: w.example.text, targetLocator: { start: w.example.start, end: w.example.end },
    }))).onConflictDoNothing();
    await tx.insert(meaningLocalizations).values(wordList.map((w) => ({
      meaningId: w.meaning.id, locale: DEFAULT_LOCALE, meaningText: w.meaning.text, definitionText: w.meaning.definition, editorialState: EDITORIAL_STATE.APPROVED,
    }))).onConflictDoNothing();
    await tx.insert(exampleLocalizations).values(wordList.map((w) => ({ exampleId: w.example.id, locale: DEFAULT_LOCALE, translationText: w.example.translation }))).onConflictDoNothing();

    // Skip meanings that already have a revision so a re-run keeps the active pointer on the first publication.
    await tx.insert(meaningPublications).values(snapshots.map((snapshot) => ({
      id: publicationIds.get(snapshot.meaningId)!, meaningId: snapshot.meaningId, locale: DEFAULT_LOCALE, revision: SNAPSHOT_REVISION, snapshot, approvedAt: now,
    }))).onConflictDoNothing();
    await tx.insert(activeMeaningPublications).values(snapshots.map((s) => ({ meaningId: s.meaningId, locale: DEFAULT_LOCALE, publicationId: publicationIds.get(s.meaningId)! }))).onConflictDoNothing();

    await tx.insert(topicMeanings).values(topicRows.flatMap((t) => t.meanings.map((meaningId, index) => ({ topicId: t.id, meaningId, curatedRank: index + 1 })))).onConflictDoNothing();

    await tx.insert(practiceItems).values(items.map(({ item, content }) => ({
      id: item.id, template: item.template as Template, variant: item.variant as Variant, contextCefrLevel: item.contextCefrLevel as CefrLevel | null,
      sourceContent: content, sourceEvaluation: item.sourceEvaluation, status: ITEM_STATUS.PUBLISHED, approvedAt: now,
    }))).onConflictDoNothing();
    await tx.insert(practiceItemLocalizations).values(items.map(({ item }) => ({
      practiceItemId: item.id, locale: DEFAULT_LOCALE, localizedContent: item.localizedContent, contextualExplain: item.contextualExplain,
      editorialState: EDITORIAL_STATE.APPROVED, approvedAt: now,
    }))).onConflictDoNothing();
    await tx.insert(practiceItemTargets).values(items.flatMap(({ item }) => item.targets.map((t) => ({
      practiceItemId: item.id, ordinal: t.ordinal, meaningId: t.meaningId, pronunciationId: t.pronunciationId && pronunciationIds.get(t.pronunciationId)!,
    })))).onConflictDoNothing();
  });
}
