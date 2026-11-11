-- A checkpoint challenge (the Journey's review) opens after as many sessions as the learner plans per week.
-- 7 keeps the size every challenge had so far.
ALTER TABLE user_settings ADD COLUMN weekly_session_goal SMALLINT NOT NULL DEFAULT 7 CHECK (weekly_session_goal BETWEEN 1 AND 7);
