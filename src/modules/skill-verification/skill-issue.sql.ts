import { sql } from 'drizzle-orm';
import { DEFAULT_ACCENT, EVIDENCE_REASON, VALIDITY } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';
import { SKILL_STATE_REASONS } from './skill-evidence';

export const skillStateReasonsSql = sql`reasons <@ ${JSON.stringify(SKILL_STATE_REASONS)}::jsonb`;

const ONLY_PRIMED = JSON.stringify([EVIDENCE_REASON.PRIMED]);

/** Rows (skill, meaning_id, pronunciation_id) mirroring deriveSkillStatus's issue, as one subquery for a CTE. */
export const openSkillIssuesSql = (userId: string, since?: Date) => sql`
  SELECT i.skill, i.meaning_id, i.pronunciation_id
  FROM (
    SELECT DISTINCT ON (skill, COALESCE(meaning_id, pronunciation_id)) skill, meaning_id, pronunciation_id, committed_at
    FROM skill_evidence
    WHERE user_id = ${userId}::uuid AND validity = ${VALIDITY.VALID} AND ${skillStateReasonsSql}
      AND NOT (passed AND (reasons = '[]'::jsonb OR reasons = ${ONLY_PRIMED}::jsonb))
    ORDER BY skill, COALESCE(meaning_id, pronunciation_id), committed_at DESC, id DESC
  ) i
  WHERE ${since ? sql`i.committed_at >= ${since}::timestamptz` : sql`true`}
    AND NOT EXISTS (
      SELECT 1 FROM skill_evidence p
      WHERE p.user_id = ${userId}::uuid AND p.skill = i.skill
        AND p.meaning_id IS NOT DISTINCT FROM i.meaning_id AND p.pronunciation_id IS NOT DISTINCT FROM i.pronunciation_id
        AND p.reasons = '[]'::jsonb AND p.passed AND p.validity = ${VALIDITY.VALID}
        AND p.committed_at >= i.committed_at + make_interval(hours => ${POLICY.memory.recoveryHours}::int))`;

/** Learned Meanings with the word they belong to and its default-accent pronunciation (listening/speaking scope). */
export const learnedWithPronunciationSql = (userId: string) => sql`
  SELECT wt.word_id, ump.meaning_id,
    (SELECT (e->>'id')::uuid FROM jsonb_array_elements(p.snapshot->'pronunciations') e
     WHERE e->>'accentLocale' = ${DEFAULT_ACCENT} LIMIT 1) AS pronunciation_id
  FROM user_meaning_progress ump
  JOIN meanings m ON m.id = ump.meaning_id
  JOIN word_types wt ON wt.id = m.type_id
  JOIN user_settings s ON s.user_id = ump.user_id
  JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = s.explanation_locale
  JOIN meaning_publications p ON p.id = a.publication_id
  WHERE ump.user_id = ${userId}::uuid`;

/** `needPracticeWords` of GET /me/words/stats as one scalar subquery. Inside a writing statement it sees the pre-write rows. */
export const needPracticeWordsSql = (userId: string) => sql`(
  WITH learned AS (${learnedWithPronunciationSql(userId)}), open_issue AS (${openSkillIssuesSql(userId)})
  SELECT count(DISTINCT l.word_id)::int FROM learned l
  WHERE EXISTS (SELECT 1 FROM open_issue e WHERE e.meaning_id = l.meaning_id OR e.pronunciation_id = l.pronunciation_id))`;
