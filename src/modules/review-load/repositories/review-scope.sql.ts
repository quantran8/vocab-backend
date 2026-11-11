import { SQL, sql } from 'drizzle-orm';
import { CONTENT_STATUS, NEW_WORDS_BLOCKED_REASON } from '../../../common/constants/domain';

// Fragments shared by planner, learn-home, commit and the journey screens so R, C and B mean the same everywhere.
// `userId` is a bound uuid string; `locale` and column refs are SQL so callers can pass a column or a parameter.

/** (topic_id, meaning_id) of shared Meanings with a live publication in the learner's active topics of the active collection. */
export const scopeMembershipSql = (userId: string, locale: SQL) => sql`
  SELECT tm.topic_id, tm.meaning_id
  FROM user_learning_scope s
  JOIN user_active_topics uat ON uat.user_id = s.user_id
  JOIN topics t ON t.id = uat.topic_id AND t.collection_id = s.collection_id
    AND t.owner_user_id IS NULL AND t.status = ${CONTENT_STATUS.PUBLISHED}
  JOIN topic_meanings tm ON tm.topic_id = t.id
  JOIN meanings m ON m.id = tm.meaning_id AND m.owner_user_id IS NULL
  JOIN active_meaning_publications a ON a.meaning_id = tm.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
  WHERE s.user_id = ${userId}::uuid`;

/** Meanings in the learner's own roadmap topic with a live publication. */
export const customMembershipSql = (userId: string, locale: SQL) => sql`
  SELECT tm.meaning_id
  FROM topics t
  JOIN topic_meanings tm ON tm.topic_id = t.id
  JOIN active_meaning_publications a ON a.meaning_id = tm.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
  WHERE t.owner_user_id = ${userId}::uuid`;

export const unlearnedSql = (userId: string, meaningId: SQL) => sql`NOT EXISTS (
  SELECT 1 FROM user_meaning_progress ump_l WHERE ump_l.user_id = ${userId}::uuid AND ump_l.meaning_id = ${meaningId})`;

/** R: distinct scope Meanings not learned yet. */
export const remainingNewSql = (userId: string, locale: SQL) => sql`(
  SELECT count(DISTINCT sm.meaning_id)::int FROM (${scopeMembershipSql(userId, locale)}) sm
  WHERE ${unlearnedSql(userId, sql`sm.meaning_id`)})`;

/** C: the learner's own words not learned yet. */
export const pendingCustomSql = (userId: string, locale: SQL) => sql`(
  SELECT count(DISTINCT cm.meaning_id)::int FROM (${customMembershipSql(userId, locale)}) cm
  WHERE ${unlearnedSql(userId, sql`cm.meaning_id`)})`;

/**
 * A learned Meaning leaves review only when it is in a paused collection,
 * not in the active collection and not one of the learner's own words (§8).
 */
export const reviewableSql = (userId: string, meaningId: SQL) => sql`(
  NOT EXISTS (
    SELECT 1 FROM topic_meanings tm_p
    JOIN topics t_p ON t_p.id = tm_p.topic_id
    JOIN user_collection_review_pauses rp ON rp.collection_id = t_p.collection_id AND rp.user_id = ${userId}::uuid
    WHERE tm_p.meaning_id = ${meaningId})
  OR EXISTS (
    SELECT 1 FROM topic_meanings tm_k
    JOIN topics t_k ON t_k.id = tm_k.topic_id
    LEFT JOIN user_learning_scope s_k ON s_k.user_id = ${userId}::uuid
    WHERE tm_k.meaning_id = ${meaningId}
      AND (t_k.collection_id = s_k.collection_id OR t_k.owner_user_id = ${userId}::uuid)))`;

/** B: reviewable Meanings due at `now` that the planner can issue in `locale`. */
export const backlogSql = (userId: string, locale: SQL, now: Date) => sql`(
  SELECT count(*)::int FROM user_meaning_progress ump_b
  JOIN active_meaning_publications a_b ON a_b.meaning_id = ump_b.meaning_id AND a_b.locale = ${locale} AND a_b.recalled_at IS NULL
  WHERE ump_b.user_id = ${userId}::uuid AND ump_b.next_review_at <= ${now}::timestamptz
    AND ${reviewableSql(userId, sql`ump_b.meaning_id`)})`;

/** Why Daily has no new words at all; checkpoint_gate is reserved because nothing gates Daily. */
export const newWordsBlockedSql = (userId: string, locale: SQL) => sql`
  CASE WHEN ${remainingNewSql(userId, locale)} + ${pendingCustomSql(userId, locale)} = 0 THEN ${NEW_WORDS_BLOCKED_REASON.SCOPE_EXHAUSTED}::text END`;
