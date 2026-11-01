-- Challenges unlock every N learning sessions instead of every 7 days, since a day can hold several sessions.
ALTER TABLE user_meaning_progress ADD COLUMN learned_session_id UUID REFERENCES learning_sessions(id);
-- learned_at and observed_at are both the commit timestamp of the session that learned the Meaning.
UPDATE user_meaning_progress p SET learned_session_id = o.session_id
FROM memory_observations o
JOIN learning_sessions s ON s.id = o.session_id AND s.mode = 'daily'
WHERE o.user_id = p.user_id AND o.meaning_id = p.meaning_id AND o.observed_at = p.learned_at;

ALTER TABLE learning_sessions DROP CONSTRAINT learning_sessions_mode_check;
-- Immutability guards snapshot content; this only renames the enum value.
ALTER TABLE learning_sessions DISABLE TRIGGER learning_sessions_plan_immutable;
UPDATE learning_sessions SET
  mode = 'checkpoint_challenge',
  plan = replace(plan::text, '"weekly_challenge"', '"checkpoint_challenge"')::jsonb,
  result = replace(result::text, '"weekly_challenge"', '"checkpoint_challenge"')::jsonb
WHERE mode = 'weekly_challenge';
ALTER TABLE learning_sessions ENABLE TRIGGER learning_sessions_plan_immutable;
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_mode_check CHECK (mode IN ('daily','checkpoint_challenge','random_practice','weak_words_practice'));

ALTER TABLE weekly_challenges RENAME TO checkpoint_challenges;
ALTER TABLE weekly_challenge_meanings RENAME TO checkpoint_challenge_meanings;
ALTER TABLE checkpoint_challenges ADD COLUMN sequence INTEGER;
UPDATE checkpoint_challenges c SET sequence = n.sequence
FROM (SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY cycle_start_at) AS sequence FROM checkpoint_challenges) n
WHERE n.id = c.id;
ALTER TABLE checkpoint_challenges ALTER COLUMN sequence SET NOT NULL;

DROP INDEX idx_weekly_challenges_user;
ALTER TABLE checkpoint_challenges DROP COLUMN cycle_start_at, DROP COLUMN cycle_end_at;
ALTER TABLE checkpoint_challenges ADD CONSTRAINT checkpoint_challenges_user_id_sequence_key UNIQUE (user_id, sequence);

ALTER TABLE checkpoint_challenges RENAME CONSTRAINT weekly_challenges_pkey TO checkpoint_challenges_pkey;
ALTER TABLE checkpoint_challenges RENAME CONSTRAINT weekly_challenges_check1 TO checkpoint_challenges_check;
ALTER TABLE checkpoint_challenges RENAME CONSTRAINT weekly_challenges_state_check TO checkpoint_challenges_state_check;
ALTER TABLE checkpoint_challenges RENAME CONSTRAINT weekly_challenges_user_id_fkey TO checkpoint_challenges_user_id_fkey;
ALTER TABLE checkpoint_challenges RENAME CONSTRAINT weekly_challenges_completed_session_id_fkey TO checkpoint_challenges_completed_session_id_fkey;
ALTER TABLE checkpoint_challenge_meanings RENAME CONSTRAINT weekly_challenge_meanings_pkey TO checkpoint_challenge_meanings_pkey;
ALTER TABLE checkpoint_challenge_meanings RENAME CONSTRAINT weekly_challenge_meanings_challenge_id_fkey TO checkpoint_challenge_meanings_challenge_id_fkey;
ALTER TABLE checkpoint_challenge_meanings RENAME CONSTRAINT weekly_challenge_meanings_meaning_id_fkey TO checkpoint_challenge_meanings_meaning_id_fkey;

ALTER TABLE user_settings DROP COLUMN weekly_anchor_at;
