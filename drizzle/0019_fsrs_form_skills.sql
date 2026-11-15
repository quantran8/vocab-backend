-- FSRS memory state replaces the trial interval scheduler (docs/FSRS_PLAN.md).
-- Existing rows convert directly: stability from the current interval, difficulty from D0(Good) plus one per lapse.
ALTER TABLE user_meaning_progress
  ADD COLUMN stability NUMERIC(12,4) CHECK (stability > 0),
  ADD COLUMN difficulty NUMERIC(6,4) CHECK (difficulty BETWEEN 1 AND 10);
UPDATE user_meaning_progress
SET stability = GREATEST(interval_hours / 24, 0.1),
    difficulty = LEAST(10, 2.1181 + lapse_count),
    scheduler_version = 'fsrs6-weighted-v1';
ALTER TABLE user_meaning_progress
  ALTER COLUMN stability SET NOT NULL,
  ALTER COLUMN difficulty SET NOT NULL,
  DROP COLUMN interval_hours,
  DROP COLUMN unaided_streak,
  DROP COLUMN recognition_grace_used;

-- The FSRS rating and the evidence weight behind it; NULL when the session did not move the schedule.
ALTER TABLE memory_observations
  ADD COLUMN grade VARCHAR(8) CHECK (grade IN ('again','hard','good','easy')),
  ADD COLUMN evidence_weight NUMERIC(4,3) CHECK (evidence_weight BETWEEN 0 AND 1);

-- Skills test form only: reading duplicated meaning memory, writing becomes spelling.
ALTER TABLE skill_evidence DROP CONSTRAINT skill_evidence_skill_check, DROP CONSTRAINT skill_evidence_check1;
DELETE FROM skill_evidence WHERE skill = 'reading';
UPDATE skill_evidence SET skill = 'spelling' WHERE skill = 'writing';
ALTER TABLE skill_evidence
  ADD CONSTRAINT skill_evidence_skill_check CHECK (skill IN ('listening','speaking','spelling')),
  ADD CONSTRAINT skill_evidence_check1 CHECK ((skill = 'spelling' AND meaning_id IS NOT NULL)
    OR (skill IN ('listening','speaking') AND pronunciation_id IS NOT NULL));
