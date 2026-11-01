import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import { CEFR_LEVELS, CONTENT_STATUS, EDITORIAL_STATE, ITEM_STATUS, MEANING_ORIGIN, MEMORY_SIGNAL, CHECKPOINT_STATE } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { DB, Db } from '../../db/db';
import { practiceItemLocalizations, practiceItemTargets, checkpointChallenges, userMeaningOverrides } from '../../db/schema';
import { CuratedItem } from '../practice-resolver/curated';
import { DistractorView, MeaningSnapshot } from '../practice-resolver/task.types';

type SnapshotRow = { snapshot: MeaningSnapshot };

const CEFR_ARRAY = sql`ARRAY[${sql.join(CEFR_LEVELS.map((l) => sql`${l}`), sql`, `)}]::text[]`;

const inScope = (rows: SnapshotRow[]) => rows.map((r) => r.snapshot);

@Injectable()
export class PlannerRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async loadLearner(userId: string) {
    const learner = await this.db.query.appUsers.findFirst({
      where: (u) => eq(u.id, userId),
      columns: { proficiencyLevel: true },
      with: {
        settings: { columns: { explanationLocale: true, timeZone: true, dailyNewWordGoal: true } },
        activeTopics: { columns: { topicId: true } },
      },
    });
    if (!learner) throw new ApiError('NOT_FOUND', 'User not found');
    return learner;
  }

  async dueTargets(userId: string, locale: string, now: Date, limit: number) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      SELECT p.snapshot
      FROM user_meaning_progress ump
      JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE ump.user_id = ${userId}::uuid AND ump.next_review_at <= ${now}::timestamptz
        AND EXISTS (
          SELECT 1 FROM topic_meanings tm
          JOIN user_active_topics uat ON uat.topic_id = tm.topic_id AND uat.user_id = ump.user_id
          WHERE tm.meaning_id = ump.meaning_id)
      ORDER BY ump.next_review_at, ump.meaning_id
      LIMIT ${limit}`)).rows);
  }

  // Goal is per session, not per day: a finished session never blocks the next one.
  // Level only orders: at or above it first, nearest first, then easier ones; it never empties the pool.
  // Words the learner added come first: they asked for them, and CEFR gap could bury them.
  async newTargets(userId: string, locale: string, level: string | null, goal: number) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      WITH ranked AS (
        SELECT tm.meaning_id, min(tm.curated_rank) AS curated_rank, bool_or(t.owner_user_id IS NOT NULL) AS personal
        FROM topic_meanings tm
        JOIN user_active_topics uat ON uat.topic_id = tm.topic_id AND uat.user_id = ${userId}::uuid
        JOIN topics t ON t.id = tm.topic_id AND t.status = ${CONTENT_STATUS.PUBLISHED}
        GROUP BY tm.meaning_id
      ), eligible AS (
        SELECT DISTINCT ON (wt.word_id) r.meaning_id, r.curated_rank, r.personal, p.snapshot,
          COALESCE(lv.d < 0, false) AS below, COALESCE(abs(lv.d), 0) AS gap
        FROM ranked r
        JOIN active_meaning_publications a ON a.meaning_id = r.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
        JOIN meaning_publications p ON p.id = a.publication_id
        JOIN meanings m ON m.id = r.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        CROSS JOIN LATERAL (SELECT array_position(${CEFR_ARRAY}, m.cefr_level) - array_position(${CEFR_ARRAY}, ${level}::text) AS d) lv
        WHERE NOT EXISTS (
            SELECT 1 FROM user_meaning_progress ump
            WHERE ump.user_id = ${userId}::uuid AND ump.meaning_id = r.meaning_id)
        ORDER BY wt.word_id, r.personal DESC, below, gap, r.curated_rank, r.meaning_id
      )
      SELECT snapshot FROM eligible
      ORDER BY personal DESC, below, gap, curated_rank, meaning_id
      LIMIT ${goal}::int`)).rows);
  }

  async randomTargets(userId: string, locale: string, limit: number) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      SELECT p.snapshot
      FROM user_meaning_progress ump
      JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE ump.user_id = ${userId}::uuid
      ORDER BY ump.last_reviewed_at NULLS FIRST, ump.meaning_id
      LIMIT ${limit}`)).rows);
  }

  // Rolling window, not lifetime wrong counts (§8.3).
  async weakTargets(userId: string, locale: string, since: Date, minAttempts: number, limit: number) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      WITH attempts AS (
        SELECT meaning_id, count(*) AS total,
               count(*) FILTER (WHERE signal NOT IN (${MEMORY_SIGNAL.UNAIDED_RECALL}, ${MEMORY_SIGNAL.RECOGNITION_SUCCESS})) AS weak
        FROM memory_observations
        WHERE user_id = ${userId}::uuid AND observed_at >= ${since}::timestamptz
        GROUP BY meaning_id
        HAVING count(*) >= ${minAttempts}
      )
      SELECT p.snapshot
      FROM attempts x
      JOIN active_meaning_publications a ON a.meaning_id = x.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE x.weak > 0
      ORDER BY x.weak::numeric / x.total DESC, x.meaning_id
      LIMIT ${limit}`)).rows);
  }

  async oldestChallenge(userId: string, challengeId?: string) {
    const [challenge] = await this.db
      .select({ id: checkpointChallenges.id })
      .from(checkpointChallenges)
      .where(and(
        eq(checkpointChallenges.userId, userId),
        eq(checkpointChallenges.state, CHECKPOINT_STATE.AVAILABLE),
        challengeId ? eq(checkpointChallenges.id, challengeId) : undefined,
      ))
      .orderBy(asc(checkpointChallenges.sequence))
      .limit(1);
    return challenge;
  }

  async challengeTargets(challengeId: string, locale: string) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      SELECT p.snapshot
      FROM checkpoint_challenge_meanings w
      JOIN active_meaning_publications a ON a.meaning_id = w.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE w.challenge_id = ${challengeId}::uuid
      ORDER BY w.meaning_id`)).rows);
  }

  // Unreviewed AI text stays out, including AI translations of curated meanings: it reaches only learners who chose it.
  distractorPool(locale: string, limit: number) {
    return this.db.execute<DistractorView>(sql`
      SELECT p.snapshot->>'wordId' AS "wordId", p.snapshot->>'lemma' AS lemma, p.snapshot->>'meaningText' AS "meaningText"
      FROM active_meaning_publications a
      JOIN meaning_publications p ON p.id = a.publication_id
      JOIN meaning_localizations ml ON ml.meaning_id = a.meaning_id AND ml.locale = a.locale
      WHERE a.locale = ${locale} AND a.recalled_at IS NULL AND ml.origin = ${MEANING_ORIGIN.CURATED}
      ORDER BY random()
      LIMIT ${limit}`).then((r) => r.rows);
  }

  overrides(userId: string, meaningIds: string[], locale: string) {
    return this.db
      .select({ meaningId: userMeaningOverrides.meaningId, content: userMeaningOverrides.content })
      .from(userMeaningOverrides)
      .where(and(
        eq(userMeaningOverrides.userId, userId),
        eq(userMeaningOverrides.locale, locale),
        inArray(userMeaningOverrides.meaningId, meaningIds),
      ));
  }

  async curatedItems(meaningIds: string[], pronunciationIds: string[], locale: string): Promise<CuratedItem[]> {
    if (meaningIds.length === 0 && pronunciationIds.length === 0) return [];
    const items = await this.db.query.practiceItems.findMany({
      where: (item) => and(
        eq(item.status, ITEM_STATUS.PUBLISHED),
        exists(
          this.db.select({ one: sql`1` }).from(practiceItemTargets).where(and(
            eq(practiceItemTargets.practiceItemId, item.id),
            or(inArray(practiceItemTargets.meaningId, meaningIds), inArray(practiceItemTargets.pronunciationId, pronunciationIds)),
          )),
        ),
        exists(
          this.db.select({ one: sql`1` }).from(practiceItemLocalizations).where(and(
            eq(practiceItemLocalizations.practiceItemId, item.id),
            eq(practiceItemLocalizations.locale, locale),
            eq(practiceItemLocalizations.editorialState, EDITORIAL_STATE.APPROVED),
          )),
        ),
      ),
      columns: { id: true, template: true, variant: true, contextCefrLevel: true, sourceContent: true, sourceEvaluation: true },
      with: {
        localizations: { where: (l) => eq(l.locale, locale), columns: { localizedContent: true } },
        targets: { orderBy: (t) => asc(t.ordinal), columns: { meaningId: true, pronunciationId: true } },
      },
    });
    return items.map(({ localizations, ...item }) => ({
      ...item,
      localizedContent: localizations[0].localizedContent,
    }));
  }
}
