import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { MEMORY_SIGNAL } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { checkpointChallenges, userSettings } from '../../../db/schema';
import { JourneyChallenge, JourneySession, JourneyWindow } from '../domain/journey';

@Injectable()
export class JourneyRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** One row per challenge; a user gains one every N sessions, so this stays small. */
  challenges(userId: string): Promise<JourneyChallenge[]> {
    return this.db
      .select({
        id: checkpointChallenges.id,
        sequence: checkpointChallenges.sequence,
        state: checkpointChallenges.state,
        completedSessionId: checkpointChallenges.completedSessionId,
      })
      .from(checkpointChallenges)
      .where(eq(checkpointChallenges.userId, userId))
      .orderBy(asc(checkpointChallenges.sequence));
  }

  /**
   * Sessions that learned Meanings, in the order legacy challenges were cut from,
   * limited to the window plus the sessions no challenge holds yet.
   */
  async sessions(userId: string, { lo, hi, current }: JourneyWindow): Promise<JourneySession[]> {
    const { rows } = await this.db.execute<JourneySession>(sql`
      SELECT p.learned_session_id::text AS "sessionId", max(c.sequence)::int AS sequence
      FROM user_meaning_progress p
      LEFT JOIN (checkpoint_challenge_meanings m
                 JOIN checkpoint_challenges c ON c.id = m.challenge_id AND c.user_id = ${userId}::uuid)
        ON m.meaning_id = p.meaning_id
      WHERE p.user_id = ${userId}::uuid AND p.learned_session_id IS NOT NULL
      GROUP BY p.learned_session_id
      HAVING max(c.sequence) IS NULL OR max(c.sequence) BETWEEN ${lo}::int AND ${hi}::int OR max(c.sequence) = ${current}::int
      ORDER BY min(p.learned_at), p.learned_session_id`);
    return rows;
  }

  async weeklyGoal(userId: string) {
    const [row] = await this.db
      .select({ goal: userSettings.weeklySessionGoal })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    return row?.goal;
  }

  /** Recall counts per completed review session. */
  async reviewCounts(sessionIds: string[]) {
    if (sessionIds.length === 0) return [];
    const { rows } = await this.db.execute<{ sessionId: string; reviewed: number; unaided: number }>(sql`
      SELECT session_id::text AS "sessionId", count(*)::int AS reviewed,
             count(*) FILTER (WHERE signal = ${MEMORY_SIGNAL.UNAIDED_RECALL})::int AS unaided
      FROM memory_observations
      WHERE session_id IN (${sql.join(sessionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      GROUP BY session_id`);
    return rows;
  }
}
