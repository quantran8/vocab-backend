import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CONTENT_STATUS, DEFAULT_ACCENT, EDITORIAL_STATE, LEARNING_LANGUAGE, LEXICAL_DRAFT_KIND, LexicalDraftKind, MEANING_ORIGIN, PERSONAL_COLLECTION_SLUG, PartOfSpeech,
} from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { newId } from '../../common/ids';
import { POLICY } from '../../config/policy';
import { DB, Db, Executor, Tx } from '../../db/db';
import {
  collections, exampleLocalizations, lexicalDrafts, meaningExamples, meaningLocalizations, meanings,
  pronunciations, topicMeanings, topics, userActiveTopics, userMeaningOverrides, userSettings, wordTypes, words,
} from '../../db/schema';
import { MeaningOverride } from '../practice-resolver/meaning-override';
import { ExampleView, MeaningSnapshot } from '../practice-resolver/task.types';
import { DraftSense, TranslationDraftPayload, WordDraftPayload } from './lexical.provider';

const LANGUAGE = LEARNING_LANGUAGE;
const sameLemma = (normalized: string) => sql`${words.language} = ${LANGUAGE} AND lower(btrim(${words.lemma})) = ${normalized}`;

export type WordMatch = {
  wordId: string;
  lemma: string;
  partOfSpeech: string;
  meaningId: string;
  ownerUserId: string | null;
  snapshot: MeaningSnapshot | null;
  sourceSnapshot: MeaningSnapshot | null;
  recalled: boolean;
  hasLocalization: boolean;
  inRoadmap: boolean;
  learned: boolean;
};

export interface DraftKey {
  kind: LexicalDraftKind;
  normalizedText: string;
  locale: string;
  contextKey: string;
  meaningId?: string;
  ownerUserId?: string;
  payload: WordDraftPayload | TranslationDraftPayload;
  model: string;
}

@Injectable()
export class CustomWordsRepository {
  constructor(@Inject(DB) readonly db: Db) {}

  async locale(userId: string) {
    const [row] = await this.db.select({ locale: userSettings.explanationLocale }).from(userSettings).where(eq(userSettings.userId, userId));
    if (!row) throw new ApiError('NOT_FOUND', 'Settings not found');
    return row.locale;
  }

  // One statement for every lookup; the source snapshot is read only when the user's locale is missing.
  async findMatches(normalized: string, userId: string, locale: string) {
    const { rows } = await this.db.execute<WordMatch>(sql`
      SELECT w.id AS "wordId", w.lemma, wt.part_of_speech AS "partOfSpeech", m.id AS "meaningId", m.owner_user_id AS "ownerUserId",
        pub.snapshot, src.snapshot AS "sourceSnapshot",
        EXISTS (SELECT 1 FROM active_meaning_publications r WHERE r.meaning_id = m.id AND r.recalled_at IS NOT NULL) AS recalled,
        EXISTS (SELECT 1 FROM meaning_localizations ml WHERE ml.meaning_id = m.id AND ml.locale = ${locale}) AS "hasLocalization",
        EXISTS (SELECT 1 FROM topic_meanings tm JOIN topics t ON t.id = tm.topic_id
                WHERE tm.meaning_id = m.id AND t.owner_user_id = ${userId}::uuid) AS "inRoadmap",
        EXISTS (SELECT 1 FROM user_meaning_progress ump WHERE ump.meaning_id = m.id AND ump.user_id = ${userId}::uuid) AS learned
      FROM words w
      JOIN word_types wt ON wt.word_id = w.id
      JOIN meanings m ON m.type_id = wt.id
      LEFT JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.locale = ${locale} AND a.recalled_at IS NULL
      LEFT JOIN meaning_publications pub ON pub.id = a.publication_id
      LEFT JOIN LATERAL (
        SELECT p.snapshot FROM active_meaning_publications s
        JOIN meaning_publications p ON p.id = s.publication_id
        WHERE s.meaning_id = m.id AND s.recalled_at IS NULL
        ORDER BY s.locale LIMIT 1
      ) src ON a.meaning_id IS NULL
      WHERE w.language = ${LANGUAGE} AND lower(btrim(w.lemma)) = ${normalized}
        AND (m.owner_user_id IS NULL OR m.owner_user_id = ${userId}::uuid)
      ORDER BY m.id`);
    return rows;
  }

