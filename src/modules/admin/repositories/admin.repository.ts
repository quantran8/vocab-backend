import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { AI_MEANING_SCOPE, AiMeaningScope, DEFAULT_ACCENT, MEANING_ORIGIN } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { DB, Db, toDate } from '../../../db/db';
import { exampleLocalizations, meaningExamples, meaningLocalizations, meanings, pronunciations, words, wordTypes } from '../../../db/schema';
import { constraintOf, mapPgErrors, WORD_UNIQUE_INDEX } from '../domain/admin.errors';
import { MeaningLocale } from '../dto/admin.schemas';

type AiMeaningRow = {
  meaningId: string; wordId: string; lemma: string; partOfSpeech: string; cefrLevel: string | null; ipa: string | null; isPrivate: boolean;
  createdByUserId: string | null; createdAt: string; localizations: { locale: string; meaningText: string; definitionText: string; origin: string }[];
  examples: { id: string; sourceText: string; targetLocator: unknown; translations: { locale: string; translationText: string }[] }[];
  liveLocales: string[]; recalledLocales: string[];
};

export interface NewWordTree {
  word: typeof words.$inferInsert;
  types: (typeof wordTypes.$inferInsert)[];
  pronunciations: (typeof pronunciations.$inferInsert)[];
  meanings: (typeof meanings.$inferInsert)[];
  examples: (typeof meaningExamples.$inferInsert)[];
}

