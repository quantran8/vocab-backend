import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql, SQL } from 'drizzle-orm';
import { DEFAULT_LOCALE } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { DB, Db, Executor, toDate } from '../../../db/db';
import {
  activeMeaningPublications, meaningExamples, meaningPublications, meanings, pronunciations, words, wordTypes,
} from '../../../db/schema';
import { constraintOf, IN_USE, mapPgErrors, WORD_UNIQUE_INDEX } from '../domain/admin.errors';
import { ExampleBody, ListMeanings, ListWords, MeaningBody, PatchMeaning, PatchPronunciation, PatchWord, PronunciationBody, WordTypeBody } from '../dto/admin.schemas';

const ACCENT_EXISTS = 'This type already has that accent';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

// Deleting in one statement: NO ACTION foreign keys are checked at its end, so children and parent go together.
const purgeMeanings = (scope: SQL) => sql`
  target_meanings AS (SELECT id FROM meanings WHERE ${scope}),
  target_examples AS (SELECT id FROM meaning_examples WHERE meaning_id IN (SELECT id FROM target_meanings)),
  del_example_locales AS (DELETE FROM example_localizations WHERE example_id IN (SELECT id FROM target_examples)),
  del_examples AS (DELETE FROM meaning_examples WHERE id IN (SELECT id FROM target_examples)),
  del_meaning_locales AS (DELETE FROM meaning_localizations WHERE meaning_id IN (SELECT id FROM target_meanings)),
  del_meanings AS (DELETE FROM meanings WHERE id IN (SELECT id FROM target_meanings))`;