  async findDraft(normalizedText: string, locale: string, contextKey: string) {
    const [row] = await this.db
      .select({ id: lexicalDrafts.id, payload: lexicalDrafts.payload })
      .from(lexicalDrafts)
      .where(and(
        eq(lexicalDrafts.language, LANGUAGE), eq(lexicalDrafts.normalizedText, normalizedText),
        eq(lexicalDrafts.locale, locale), eq(lexicalDrafts.contextKey, contextKey),
      ));
    return row as { id: string; payload: WordDraftPayload } | undefined;
  }

  // The no-op update makes RETURNING yield the row a concurrent lookup already stored.
  async saveDrafts(drafts: DraftKey[]) {
    if (drafts.length === 0) return [];
    return this.db
      .insert(lexicalDrafts)
      .values(drafts.map((d) => ({ ...d, language: LANGUAGE })))
      .onConflictDoUpdate({
        target: [lexicalDrafts.language, lexicalDrafts.normalizedText, lexicalDrafts.locale, lexicalDrafts.contextKey],
        set: { language: LANGUAGE },
      })
      .returning({ id: lexicalDrafts.id, meaningId: lexicalDrafts.meaningId, payload: lexicalDrafts.payload });
  }

  translationDrafts(meaningIds: string[], locale: string) {
    if (meaningIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ id: lexicalDrafts.id, meaningId: lexicalDrafts.meaningId, payload: lexicalDrafts.payload })
      .from(lexicalDrafts)
      .where(and(
        inArray(lexicalDrafts.meaningId, meaningIds), eq(lexicalDrafts.locale, locale), eq(lexicalDrafts.kind, LEXICAL_DRAFT_KIND.TRANSLATION),
      ));
  }

  async draftById(id: string) {
    const [row] = await this.db
      .select({
        id: lexicalDrafts.id, kind: lexicalDrafts.kind, locale: lexicalDrafts.locale, meaningId: lexicalDrafts.meaningId,
        ownerUserId: lexicalDrafts.ownerUserId, payload: lexicalDrafts.payload,
      })
      .from(lexicalDrafts)
      .where(eq(lexicalDrafts.id, id));
    return row;
  }

  // Atomic: concurrent lookups cannot pass the limit together.
  async consumeLookup(userId: string, day: string) {
    const { dailyLookups } = POLICY.customWords;
    const { rowCount } = await this.db.execute(sql`
      INSERT INTO custom_word_usage (user_id, day, lookups) VALUES (${userId}::uuid, ${day}::date, 1)
      ON CONFLICT (user_id, day) DO UPDATE SET lookups = custom_word_usage.lookups + 1
      WHERE custom_word_usage.lookups < ${dailyLookups}::int`);
    if (rowCount === 0) throw new ApiError('CUSTOM_WORD_LIMIT_REACHED', 'Daily lookup limit reached');
  }

  async hasPronunciation(normalized: string, partOfSpeech: PartOfSpeech) {
    const [row] = await this.db
      .select({ id: pronunciations.id })
      .from(pronunciations)
      .innerJoin(wordTypes, eq(wordTypes.id, pronunciations.typeId))
      .innerJoin(words, eq(words.id, wordTypes.wordId))
      .where(and(sameLemma(normalized), eq(wordTypes.partOfSpeech, partOfSpeech), eq(pronunciations.accentLocale, DEFAULT_ACCENT)))
      .limit(1);
    return Boolean(row);
  }

  private async lockWord(tx: Tx, normalized: string) {
    const [row] = await tx
      .select({ id: words.id })
      .from(words)
      .where(sameLemma(normalized))
      .orderBy(sql`${words.homographKey} NULLS FIRST`)
      .limit(1)
      .for('update');
    return row?.id;
  }

  /** Check before insert: a homograph-keyed word would not conflict with a NULL key. The unique index settles races. */
  private async lockOrCreateWord(tx: Tx, lemma: string, normalized: string) {
    const existing = await this.lockWord(tx, normalized);
    if (existing) return existing;
    await tx.insert(words).values({ language: LANGUAGE, lemma }).onConflictDoNothing();
    return (await this.lockWord(tx, normalized))!;
  }

  private async ensureType(tx: Tx, wordId: string, partOfSpeech: PartOfSpeech) {
    const [row] = await tx
      .insert(wordTypes)
      .values({ wordId, partOfSpeech })
      .onConflictDoUpdate({ target: [wordTypes.wordId, wordTypes.partOfSpeech], set: { partOfSpeech } })
      .returning({ id: wordTypes.id });
    return row.id;
  }

  /** Reuses the meaning when another user confirmed the same sense of the same draft first. A MEANING draft stays private to its author. */
  async addSense(tx: Tx, input: { kind: LexicalDraftKind; draftId: string; senseIndex: number; userId: string; locale: string; lemma: string; normalized: string; sense: DraftSense; audioUrl: string | null }) {
    const { kind, draftId, senseIndex, userId, locale, lemma, normalized, sense, audioUrl } = input;
    const wordId = await this.lockOrCreateWord(tx, lemma, normalized);

    const isPrivate = kind === LEXICAL_DRAFT_KIND.MEANING;
    const { rows: [state] } = await tx.execute<{ existing: string | null; total: number; foreign: number }>(sql`
      SELECT (SELECT m.id FROM meanings m WHERE m.lexical_draft_id = ${draftId}::uuid AND m.draft_sense_index = ${senseIndex}::smallint) AS existing,
        (SELECT count(*)::int FROM meanings m JOIN word_types wt ON wt.id = m.type_id
         WHERE wt.word_id = ${wordId}::uuid AND (m.owner_user_id IS NULL OR m.owner_user_id = ${userId}::uuid)) AS total,
        (SELECT count(*)::int FROM meanings m JOIN word_types wt ON wt.id = m.type_id
         WHERE wt.word_id = ${wordId}::uuid AND m.owner_user_id IS NULL AND m.lexical_draft_id IS DISTINCT FROM ${draftId}::uuid) AS "foreign"`);
    if (state.existing) return { meaningId: state.existing, created: false };
    // A stale word draft: someone added this lemma another way after the preview, so the client must look it up again.
    if (kind === LEXICAL_DRAFT_KIND.WORD && state.foreign > 0) throw new ApiError('WORD_ALREADY_EXISTS', 'Word already exists');
    if (state.total >= POLICY.customWords.maxMeaningsPerWord) throw new ApiError('CUSTOM_WORD_LIMIT_REACHED', 'Word has too many meanings');

    const typeId = await this.ensureType(tx, wordId, sense.partOfSpeech);
    const pronunciation = tx.insert(pronunciations).values({ typeId, accentLocale: DEFAULT_ACCENT, ipa: sense.ipa, audioAssetKey: audioUrl });
    // A row left by a private meaning must not shape shared content; shared rows are never touched from a private one.
    await (isPrivate ? pronunciation.onConflictDoNothing() : pronunciation.onConflictDoUpdate({
      target: [pronunciations.typeId, pronunciations.accentLocale],
      set: { ipa: sense.ipa, audioAssetKey: audioUrl },
      setWhere: sql`NOT EXISTS (SELECT 1 FROM meanings m WHERE m.type_id = ${typeId}::uuid AND m.owner_user_id IS NULL)`,
    }));

    const meaningId = newId();
    await tx.insert(meanings).values({
      id: meaningId, typeId, cefrLevel: sense.cefrLevel, coreDefinition: sense.definitionText, origin: MEANING_ORIGIN.AI_GENERATED,
      createdByUserId: userId, ownerUserId: isPrivate ? userId : null, lexicalDraftId: draftId, draftSenseIndex: senseIndex,
    });
    await tx.insert(meaningLocalizations).values({
      meaningId, locale, meaningText: sense.meaningText, definitionText: sense.definitionText,
      editorialState: EDITORIAL_STATE.APPROVED, origin: MEANING_ORIGIN.AI_GENERATED,
    });
    const examples = sense.examples.map((e) => ({ ...e, id: newId() }));
    await tx.insert(meaningExamples).values(examples.map(({ id, text, targetLocator }) => ({ id, meaningId, sourceText: text, targetLocator })));
    await tx.insert(exampleLocalizations).values(examples.map(({ id, translation }) => ({ exampleId: id, locale, translationText: translation })));
    return { meaningId, created: true };
  }

  /** Returns false when the locale is already live, so a second translator only attaches. */
  async addTranslation(tx: Tx, meaningId: string, locale: string, draft: TranslationDraftPayload) {
    await tx.select({ id: meanings.id }).from(meanings).where(eq(meanings.id, meaningId)).for('update');
    const { rows: [state] } = await tx.execute<{ live: boolean; recalled: boolean }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = ${meaningId}::uuid AND a.locale = ${locale} AND a.recalled_at IS NULL) AS live,
        EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = ${meaningId}::uuid AND a.recalled_at IS NOT NULL) AS recalled`);
    if (state.live) return false;
    if (state.recalled) throw new ApiError('CUSTOM_WORD_UNAVAILABLE', 'Meaning was recalled');

    const translations = new Map(draft.examples.map((e) => [e.text, e.translation]));
    const examples = await tx
      .select({ id: meaningExamples.id, sourceText: meaningExamples.sourceText })
      .from(meaningExamples)
      .where(eq(meaningExamples.meaningId, meaningId));
    await tx.insert(meaningLocalizations).values({
      meaningId, locale, meaningText: draft.meaningText, definitionText: draft.definitionText,
      editorialState: EDITORIAL_STATE.APPROVED, origin: MEANING_ORIGIN.AI_GENERATED,
    }).onConflictDoNothing();
    const rows = examples.flatMap((e) => {
      const translationText = translations.get(e.sourceText);
      return translationText ? [{ exampleId: e.id, locale, translationText }] : [];
    });
    if (rows.length > 0) await tx.insert(exampleLocalizations).values(rows).onConflictDoNothing();
    return true;
  }

  private async personalTopic(tx: Tx, userId: string) {
    // The no-op update makes RETURNING yield the existing row on conflict.
    const [collection] = await tx
      .insert(collections)
      .values({ slug: PERSONAL_COLLECTION_SLUG, title: PERSONAL_COLLECTION_SLUG, status: CONTENT_STATUS.DRAFT })
      .onConflictDoUpdate({ target: collections.slug, set: { slug: PERSONAL_COLLECTION_SLUG } })
      .returning({ id: collections.id });
    await tx
      .insert(topics)
      .values({ collectionId: collection.id, slug: userId, title: PERSONAL_COLLECTION_SLUG, status: CONTENT_STATUS.PUBLISHED, ownerUserId: userId })
      .onConflictDoNothing();
    const [topic] = await tx.select({ id: topics.id }).from(topics).where(eq(topics.ownerUserId, userId)).for('update');
    await tx.insert(userActiveTopics).values({ userId, topicId: topic.id }).onConflictDoNothing();
    return topic.id;
  }

  async attach(tx: Tx, userId: string, meaningId: string) {
    const topicId = await this.personalTopic(tx, userId);
    const { rows: [state] } = await tx.execute<{ inserted: number; present: boolean }>(sql`
      WITH inserted AS (
        INSERT INTO topic_meanings (topic_id, meaning_id, curated_rank)
        SELECT ${topicId}::uuid, ${meaningId}::uuid, COALESCE(max(curated_rank), 0) + 1
        FROM topic_meanings WHERE topic_id = ${topicId}::uuid
        HAVING count(*) < ${POLICY.customWords.maxRoadmapWords}::int
        ON CONFLICT (topic_id, meaning_id) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*)::int FROM inserted) AS inserted,
        EXISTS (SELECT 1 FROM topic_meanings WHERE topic_id = ${topicId}::uuid AND meaning_id = ${meaningId}::uuid) AS present`);
    if (state.inserted === 0 && !state.present) throw new ApiError('CUSTOM_WORD_LIMIT_REACHED', 'Roadmap is full');
    return state.inserted > 0;
  }

  async saveOverride(executor: Executor, userId: string, meaningId: string, locale: string, content: MeaningOverride, updatedAt: Date) {
    await executor
      .insert(userMeaningOverrides)
      .values({ userId, meaningId, locale, content, updatedAt })
      // Merge by field: a client that edits only the gloss must not wipe an edited example.
      .onConflictDoUpdate({
        target: [userMeaningOverrides.userId, userMeaningOverrides.meaningId, userMeaningOverrides.locale],
        set: { content: sql`${userMeaningOverrides.content} || excluded.content`, updatedAt },
      });
  }

  async removeOverride(userId: string, meaningId: string, locale: string) {
    await this.db
      .delete(userMeaningOverrides)
      .where(and(eq(userMeaningOverrides.userId, userId), eq(userMeaningOverrides.meaningId, meaningId), eq(userMeaningOverrides.locale, locale)));
  }

  async isAttachable(userId: string, meaningId: string, locale: string) {
    const { rows } = await this.db.execute(sql`
      SELECT 1 FROM active_meaning_publications a
      JOIN meanings m ON m.id = a.meaning_id
      WHERE a.meaning_id = ${meaningId}::uuid AND a.locale = ${locale} AND a.recalled_at IS NULL
        AND (m.owner_user_id IS NULL OR m.owner_user_id = ${userId}::uuid)`);
    return rows.length > 0;
  }

  async inRoadmap(userId: string, meaningId: string) {
    const [row] = await this.db
      .select({ topicId: topicMeanings.topicId })
      .from(topicMeanings)
      .innerJoin(topics, eq(topics.id, topicMeanings.topicId))
      .where(and(eq(topics.ownerUserId, userId), eq(topicMeanings.meaningId, meaningId)));
    return Boolean(row);
  }

  async detach(userId: string, meaningId: string) {
    return this.db.transaction(async (tx) => {
      const { rowCount } = await tx.execute(sql`
        DELETE FROM topic_meanings tm USING topics t
        WHERE tm.topic_id = t.id AND t.owner_user_id = ${userId}::uuid AND tm.meaning_id = ${meaningId}::uuid`);
      await tx.delete(userMeaningOverrides).where(and(eq(userMeaningOverrides.userId, userId), eq(userMeaningOverrides.meaningId, meaningId)));
      return (rowCount ?? 0) > 0;
    });
  }

  list(userId: string, locale: string) {
    return this.db.execute<{
      meaningId: string; wordId: string; lemma: string; partOfSpeech: string; meaningText: string | null; definitionText: string | null;
      examples: ExampleView[] | null; audioUrl: string | null; overridden: boolean; translationPending: boolean; recalled: boolean;
    }>(sql`
      SELECT tm.meaning_id AS "meaningId", w.id AS "wordId", w.lemma, wt.part_of_speech AS "partOfSpeech",
        CASE WHEN a.recalled_at IS NULL THEN COALESCE(o.content->>'meaningText', p.snapshot->>'meaningText') END AS "meaningText",
        CASE WHEN a.recalled_at IS NULL THEN COALESCE(o.content->>'definitionText', p.snapshot->>'definitionText') END AS "definitionText",
        CASE WHEN a.recalled_at IS NULL THEN COALESCE(o.content->'examples', p.snapshot->'examples') END AS examples,
        (SELECT e->>'audioUrl' FROM jsonb_array_elements(p.snapshot->'pronunciations') e WHERE e->>'accentLocale' = ${DEFAULT_ACCENT}) AS "audioUrl",
        o.user_id IS NOT NULL AS overridden,
        a.meaning_id IS NULL AS "translationPending",
        a.recalled_at IS NOT NULL AS recalled
      FROM topics t
      JOIN topic_meanings tm ON tm.topic_id = t.id
      JOIN meanings m ON m.id = tm.meaning_id
      JOIN word_types wt ON wt.id = m.type_id
      JOIN words w ON w.id = wt.word_id
      LEFT JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.locale = ${locale}
      LEFT JOIN meaning_publications p ON p.id = a.publication_id AND a.recalled_at IS NULL
      LEFT JOIN user_meaning_overrides o ON o.user_id = t.owner_user_id AND o.meaning_id = m.id AND o.locale = ${locale}
      WHERE t.owner_user_id = ${userId}::uuid
      ORDER BY tm.curated_rank DESC`).then((r) => r.rows);
  }

  /** Random so one failing row cannot block the queue. */
  async nextUntranslated() {
    const { rows: [row] } = await this.db.execute<{ meaningId: string; locale: string; lemma: string; partOfSpeech: string; snapshot: MeaningSnapshot }>(sql`
      SELECT tm.meaning_id AS "meaningId", s.explanation_locale AS locale, src.snapshot->>'lemma' AS lemma,
        src.snapshot->>'partOfSpeech' AS "partOfSpeech", src.snapshot
      FROM topics t
      JOIN user_settings s ON s.user_id = t.owner_user_id
      JOIN topic_meanings tm ON tm.topic_id = t.id
      JOIN LATERAL (
        SELECT p.snapshot FROM active_meaning_publications o
        JOIN meaning_publications p ON p.id = o.publication_id
        WHERE o.meaning_id = tm.meaning_id AND o.recalled_at IS NULL
        ORDER BY o.locale LIMIT 1
      ) src ON true
      WHERE t.owner_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM meaning_localizations ml WHERE ml.meaning_id = tm.meaning_id AND ml.locale = s.explanation_locale)
        AND NOT EXISTS (SELECT 1 FROM active_meaning_publications r WHERE r.meaning_id = tm.meaning_id AND r.recalled_at IS NOT NULL)
      ORDER BY random() LIMIT 1`);
    return row;
  }

  async nextStaleSnapshot() {
    const { rows: [row] } = await this.db.execute<{ meaningId: string; locale: string }>(sql`
      SELECT a.meaning_id AS "meaningId", a.locale
      FROM meanings m
      JOIN pronunciations pr ON pr.type_id = m.type_id AND pr.accent_locale = ${DEFAULT_ACCENT} AND pr.audio_asset_key IS NOT NULL
      JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE m.origin = ${MEANING_ORIGIN.AI_GENERATED}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.snapshot->'pronunciations') e
          WHERE e->>'accentLocale' = ${DEFAULT_ACCENT} AND e->>'audioUrl' IS NOT NULL)
      ORDER BY random() LIMIT 1`);
    return row;
  }

  async nextMissingAudio() {
    const { rows: [row] } = await this.db.execute<{ id: string; lemma: string }>(sql`
      SELECT pr.id, w.lemma
      FROM pronunciations pr
      JOIN word_types wt ON wt.id = pr.type_id
      JOIN words w ON w.id = wt.word_id
      WHERE pr.accent_locale = ${DEFAULT_ACCENT} AND pr.audio_asset_key IS NULL
        AND EXISTS (SELECT 1 FROM meanings m WHERE m.type_id = pr.type_id AND m.origin = ${MEANING_ORIGIN.AI_GENERATED})
      ORDER BY random() LIMIT 1`);
    return row;
  }

  async setAudio(pronunciationId: string, audioUrl: string) {
    await this.db.update(pronunciations).set({ audioAssetKey: audioUrl }).where(eq(pronunciations.id, pronunciationId));
  }
}
