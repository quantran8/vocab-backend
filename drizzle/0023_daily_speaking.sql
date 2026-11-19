-- Opt-in recordings in Daily; they never move memory (docs/DECISIONS.md "Daily speaking").
ALTER TABLE user_settings ADD COLUMN daily_speaking BOOLEAN NOT NULL DEFAULT false;
