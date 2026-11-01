import { eq, max } from 'drizzle-orm';
import { CONTENT_STATUS, DEFAULT_ACCENT, DEFAULT_LOCALE, EDITORIAL_STATE, LEARNING_LANGUAGE, PartOfSpeech } from '../common/constants/domain';
import { Db } from '../db/db';
import { collections, topicMeanings, topics } from '../db/schema';
import { AdminService } from '../modules/admin/admin.service';
import { PublicationService } from '../modules/admin/publication.service';

export interface SeedWord {
  lemma: string;
  partOfSpeech: PartOfSpeech;
  ipa: string;
  cefrLevel: string;
  meaningText: string;
  definitionText: string;
  example: string;
  translation: string;
  audioUrl?: string;
}

export interface SeedServices {
  db: Db;
  admin: AdminService;
  publications: PublicationService;
}

/** Sequential on purpose: content authoring goes through the same validators as the admin API. */
export async function seedTopic({ db, admin, publications }: SeedServices, slug: string, words: SeedWord[]) {
  // The no-op update makes RETURNING yield the existing row on conflict.
  const [collection] = await db
    .insert(collections)
    .values({ slug, title: slug, status: CONTENT_STATUS.PUBLISHED })
    .onConflictDoUpdate({ target: collections.slug, set: { slug } })
    .returning({ id: collections.id });
  const [topic] = await db
    .insert(topics)
    .values({ collectionId: collection.id, slug, title: slug, status: CONTENT_STATUS.PUBLISHED })
    .onConflictDoUpdate({ target: [topics.collectionId, topics.slug], set: { slug } })
    .returning({ id: topics.id });

  const meaningIds: string[] = [];
  const wordIds: string[] = [];
  const pronunciationIds: string[] = [];
  for (const word of words) {
    const start = word.example.toLowerCase().indexOf(word.lemma.toLowerCase());
    const created = await admin.createWord({
      language: LEARNING_LANGUAGE,
      lemma: word.lemma,
      types: [{
        partOfSpeech: word.partOfSpeech,
        pronunciations: [{ accentLocale: DEFAULT_ACCENT, ipa: word.ipa, audioAssetKey: word.audioUrl }],
        meanings: [{
          cefrLevel: word.cefrLevel as never,
          coreDefinition: word.definitionText,
          examples: [{ sourceText: word.example, targetLocator: { start, end: start + word.lemma.length } }],
        }],
      }],
    });
    const meaning = created.types[0].meanings[0];
    await admin.putMeaningLocale(meaning.id, DEFAULT_LOCALE, {
      meaningText: word.meaningText,
      definitionText: word.definitionText,
      editorialState: EDITORIAL_STATE.APPROVED,
      exampleTranslations: [{ exampleId: meaning.examples[0].id, translationText: word.translation }],
    });
    await publications.publish(meaning.id, DEFAULT_LOCALE);
    meaningIds.push(meaning.id);
    wordIds.push(created.wordId);
    pronunciationIds.push(created.types[0].pronunciations[0].id);
  }

  const [{ top }] = await db.select({ top: max(topicMeanings.curatedRank) }).from(topicMeanings).where(eq(topicMeanings.topicId, topic.id));
  const offset = top ?? 0;
  await db.insert(topicMeanings).values(meaningIds.map((meaningId, index) => ({ topicId: topic.id, meaningId, curatedRank: offset + index + 1 })));
  return { collectionId: collection.id, topicId: topic.id, meaningIds, wordIds, pronunciationIds };
}
