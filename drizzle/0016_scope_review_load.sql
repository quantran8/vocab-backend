-- Scope completion and review load: a temporary new-word override, opt-in auto-balance,
-- per-collection review pauses, the review-load prompt state, and the topic a meaning was first learned from.
ALTER TABLE user_settings
  ADD COLUMN auto_balance_new_words BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN new_word_override SMALLINT CHECK (new_word_override >= 1),
  ADD COLUMN new_word_override_mode VARCHAR(32) CHECK (new_word_override_mode IN ('until_date','until_backlog_clear')),
  ADD COLUMN new_word_override_until TIMESTAMPTZ,
  ADD CHECK ((new_word_override IS NULL) = (new_word_override_mode IS NULL)),
  ADD CHECK ((new_word_override_until IS NOT NULL) = (new_word_override_mode IS NOT DISTINCT FROM 'until_date'));

CREATE TABLE user_collection_review_pauses (
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id),
  paused_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, collection_id)
);

CREATE TABLE user_review_load_prompts (
  user_id UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  last_prompted_backlog INTEGER CHECK (last_prompted_backlog >= 0),
  last_prompted_at TIMESTAMPTZ
);

ALTER TABLE user_meaning_progress ADD COLUMN learned_via_topic_id UUID REFERENCES topics(id) ON DELETE SET NULL;

ALTER TABLE user_collection_review_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_review_load_prompts ENABLE ROW LEVEL SECURITY;
