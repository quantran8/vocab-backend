import { sql } from 'drizzle-orm';
import { EVIDENCE_REASON, VALIDITY } from '../../common/constants/domain';
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
