-- Challenge Map (Match Madness): recognition games over learned Meanings, never SRS or skill evidence.
CREATE TABLE challenge_chapters (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_user(id),
    chapter_no INTEGER NOT NULL CHECK (chapter_no >= 1),
    explanation_locale VARCHAR(32) NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, chapter_no),
    UNIQUE (id, user_id)
);
-- Frozen lemma and gloss per slot; a slot is live from content_version until retired_in_version.
CREATE TABLE challenge_chapter_meanings (
    id UUID PRIMARY KEY,
    chapter_id UUID NOT NULL,
    user_id UUID NOT NULL,
    meaning_id UUID REFERENCES meanings(id),
    role VARCHAR(8) NOT NULL CHECK (role IN ('core','review')),
    sort_index SMALLINT NOT NULL CHECK (sort_index >= 0),
    lemma TEXT NOT NULL,
    gloss TEXT NOT NULL,
    word_key TEXT NOT NULL,
    gloss_key TEXT NOT NULL,
    content_version INTEGER NOT NULL CHECK (content_version >= 1),
    retired_in_version INTEGER CHECK (retired_in_version > content_version),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (chapter_id, user_id) REFERENCES challenge_chapters(id, user_id)
);
-- A Meaning is core in at most one chapter; review slots may repeat it.
CREATE UNIQUE INDEX challenge_chapter_meanings_core_key ON challenge_chapter_meanings(user_id, meaning_id)
    WHERE role = 'core' AND retired_in_version IS NULL;
CREATE UNIQUE INDEX challenge_chapter_meanings_slot_key ON challenge_chapter_meanings(chapter_id, role, sort_index)
    WHERE retired_in_version IS NULL;
CREATE UNIQUE INDEX challenge_chapter_meanings_meaning_key ON challenge_chapter_meanings(chapter_id, meaning_id)
    WHERE retired_in_version IS NULL;
CREATE TABLE challenge_level_progress (
    user_id UUID NOT NULL,
    chapter_id UUID NOT NULL,
    level_no SMALLINT NOT NULL CHECK (level_no BETWEEN 1 AND 3),
    best_stars SMALLINT NOT NULL DEFAULT 0 CHECK (best_stars BETWEEN 0 AND 3),
    best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0),
    best_completion_ms INTEGER CHECK (best_completion_ms >= 0),
    first_cleared_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, chapter_id, level_no),
    FOREIGN KEY (chapter_id, user_id) REFERENCES challenge_chapters(id, user_id),
    CHECK ((best_stars = 0) = (first_cleared_at IS NULL)),
    CHECK ((best_completion_ms IS NULL) = (first_cleared_at IS NULL))
);
-- plan and events are purgeable after retention; result and commit_response are kept.
CREATE TABLE challenge_runs (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    chapter_id UUID NOT NULL,
    level_no SMALLINT NOT NULL CHECK (level_no BETWEEN 1 AND 3),
    game_mode VARCHAR(24) NOT NULL CHECK (game_mode IN ('match_madness')),
    policy_version VARCHAR(40) NOT NULL,
    content_version INTEGER NOT NULL CHECK (content_version >= 1),
    status VARCHAR(16) NOT NULL DEFAULT 'issued'
       CHECK (status IN ('issued','started','committed','abandoned','expired')),
    plan JSONB CHECK (jsonb_typeof(plan) = 'object'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ,
    events JSONB CHECK (jsonb_typeof(events) = 'array'),
    commit_request_sha256 CHAR(64),
    commit_response JSONB,
    result JSONB CHECK (jsonb_typeof(result) = 'object'),
    FOREIGN KEY (chapter_id, user_id) REFERENCES challenge_chapters(id, user_id),
    CHECK (status NOT IN ('issued','started') OR plan IS NOT NULL),
    CHECK (status NOT IN ('started','committed') OR started_at IS NOT NULL),
    CHECK ((status = 'committed') = (committed_at IS NOT NULL AND commit_response IS NOT NULL AND result IS NOT NULL))
);
-- One live run per learner.
CREATE UNIQUE INDEX challenge_runs_open_key ON challenge_runs(user_id) WHERE status IN ('issued','started');
CREATE INDEX idx_challenge_runs_open_expiry ON challenge_runs(expires_at) WHERE status IN ('issued','started');

CREATE FUNCTION forbid_challenge_run_plan_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan IS NOT NULL AND NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'challenge_runs.plan is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_runs_plan_immutable
  BEFORE UPDATE OF plan ON challenge_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_challenge_run_plan_rewrite();

ALTER TABLE challenge_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_chapter_meanings ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_level_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_runs ENABLE ROW LEVEL SECURITY;
