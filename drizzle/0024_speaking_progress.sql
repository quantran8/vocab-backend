-- The skill system goes; speaking keeps one row per pronunciation (docs/DECISIONS.md "Skill system removed"). No backfill.
CREATE TABLE user_speaking_progress (
  user_id UUID NOT NULL REFERENCES app_user(id),
  pronunciation_id UUID NOT NULL REFERENCES pronunciations(id),
  status VARCHAR(12) NOT NULL CHECK (status IN ('practicing','fluent')),
  device_sessions INTEGER NOT NULL DEFAULT 0 CHECK (device_sessions >= 0),
  device_streak SMALLINT NOT NULL DEFAULT 0 CHECK (device_streak >= 0),
  scored_sessions INTEGER NOT NULL DEFAULT 0 CHECK (scored_sessions >= 0),
  score_avg NUMERIC(5,2),
  last_score NUMERIC(5,2),
  best_score NUMERIC(5,2),
  last_passed BOOLEAN NOT NULL,
  last_assessed_at TIMESTAMPTZ NOT NULL,
  fluent_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, pronunciation_id),
  CHECK ((scored_sessions = 0) = (score_avg IS NULL)),
  CHECK ((status = 'fluent') = (fluent_at IS NOT NULL))
);
CREATE INDEX idx_speaking_user_due ON user_speaking_progress (user_id, status, last_passed, last_assessed_at);
ALTER TABLE user_speaking_progress ENABLE ROW LEVEL SECURITY;

DROP TABLE skill_evidence;

ALTER TABLE learning_sessions DROP CONSTRAINT learning_sessions_mode_check;
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_mode_check
  CHECK (mode IN ('daily','checkpoint_challenge','random_practice','weak_words_practice','speaking_practice'));
