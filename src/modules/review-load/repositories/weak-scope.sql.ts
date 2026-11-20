import { sql } from 'drizzle-orm';
import { MEMORY_SIGNAL } from '../../../common/constants/domain';
import { addHours, HOURS_PER_DAY } from '../../../common/constants/time';
import { POLICY } from '../../../config/policy';
import { reviewableSql } from './review-scope.sql';

const weakSignal = sql`o.signal NOT IN (${MEMORY_SIGNAL.UNAIDED_RECALL}, ${MEMORY_SIGNAL.RECOGNITION_SUCCESS})`;

/**
 * (meaning_id, word_id, weak_ratio) of learned, reviewable Meanings that are weak in the window since `since`:
 * enough observations, at least one weak, and the latest one weak, so a clean answer clears the word.
 * Observations from the session that learned the word do not count. Weak practice and needPracticeWords both read this.
 */
export const weakMeaningsSql = (userId: string, since: Date) => sql`
  SELECT o.meaning_id, wt.word_id, (count(*) FILTER (WHERE ${weakSignal}))::numeric / count(*) AS weak_ratio
  FROM memory_observations o
  JOIN user_meaning_progress ump ON ump.user_id = o.user_id AND ump.meaning_id = o.meaning_id
  JOIN meanings m ON m.id = o.meaning_id
  JOIN word_types wt ON wt.id = m.type_id
  JOIN active_meaning_publications a_w ON a_w.meaning_id = o.meaning_id AND a_w.recalled_at IS NULL
    AND a_w.locale = (SELECT explanation_locale FROM user_settings WHERE user_id = ${userId}::uuid)
  WHERE o.user_id = ${userId}::uuid AND o.observed_at >= ${since}::timestamptz
    AND o.session_id IS DISTINCT FROM ump.learned_session_id
  GROUP BY o.meaning_id, wt.word_id
  HAVING count(*) >= ${POLICY.weak.minAttempts}::int
    AND count(*) FILTER (WHERE ${weakSignal}) > 0
    AND (array_agg(${weakSignal} ORDER BY o.observed_at DESC, o.session_id DESC))[1]
    AND ${reviewableSql(userId, sql`o.meaning_id`)}`;

/** `needPracticeWords` as one scalar subquery. Inside a writing statement it sees the pre-write rows. */
export const needPracticeWordsSql = (userId: string, since: Date) => sql`(
  SELECT count(DISTINCT w.word_id)::int FROM (${weakMeaningsSql(userId, since)}) w)`;

/** Start of the Weak window for a request made at `now`. */
export const weakSince = (now: Date) => addHours(now, -POLICY.weak.lookbackDays * HOURS_PER_DAY);
