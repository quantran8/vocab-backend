import { sql } from 'drizzle-orm';
import { CONTENT_STATUS } from '../../../common/constants/domain';

/**
 * One row per shared Topic Meaning with a live publication in the learner's explanation locale, with its
 * `learned_at` (null when not learned). The catalog's learned/total counts and the journey's "topic finished" use it.
 */
export const topicMeaningsSql = (userId: string) => sql`
  SELECT t.collection_id, t.id AS topic_id, tm.meaning_id, u.learned_at
  FROM topics t
  JOIN collections c ON c.id = t.collection_id AND c.status = ${CONTENT_STATUS.PUBLISHED}
  JOIN topic_meanings tm ON tm.topic_id = t.id
  JOIN meanings mm ON mm.id = tm.meaning_id AND mm.owner_user_id IS NULL
  JOIN active_meaning_publications a ON a.meaning_id = tm.meaning_id AND a.recalled_at IS NULL
    AND a.locale = (SELECT explanation_locale FROM user_settings WHERE user_id = ${userId}::uuid)
  LEFT JOIN user_meaning_progress u ON u.user_id = ${userId}::uuid AND u.meaning_id = tm.meaning_id
  WHERE t.status = ${CONTENT_STATUS.PUBLISHED} AND t.owner_user_id IS NULL`;
