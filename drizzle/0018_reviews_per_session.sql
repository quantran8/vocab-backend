-- Reviews per daily session. NULL follows daily_new_word_goal (at least the minimum), see reviewsPerSession().
ALTER TABLE user_settings ADD COLUMN reviews_per_session SMALLINT CHECK (reviews_per_session BETWEEN 5 AND 50);
