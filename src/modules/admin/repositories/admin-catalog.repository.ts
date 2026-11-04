import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { PERSONAL_COLLECTION_SLUG } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { collectionLocalizations, collections, topicLocalizations, topicMeanings, topics } from '../../../db/schema';
import { CatalogLocale, CreateCatalogEntry, PatchCatalogEntry } from '../dto/admin.schemas';
import { IN_USE, mapPgErrors } from '../domain/admin.errors';

const SLUG_EXISTS = 'This slug already exists';

// The personal collection and owned topics hold each learner's custom words, so they are never catalog content.
const isCatalogCollection = ne(collections.slug, PERSONAL_COLLECTION_SLUG);
const isCatalogTopic = (id: string) => and(eq(topics.id, id), isNull(topics.ownerUserId));

const topicColumns = { id: topics.id, collectionId: topics.collectionId, slug: topics.slug, title: topics.title, status: topics.status };

@Injectable()
export class AdminCatalogRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listCollections(limit: number, offset: number) {
    const { rows: [page] } = await this.db.execute<{ total: number; items: object[] }>(sql`
      WITH filtered AS (SELECT id, slug, title, status FROM collections WHERE slug <> ${PERSONAL_COLLECTION_SLUG}),
      page AS (SELECT * FROM filtered ORDER BY slug LIMIT ${limit} OFFSET ${offset})
      SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE(jsonb_agg(row ORDER BY row.slug), '[]') AS items
      FROM (
        SELECT p.id, p.slug, p.title, p.status,
          (SELECT count(*)::int FROM topics t WHERE t.collection_id = p.id AND t.owner_user_id IS NULL) AS "topicCount",
          COALESCE((SELECT jsonb_agg(l.locale ORDER BY l.locale) FROM collection_localizations l WHERE l.collection_id = p.id), '[]') AS locales
        FROM page p
      ) row`);
    return page;
  }

  async findCollection(id: string) {
    const { rows: [collection] } = await this.db.execute(sql`
      SELECT c.id, c.slug, c.title, c.status,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('locale', l.locale, 'title', l.title, 'description', l.description) ORDER BY l.locale)
                  FROM collection_localizations l WHERE l.collection_id = c.id), '[]') AS localizations,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', t.id, 'slug', t.slug, 'title', t.title, 'status', t.status,
            'meaningCount', (SELECT count(*)::int FROM topic_meanings tm WHERE tm.topic_id = t.id),
            'locales', COALESCE((SELECT jsonb_agg(tl.locale ORDER BY tl.locale) FROM topic_localizations tl WHERE tl.topic_id = t.id), '[]')) ORDER BY t.slug)
          FROM topics t WHERE t.collection_id = c.id AND t.owner_user_id IS NULL), '[]') AS topics
      FROM collections c WHERE c.id = ${id}::uuid AND c.slug <> ${PERSONAL_COLLECTION_SLUG}`);
    return collection;
  }

  async insertCollection(body: CreateCatalogEntry) {
    const [row] = await mapPgErrors(this.db.insert(collections).values(body).returning(), { unique: SLUG_EXISTS });
    return row;
  }

  async updateCollection(id: string, body: PatchCatalogEntry) {
    const [row] = await mapPgErrors(
      this.db.update(collections).set(body).where(and(eq(collections.id, id), isCatalogCollection)).returning(),
      { unique: SLUG_EXISTS },
    );
    return row;
  }

  async findCollectionDeletionState(id: string) {
    const { rows: [state] } = await this.db.execute<{ status: string; topics: number }>(sql`
      SELECT c.status, (SELECT count(*)::int FROM topics t WHERE t.collection_id = c.id) AS topics
      FROM collections c WHERE c.id = ${id}::uuid AND c.slug <> ${PERSONAL_COLLECTION_SLUG}`);
    return state;
  }

  async deleteCollection(id: string) {
    await mapPgErrors(this.db.execute(sql`
      WITH del_locales AS (DELETE FROM collection_localizations WHERE collection_id = ${id}::uuid)
      DELETE FROM collections WHERE id = ${id}::uuid`), { fk: IN_USE });
  }

  async collectionExists(id: string) {
    const [row] = await this.db.select({ id: collections.id }).from(collections).where(and(eq(collections.id, id), isCatalogCollection));
    return Boolean(row);
  }

  async upsertCollectionLocale(collectionId: string, locale: string, body: CatalogLocale) {
    await this.db.insert(collectionLocalizations).values({ collectionId, locale, ...body })
      .onConflictDoUpdate({ target: [collectionLocalizations.collectionId, collectionLocalizations.locale], set: body });
  }

  async deleteCollectionLocale(collectionId: string, locale: string) {
    const deleted = await this.db.delete(collectionLocalizations)
      .where(and(eq(collectionLocalizations.collectionId, collectionId), eq(collectionLocalizations.locale, locale)))
      .returning({ locale: collectionLocalizations.locale });
    return deleted.length > 0;
  }

  async insertTopic(collectionId: string, body: CreateCatalogEntry) {
    const [row] = await mapPgErrors(this.db.insert(topics).values({ ...body, collectionId }).returning(topicColumns), { unique: SLUG_EXISTS });
    return row;
  }

  async findTopic(id: string) {
    const { rows: [topic] } = await this.db.execute(sql`
      SELECT t.id, t.collection_id AS "collectionId", t.slug, t.title, t.status,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('locale', l.locale, 'title', l.title, 'description', l.description) ORDER BY l.locale)
                  FROM topic_localizations l WHERE l.topic_id = t.id), '[]') AS localizations
      FROM topics t WHERE t.id = ${id}::uuid AND t.owner_user_id IS NULL`);
    return topic;
  }

  async updateTopic(id: string, body: PatchCatalogEntry) {
    const [row] = await mapPgErrors(this.db.update(topics).set(body).where(isCatalogTopic(id)).returning(topicColumns), { unique: SLUG_EXISTS });
    return row;
  }

  async topicStatus(id: string) {
    const [topic] = await this.db.select({ status: topics.status }).from(topics).where(isCatalogTopic(id));
    return topic?.status;
  }

  async deleteTopic(id: string) {
    await mapPgErrors(this.db.execute(sql`
      WITH del_locales AS (DELETE FROM topic_localizations WHERE topic_id = ${id}::uuid),
      del_meanings AS (DELETE FROM topic_meanings WHERE topic_id = ${id}::uuid)
      DELETE FROM topics WHERE id = ${id}::uuid`), { fk: IN_USE });
  }

  async upsertTopicLocale(topicId: string, locale: string, body: CatalogLocale) {
    await this.db.insert(topicLocalizations).values({ topicId, locale, ...body })
      .onConflictDoUpdate({ target: [topicLocalizations.topicId, topicLocalizations.locale], set: body });
  }

  async deleteTopicLocale(topicId: string, locale: string) {
    const deleted = await this.db.delete(topicLocalizations)
      .where(and(eq(topicLocalizations.topicId, topicId), eq(topicLocalizations.locale, locale)))
      .returning({ locale: topicLocalizations.locale });
    return deleted.length > 0;
  }

  async listTopicMeanings(topicId: string, locale: string) {
    const { rows } = await this.db.execute(sql`
      SELECT tm.meaning_id AS "meaningId", tm.curated_rank AS "rank", w.id AS "wordId", w.lemma, wt.part_of_speech AS "partOfSpeech", m.cefr_level AS "cefrLevel",
        (SELECT ml.meaning_text FROM meaning_localizations ml WHERE ml.meaning_id = m.id AND ml.locale = ${locale}) AS "meaningText",
        COALESCE((SELECT jsonb_agg(a.locale ORDER BY a.locale) FROM active_meaning_publications a WHERE a.meaning_id = m.id AND a.recalled_at IS NULL), '[]') AS "liveLocales"
      FROM topic_meanings tm
      JOIN meanings m ON m.id = tm.meaning_id
      JOIN word_types wt ON wt.id = m.type_id
      JOIN words w ON w.id = wt.word_id
      WHERE tm.topic_id = ${topicId}::uuid
      ORDER BY tm.curated_rank`);
    return rows;
  }

  async countEligibleMeanings(meaningIds: string[]) {
    const { rows: [{ eligible }] } = await this.db.execute<{ eligible: number }>(sql`
      SELECT count(*)::int AS eligible FROM meanings m
      WHERE m.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(meaningIds)}::jsonb)) AND m.owner_user_id IS NULL
        AND EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = m.id AND a.recalled_at IS NULL)`);
    return eligible;
  }

  async appendTopicMeanings(topicId: string, meaningIds: string[]) {
    const ids = JSON.stringify(meaningIds);
    const { rows } = await mapPgErrors(this.db.execute(sql`
      INSERT INTO topic_meanings (topic_id, meaning_id, curated_rank)
      SELECT ${topicId}::uuid, x.value::uuid,
        (SELECT COALESCE(max(curated_rank), 0) FROM topic_meanings WHERE topic_id = ${topicId}::uuid) + row_number() OVER (ORDER BY x.ordinality)
      FROM jsonb_array_elements_text(${ids}::jsonb) WITH ORDINALITY AS x
      WHERE NOT EXISTS (SELECT 1 FROM topic_meanings tm WHERE tm.topic_id = ${topicId}::uuid AND tm.meaning_id = x.value::uuid)
      RETURNING meaning_id`), { unique: 'The topic changed at the same time; try again' });
    return rows.length;
  }

  async removeTopicMeaning(topicId: string, meaningId: string) {
    const deleted = await this.db.delete(topicMeanings)
      .where(and(eq(topicMeanings.topicId, topicId), eq(topicMeanings.meaningId, meaningId)))
      .returning({ meaningId: topicMeanings.meaningId });
    return deleted.length > 0;
  }

  // The unique rank index is not deferrable: move every row above the current maximum, then write the final ranks.
  // Returns false, writing nothing, when meaningIds is not exactly the topic's current set.
  async reorderTopicMeanings(topicId: string, meaningIds: string[]) {
    return this.db.transaction(async (tx) => {
      const current = await tx.select({ meaningId: topicMeanings.meaningId }).from(topicMeanings).where(eq(topicMeanings.topicId, topicId)).for('update');
      const known = new Set(current.map((r) => r.meaningId));
      if (current.length !== meaningIds.length || meaningIds.some((id) => !known.has(id))) return false;
      await tx.execute(sql`
        UPDATE topic_meanings SET curated_rank = curated_rank + (SELECT max(curated_rank) FROM topic_meanings WHERE topic_id = ${topicId}::uuid)
        WHERE topic_id = ${topicId}::uuid`);
      await tx.execute(sql`
        UPDATE topic_meanings tm SET curated_rank = x.ordinality
        FROM jsonb_array_elements_text(${JSON.stringify(meaningIds)}::jsonb) WITH ORDINALITY AS x
        WHERE tm.topic_id = ${topicId}::uuid AND tm.meaning_id = x.value::uuid`);
      return true;
    });
  }
}
