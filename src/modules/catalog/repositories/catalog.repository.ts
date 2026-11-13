import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { CONTENT_STATUS } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { userSettings } from '../../../db/schema';

@Injectable()
export class CatalogRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async uiLocale(userId: string) {
    const settings = await this.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { uiLocale: true } });
    return settings?.uiLocale;
  }

  listPublished(locale: string) {
    return this.db.query.collections.findMany({
      where: (c) => eq(c.status, CONTENT_STATUS.PUBLISHED),
      orderBy: (c) => asc(c.slug),
      columns: { id: true, slug: true, title: true },
      with: {
        localizations: {
          where: (l) => eq(l.locale, locale),
          columns: { title: true, description: true },
        },
        topics: {
          where: (t) => eq(t.status, CONTENT_STATUS.PUBLISHED),
          orderBy: (t) => asc(t.slug),
          columns: { id: true, slug: true, title: true },
          with: {
            localizations: {
              where: (l) => eq(l.locale, locale),
              columns: { title: true, description: true },
            },
          },
        },
      },
    });
  }

  /** Distinct shared Meanings with a live publication, and how many the learner has learned, per topic and per collection. */
  async progress(userId: string) {
    const { rows } = await this.db.execute<{ id: string; learned: number; total: number }>(sql`
      WITH m AS (
        SELECT t.collection_id, t.id AS topic_id, tm.meaning_id,
          EXISTS (SELECT 1 FROM user_meaning_progress u WHERE u.user_id = ${userId}::uuid AND u.meaning_id = tm.meaning_id) AS learned
        FROM topics t
        JOIN collections c ON c.id = t.collection_id AND c.status = ${CONTENT_STATUS.PUBLISHED}
        JOIN topic_meanings tm ON tm.topic_id = t.id
        JOIN meanings mm ON mm.id = tm.meaning_id AND mm.owner_user_id IS NULL
        JOIN active_meaning_publications a ON a.meaning_id = tm.meaning_id AND a.recalled_at IS NULL
          AND a.locale = (SELECT explanation_locale FROM user_settings WHERE user_id = ${userId}::uuid)
        WHERE t.status = ${CONTENT_STATUS.PUBLISHED} AND t.owner_user_id IS NULL
      )
      SELECT topic_id::text AS id, (count(DISTINCT meaning_id) FILTER (WHERE learned))::int AS learned, count(DISTINCT meaning_id)::int AS total
      FROM m GROUP BY topic_id
      UNION ALL
      SELECT collection_id::text, (count(DISTINCT meaning_id) FILTER (WHERE learned))::int, count(DISTINCT meaning_id)::int
      FROM m GROUP BY collection_id`);
    return new Map(rows.map((r) => [r.id, r]));
  }
}