@Injectable()
export class AdminRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async insertWordTree({ word, types, pronunciations: pronunciationRows, meanings: meaningRows, examples }: NewWordTree) {
    await this.db.transaction(async (tx) => {
      await tx.insert(words).values(word)
        .catch((error: unknown) => {
          if (constraintOf(error) === WORD_UNIQUE_INDEX) throw new ApiError('WORD_ALREADY_EXISTS', `${word.lemma} already exists`);
          throw error;
        });
      await mapPgErrors(tx.insert(wordTypes).values(types), { unique: 'A word cannot repeat a part of speech' });
      if (pronunciationRows.length > 0) await mapPgErrors(tx.insert(pronunciations).values(pronunciationRows), { unique: 'A type cannot repeat an accent' });
      await tx.insert(meanings).values(meaningRows);
      if (examples.length > 0) await tx.insert(meaningExamples).values(examples);
    });
  }

  async aiMeanings(scope: AiMeaningScope, limit: number, offset: number) {
    const inScope = { [AI_MEANING_SCOPE.ALL]: sql`true`, [AI_MEANING_SCOPE.SHARED]: sql`m.owner_user_id IS NULL`, [AI_MEANING_SCOPE.PRIVATE]: sql`m.owner_user_id IS NOT NULL` }[scope];
    const { rows: [page] } = await this.db.execute<{ total: number; items: AiMeaningRow[] }>(sql`
      WITH filtered AS (
        SELECT m.id, m.type_id, m.cefr_level, m.owner_user_id, m.created_by_user_id, m.created_at
        FROM meanings m
        WHERE ${inScope} AND EXISTS (
          SELECT 1 FROM meaning_localizations ml WHERE ml.meaning_id = m.id AND ml.origin = ${MEANING_ORIGIN.AI_GENERATED})
      ), page AS (
        SELECT * FROM filtered m ORDER BY m.created_at DESC, m.id LIMIT ${limit} OFFSET ${offset}
      )
      SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE(jsonb_agg(row ORDER BY row."createdAt" DESC, row."meaningId"), '[]') AS items
      FROM (
        SELECT m.id AS "meaningId", w.id AS "wordId", w.lemma, wt.part_of_speech AS "partOfSpeech", m.cefr_level AS "cefrLevel",
          pr.ipa, m.owner_user_id IS NOT NULL AS "isPrivate", m.created_by_user_id AS "createdByUserId", m.created_at AS "createdAt",
          (SELECT jsonb_agg(jsonb_build_object('locale', ml.locale, 'meaningText', ml.meaning_text, 'definitionText', ml.definition_text, 'origin', ml.origin) ORDER BY ml.locale)
           FROM meaning_localizations ml WHERE ml.meaning_id = m.id) AS localizations,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'sourceText', e.source_text, 'targetLocator', e.target_locator, 'translations',
              COALESCE((SELECT jsonb_agg(jsonb_build_object('locale', el.locale, 'translationText', el.translation_text) ORDER BY el.locale)
                        FROM example_localizations el WHERE el.example_id = e.id), '[]')) ORDER BY e.id)
            FROM meaning_examples e WHERE e.meaning_id = m.id), '[]') AS examples,
          COALESCE((SELECT jsonb_agg(a.locale ORDER BY a.locale) FROM active_meaning_publications a
                    WHERE a.meaning_id = m.id AND a.recalled_at IS NULL), '[]') AS "liveLocales",
          COALESCE((SELECT jsonb_agg(a.locale ORDER BY a.locale) FROM active_meaning_publications a
                    WHERE a.meaning_id = m.id AND a.recalled_at IS NOT NULL), '[]') AS "recalledLocales"
        FROM page m
        JOIN word_types wt ON wt.id = m.type_id
        JOIN words w ON w.id = wt.word_id
        LEFT JOIN pronunciations pr ON pr.type_id = wt.id AND pr.accent_locale = ${DEFAULT_ACCENT}
      ) row`);
    return { total: page.total, meanings: page.items.map((r) => ({ ...r, createdAt: toDate(r.createdAt) })) };
  }

  /** One statement, so a meaning is never half shared. Publications stay as they are: their text is what was reviewed. */
  async approveAiMeaning(meaningId: string, reviewerId: string, reviewedAt: Date) {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      WITH approved AS (
        UPDATE meanings m
        SET owner_user_id = NULL, origin = ${MEANING_ORIGIN.CURATED}, reviewed_by_user_id = ${reviewerId}::uuid, reviewed_at = ${reviewedAt}::timestamptz
        WHERE m.id = ${meaningId}::uuid
          AND EXISTS (SELECT 1 FROM meaning_localizations ml WHERE ml.meaning_id = m.id AND ml.origin = ${MEANING_ORIGIN.AI_GENERATED})
          AND EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = m.id AND a.recalled_at IS NOT NULL)
        RETURNING m.id
      ), localized AS (
        UPDATE meaning_localizations SET origin = ${MEANING_ORIGIN.CURATED} WHERE meaning_id IN (SELECT id FROM approved)
      ), drafts AS (
        UPDATE lexical_drafts SET owner_user_id = NULL WHERE meaning_id IN (SELECT id FROM approved)
      )
      SELECT id FROM approved`);
    return rows.length > 0;
  }

  async findMeaningOwner(meaningId: string) {
    const [meaning] = await this.db.select({ ownerUserId: meanings.ownerUserId }).from(meanings).where(eq(meanings.id, meaningId));
    return meaning;
  }

  async countExamplesOf(meaningId: string, exampleIds: string[]) {
    const [{ owned }] = await this.db
      .select({ owned: count() })
      .from(meaningExamples)
      .where(and(eq(meaningExamples.meaningId, meaningId), inArray(meaningExamples.id, exampleIds)));
    return owned;
  }

  async upsertMeaningLocale(meaningId: string, locale: string, body: MeaningLocale, updatedAt: Date) {
    const { exampleTranslations, ...text } = body;
    const exampleIds = exampleTranslations.map((t) => t.exampleId);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(meaningLocalizations)
        .values({ meaningId, locale, ...text, updatedAt })
        // An editor's write replaces any AI translation, so the row counts as reviewed from here on.
        .onConflictDoUpdate({ target: [meaningLocalizations.meaningId, meaningLocalizations.locale], set: { ...text, origin: MEANING_ORIGIN.CURATED, updatedAt } });
      if (exampleIds.length === 0) return;
      await tx.delete(exampleLocalizations).where(and(eq(exampleLocalizations.locale, locale), inArray(exampleLocalizations.exampleId, exampleIds)));
      await tx.insert(exampleLocalizations).values(exampleTranslations.map((t) => ({ ...t, locale })));
    });
  }
}
