-- The learner may now choose 1–50 reviews per session (unset still follows the goal, at least 5).
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_reviews_per_session_check;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_reviews_per_session_check CHECK (reviews_per_session BETWEEN 1 AND 50);
