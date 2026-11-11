import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { CONTENT_STATUS, NEW_WORD_OVERRIDE_MODE, NewWordOverrideMode, PERSONAL_COLLECTION_SLUG } from '../../../common/constants/domain';
import { DB, Db, toDate } from '../../../db/db';
import { userCollectionReviewPauses, userReviewLoadPrompts, userSettings } from '../../../db/schema';

@Injectable()
export class ReviewLoadRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Without `until`, until_date ends with the learner's local Sunday (Postgres weeks start on Monday).
  // No row means the value is not below the goal.
  async setOverride(userId: string, value: number, mode: NewWordOverrideMode, until: Date | null, now: Date) {
    const endOfWeek = sql`(date_trunc('week', ${now}::timestamptz AT TIME ZONE time_zone) + interval '7 days' - interval '1 second') AT TIME ZONE time_zone`;
    const { rows: [row] } = await this.db.execute<{ value: number; mode: NewWordOverrideMode; until: string | null }>(sql`
      UPDATE user_settings
      SET new_word_override = ${value}::smallint, new_word_override_mode = ${mode},
        new_word_override_until = CASE WHEN ${mode}::text = ${NEW_WORD_OVERRIDE_MODE.UNTIL_DATE}
          THEN COALESCE(${until}::timestamptz, ${endOfWeek}) END,
        updated_at = ${now}::timestamptz
      WHERE user_id = ${userId}::uuid AND daily_new_word_goal > ${value}::smallint
      RETURNING new_word_override::int AS value, new_word_override_mode AS mode, new_word_override_until AS until`);
    return row && { ...row, until: row.until === null ? null : toDate(row.until) };
  }

  async clearOverride(userId: string, now: Date) {
    await this.db.update(userSettings)
      .set({ newWordOverride: null, newWordOverrideMode: null, newWordOverrideUntil: null, updatedAt: now })
      .where(eq(userSettings.userId, userId));
  }

  async ack(userId: string, backlog: number, now: Date) {
    await this.db.insert(userReviewLoadPrompts)
      .values({ userId, lastPromptedBacklog: backlog, lastPromptedAt: now })
      .onConflictDoUpdate({ target: userReviewLoadPrompts.userId, set: { lastPromptedBacklog: backlog, lastPromptedAt: now } });
  }

  // One statement: the collection must be published, catalog-visible and not the active one.
  async pause(userId: string, collectionId: string, now: Date) {
    const { rows: [row] } = await this.db.execute<{ found: boolean; active: boolean }>(sql`
      WITH c AS (
        SELECT id FROM collections
        WHERE id = ${collectionId}::uuid AND status = ${CONTENT_STATUS.PUBLISHED} AND slug <> ${PERSONAL_COLLECTION_SLUG}
      ), active AS (
        SELECT 1 FROM user_learning_scope WHERE user_id = ${userId}::uuid AND collection_id = ${collectionId}::uuid
      ), ins AS (
        INSERT INTO user_collection_review_pauses (user_id, collection_id, paused_at)
        SELECT ${userId}::uuid, c.id, ${now}::timestamptz FROM c WHERE NOT EXISTS (SELECT 1 FROM active)
        ON CONFLICT DO NOTHING
      )
      SELECT EXISTS (SELECT 1 FROM c) AS found, EXISTS (SELECT 1 FROM active) AS active`);
    return row;
  }

  async unpause(userId: string, collectionId: string) {
    await this.db.delete(userCollectionReviewPauses).where(and(
      eq(userCollectionReviewPauses.userId, userId),
      eq(userCollectionReviewPauses.collectionId, collectionId),
    ));
  }
}