@Injectable()
export class AdminWordsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listWords({ q, language, limit, offset }: ListWords) {
    const conditions = [
      q ? sql`lower(btrim(w.lemma)) LIKE ${`${escapeLike(q.toLowerCase())}%`}` : sql`true`,
      language ? sql`w.language = ${language}` : sql`true`,
    ];
    const { rows: [page] } = await this.db.execute<{
      total: number;
      items: { id: string; language: string; lemma: string; homographKey: string | null; createdAt: string; partsOfSpeech: string[]; meaningCount: number; liveMeaningCount: number; privateMeaningCount: number }[];
    }>(sql`
      WITH filtered AS (
        SELECT w.id, w.language, w.lemma, w.homograph_key, w.created_at FROM words w WHERE ${sql.join(conditions, sql` AND `)}
      ), page AS (
        SELECT * FROM filtered ORDER BY lower(btrim(lemma)), id LIMIT ${limit} OFFSET ${offset}
      )
      SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE(jsonb_agg(row ORDER BY lower(btrim(row.lemma)), row.id), '[]') AS items
      FROM (
        SELECT p.id, p.language, p.lemma, p.homograph_key AS "homographKey", p.created_at AS "createdAt",
          COALESCE((SELECT jsonb_agg(t.part_of_speech ORDER BY t.part_of_speech) FROM word_types t WHERE t.word_id = p.id), '[]') AS "partsOfSpeech",
          stats."meaningCount", stats."liveMeaningCount", stats."privateMeaningCount"
        FROM page p
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE m.owner_user_id IS NULL)::int AS "meaningCount",
                 count(*) FILTER (WHERE m.owner_user_id IS NOT NULL)::int AS "privateMeaningCount",
                 count(*) FILTER (WHERE m.owner_user_id IS NULL AND EXISTS (
                   SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = m.id AND a.recalled_at IS NULL))::int AS "liveMeaningCount"
          FROM word_types t JOIN meanings m ON m.type_id = t.id WHERE t.word_id = p.id
        ) stats
      ) row`);
    return { total: page.total, items: page.items.map((w) => ({ ...w, createdAt: toDate(w.createdAt) })) };
  }

  // Shared meanings only: private ones are reviewed in the AI queue, as CLAUDE.md requires.
  findWordTree(id: string) {
    return this.db.query.words.findFirst({
      where: (w) => eq(w.id, id),
      with: {
        types: {
          columns: { id: true, partOfSpeech: true },
          with: {
            pronunciations: { columns: { id: true, accentLocale: true, ipa: true, audioAssetKey: true } },
            meanings: {
              where: (m) => isNull(m.ownerUserId),
              columns: { id: true, cefrLevel: true, coreDefinition: true, popularity: true, origin: true, reviewedAt: true, createdAt: true },
              with: {
                localizations: { columns: { locale: true, meaningText: true, definitionText: true, editorialState: true, origin: true, updatedAt: true } },
                examples: { columns: { id: true, sourceText: true, targetLocator: true }, with: { localizations: { columns: { locale: true, translationText: true } } } },
              },
            },
          },
        },
      },
    });
  }

  async publicationState(wordId: string, meaningIds: string[]) {
    const [active, history, [{ privateMeaningCount }]] = await Promise.all([
      this.db
        .select({
          meaningId: activeMeaningPublications.meaningId, locale: activeMeaningPublications.locale, recalledAt: activeMeaningPublications.recalledAt,
          revision: meaningPublications.revision, publishedAt: meaningPublications.publishedAt,
        })
        .from(activeMeaningPublications)
        .innerJoin(meaningPublications, eq(meaningPublications.id, activeMeaningPublications.publicationId))
        .where(inArray(activeMeaningPublications.meaningId, meaningIds)),
      this.db.execute<{ published: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM meaning_publications p JOIN meanings m ON m.id = p.meaning_id JOIN word_types t ON t.id = m.type_id WHERE t.word_id = ${wordId}::uuid
        ) AS published`),
      this.db
        .select({ privateMeaningCount: sql<number>`count(*)::int` })
        .from(meanings)
        .innerJoin(wordTypes, eq(wordTypes.id, meanings.typeId))
        .where(and(eq(wordTypes.wordId, wordId), isNotNull(meanings.ownerUserId))),
    ]);
    return { active, published: history.rows[0].published, privateMeaningCount };
  }

  async updateWord(id: string, body: PatchWord) {
    const [row] = await this.db.update(words).set(body).where(eq(words.id, id)).returning({ id: words.id, lemma: words.lemma, homographKey: words.homographKey })
      .catch((error: unknown) => {
        if (constraintOf(error) === WORD_UNIQUE_INDEX) throw new ApiError('WORD_ALREADY_EXISTS', `${body.lemma ?? 'This key'} already exists`);
        throw error;
      });
    return row;
  }

  async deleteWord(id: string) {
    const { rows } = await mapPgErrors(this.db.execute<{ id: string }>(sql`
      WITH target_types AS (SELECT id FROM word_types WHERE word_id = ${id}::uuid),
      ${purgeMeanings(sql`type_id IN (SELECT id FROM target_types)`)},
      del_pronunciations AS (DELETE FROM pronunciations WHERE type_id IN (SELECT id FROM target_types)),
      del_types AS (DELETE FROM word_types WHERE id IN (SELECT id FROM target_types))
      DELETE FROM words WHERE id = ${id}::uuid RETURNING id`), { fk: IN_USE });
    return rows.length > 0;
  }

  async insertType(id: string, wordId: string, body: WordTypeBody) {
    await this.db.transaction(async (tx) => {
      await mapPgErrors(tx.insert(wordTypes).values({ id, wordId, partOfSpeech: body.partOfSpeech }), {
        fk: 'Word not found', fkCode: 'NOT_FOUND', unique: 'This word already has that part of speech',
      });
      if (body.pronunciations.length > 0) {
        await mapPgErrors(tx.insert(pronunciations).values(body.pronunciations.map((p) => ({ ...p, typeId: id }))), { unique: ACCENT_EXISTS });
      }
      await this.insertMeanings(tx, id, body.meanings);
    });
  }

  async deleteType(id: string) {
    const { rows } = await mapPgErrors(this.db.execute<{ id: string }>(sql`
      WITH ${purgeMeanings(sql`type_id = ${id}::uuid`)},
      del_pronunciations AS (DELETE FROM pronunciations WHERE type_id = ${id}::uuid)
      DELETE FROM word_types WHERE id = ${id}::uuid RETURNING id`), { fk: IN_USE });
    return rows.length > 0;
  }

  async insertPronunciation(typeId: string, body: PronunciationBody) {
    const [row] = await mapPgErrors(
      this.db.insert(pronunciations).values({ ...body, typeId }).returning({ id: pronunciations.id }),
      { fk: 'Word type not found', fkCode: 'NOT_FOUND', unique: ACCENT_EXISTS },
    );
    return row.id;
  }

  async updatePronunciation(id: string, body: PatchPronunciation) {
    const [row] = await mapPgErrors(
      this.db.update(pronunciations).set(body).where(eq(pronunciations.id, id)).returning({
        id: pronunciations.id, typeId: pronunciations.typeId, accentLocale: pronunciations.accentLocale, ipa: pronunciations.ipa, audioAssetKey: pronunciations.audioAssetKey,
      }),
      { unique: ACCENT_EXISTS },
    );
    return row;
  }

  async deletePronunciation(id: string) {
    const deleted = await mapPgErrors(this.db.delete(pronunciations).where(eq(pronunciations.id, id)).returning({ id: pronunciations.id }), { fk: IN_USE });
    return deleted.length > 0;
  }

  async listMeanings({ q, locale = DEFAULT_LOCALE, cefr, live, limit, offset }: ListMeanings) {
    const liveHere = sql`EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = m.id AND a.locale = ${locale} AND a.recalled_at IS NULL)`;
    const conditions = [
      sql`m.owner_user_id IS NULL`,
      q ? sql`lower(btrim(w.lemma)) LIKE ${`${escapeLike(q.toLowerCase())}%`}` : sql`true`,
      cefr ? sql`m.cefr_level = ${cefr}` : sql`true`,
      live === undefined ? sql`true` : live ? liveHere : sql`NOT ${liveHere}`,
    ];
    const { rows: [page] } = await this.db.execute<{ total: number; items: object[] }>(sql`
      WITH filtered AS (
        SELECT m.id, m.type_id, m.cefr_level, wt.part_of_speech, w.id AS word_id, w.lemma
        FROM meanings m JOIN word_types wt ON wt.id = m.type_id JOIN words w ON w.id = wt.word_id
        WHERE ${sql.join(conditions, sql` AND `)}
      ), page AS (
        SELECT * FROM filtered ORDER BY lower(btrim(lemma)), id LIMIT ${limit} OFFSET ${offset}
      )
      SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE(jsonb_agg(row ORDER BY lower(btrim(row.lemma)), row.id), '[]') AS items
      FROM (
        SELECT p.id, p.word_id AS "wordId", p.lemma, p.part_of_speech AS "partOfSpeech", p.cefr_level AS "cefrLevel",
          (SELECT ml.meaning_text FROM meaning_localizations ml WHERE ml.meaning_id = p.id AND ml.locale = ${locale}) AS "meaningText",
          COALESCE((SELECT jsonb_agg(a.locale ORDER BY a.locale) FROM active_meaning_publications a WHERE a.meaning_id = p.id AND a.recalled_at IS NULL), '[]') AS "liveLocales",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pr.id, 'accentLocale', pr.accent_locale, 'ipa', pr.ipa) ORDER BY pr.accent_locale)
                    FROM pronunciations pr WHERE pr.type_id = p.type_id), '[]') AS pronunciations
        FROM page p
      ) row`);
    return page;
  }

  async insertMeaning(typeId: string, body: MeaningBody) {
    const [id] = await this.db.transaction((tx) => this.insertMeanings(tx, typeId, [body]));
    return id;
  }

  async updateMeaning(id: string, body: PatchMeaning) {
    const [row] = await this.db
      .update(meanings)
      .set(body)
      .where(and(eq(meanings.id, id), isNull(meanings.ownerUserId)))
      .returning({ id: meanings.id, cefrLevel: meanings.cefrLevel, coreDefinition: meanings.coreDefinition, popularity: meanings.popularity });
    return row;
  }

  async deleteMeaning(id: string) {
    await mapPgErrors(this.db.execute(sql`
      WITH ${purgeMeanings(sql`id = ${id}::uuid`)} SELECT count(*) FROM target_meanings`), { fk: IN_USE });
  }

  async hasPublicationIn(meaningId: string, locale: string) {
    const [published] = await this.db
      .select({ id: meaningPublications.id })
      .from(meaningPublications)
      .where(and(eq(meaningPublications.meaningId, meaningId), eq(meaningPublications.locale, locale)))
      .limit(1);
    return Boolean(published);
  }

  async deleteMeaningLocale(id: string, locale: string) {
    const { rows } = await this.db.execute(sql`
      WITH del_examples AS (
        DELETE FROM example_localizations
        WHERE locale = ${locale} AND example_id IN (SELECT id FROM meaning_examples WHERE meaning_id = ${id}::uuid)
      )
      DELETE FROM meaning_localizations WHERE meaning_id = ${id}::uuid AND locale = ${locale} RETURNING meaning_id`);
    return rows.length > 0;
  }

  async listPublications(meaningId: string) {
    const rows = await this.db
      .select({
        id: meaningPublications.id, locale: meaningPublications.locale, revision: meaningPublications.revision,
        approvedAt: meaningPublications.approvedAt, publishedAt: meaningPublications.publishedAt,
        activeId: activeMeaningPublications.publicationId, recalledAt: activeMeaningPublications.recalledAt,
      })
      .from(meaningPublications)
      .leftJoin(activeMeaningPublications, eq(activeMeaningPublications.publicationId, meaningPublications.id))
      .where(eq(meaningPublications.meaningId, meaningId))
      .orderBy(meaningPublications.locale, sql`${meaningPublications.revision} DESC`);
    return rows.map(({ activeId, ...row }) => ({ ...row, isCurrent: activeId !== null }));
  }

  async insertExample(meaningId: string, body: ExampleBody) {
    const [row] = await this.db.insert(meaningExamples).values({ ...body, meaningId }).returning({ id: meaningExamples.id });
    return row.id;
  }

  async updateExample(id: string, body: ExampleBody) {
    await this.db.update(meaningExamples).set(body).where(eq(meaningExamples.id, id));
  }

  async deleteExample(id: string) {
    await this.db.execute(sql`
      WITH del_locales AS (DELETE FROM example_localizations WHERE example_id = ${id}::uuid)
      DELETE FROM meaning_examples WHERE id = ${id}::uuid`);
  }

  async findMeaningOwner(id: string) {
    const [meaning] = await this.db.select({ ownerUserId: meanings.ownerUserId }).from(meanings).where(eq(meanings.id, id));
    return meaning;
  }

  async findExampleOwner(id: string) {
    const [example] = await this.db
      .select({ ownerUserId: meanings.ownerUserId })
      .from(meaningExamples)
      .innerJoin(meanings, eq(meanings.id, meaningExamples.meaningId))
      .where(eq(meaningExamples.id, id));
    return example;
  }

  hasWordHistory(id: string) {
    return this.hasHistory(sql`t.word_id = ${id}::uuid`);
  }

  hasTypeHistory(id: string) {
    return this.hasHistory(sql`t.id = ${id}::uuid`);
  }

  hasPronunciationHistory(id: string) {
    return this.hasHistory(sql`t.id = (SELECT type_id FROM pronunciations WHERE id = ${id}::uuid)`);
  }

  hasMeaningHistory(id: string) {
    return this.hasHistory(sql`m.id = ${id}::uuid`);
  }

  hasExampleHistory(id: string) {
    return this.hasHistory(sql`m.id = (SELECT meaning_id FROM meaning_examples WHERE id = ${id}::uuid)`);
  }

  private async insertMeanings(tx: Executor, typeId: string, bodies: MeaningBody[]) {
    if (bodies.length === 0) return [];
    const rows = bodies.map(({ examples, ...meaning }) => ({ ...meaning, id: newId(), typeId, examples }));
    await mapPgErrors(tx.insert(meanings).values(rows.map(({ examples: _examples, ...meaning }) => meaning)), { fk: 'Word type not found', fkCode: 'NOT_FOUND' });
    const exampleRows = rows.flatMap((m) => m.examples.map((e) => ({ ...e, meaningId: m.id })));
    if (exampleRows.length > 0) await tx.insert(meaningExamples).values(exampleRows);
    return rows.map((m) => m.id);
  }

  /** True once anything under the scope was published or belongs to a learner. */
  private async hasHistory(scope: SQL) {
    const { rows: [row] } = await this.db.execute<{ locked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM meanings m JOIN word_types t ON t.id = m.type_id
        WHERE ${scope} AND (m.owner_user_id IS NOT NULL OR EXISTS (SELECT 1 FROM meaning_publications p WHERE p.meaning_id = m.id))
      ) AS locked`);
    return row.locked;
  }
}
