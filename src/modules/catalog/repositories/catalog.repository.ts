import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { CONTENT_STATUS } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { userSettings } from '../../../db/schema';
import { topicMeaningsSql } from './topic-meanings.sql';

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
      columns: { id: true, slug: true, title: true, color: true },
      with: {
        localizations: {
          where: (l) => eq(l.locale, locale),
          columns: { title: true, description: true },
        },
        topics: {
          where: (t) => eq(t.status, CONTENT_STATUS.PUBLISHED),
          orderBy: (t) => asc(t.slug),
          columns: { id: true, slug: true, title: true, iosIcon: true, color: true },
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
      WITH m AS (${topicMeaningsSql(userId)})
      SELECT topic_id::text AS id, (count(DISTINCT meaning_id) FILTER (WHERE learned_at IS NOT NULL))::int AS learned, count(DISTINCT meaning_id)::int AS total
      FROM m GROUP BY topic_id
      UNION ALL
      SELECT collection_id::text, (count(DISTINCT meaning_id) FILTER (WHERE learned_at IS NOT NULL))::int, count(DISTINCT meaning_id)::int
      FROM m GROUP BY collection_id`);
    return new Map(rows.map((r) => [r.id, r]));
  }
}
