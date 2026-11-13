-- Ranking & Tier v1.2: LP ledger, lifetime Tier and the opt-in weekly ranking. The ledger is the source of truth;
-- effort totals, days and weekly scores are aggregates rebuilt from it.

-- Public identity: never derived from the email.
ALTER TABLE app_user
    ADD COLUMN username TEXT CHECK (username ~ '^[a-z][a-z0-9_.]{2,19}$' AND position('..' IN username) = 0),
    ADD COLUMN username_generated BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN username_changed_at TIMESTAMPTZ,
    ADD COLUMN avatar_key VARCHAR(32),
    ADD COLUMN ranking_eligible BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN ranking_intro_seen BOOLEAN NOT NULL DEFAULT false;

-- Same word lists as src/modules/ranking/domain/username.ts at the time of writing.
DO $$
DECLARE
  adjectives TEXT[] := ARRAY['bright','quick','happy','sunny','gentle','kind','swift','merry','lucky','jolly','bold','eager',
    'keen','noble','proud','quiet','witty','zesty','cheery','nimble','steady','polite','brisk','plucky','sparky','cozy','mellow',
    'dreamy','curious','humble','jazzy','fuzzy'];
  animals TEXT[] := ARRAY['otter','panda','koala','tiger','lynx','heron','robin','finch','gecko','llama','bison','moose','eagle',
    'falcon','badger','beaver','rabbit','turtle','walrus','owl','fox','wolf','seal','crane','dingo','zebra','hippo','yak','lemur',
    'quokka','ferret','puffin'];
  avatars TEXT[] := ARRAY['syllie_sunny','syllie_sleepy','syllie_curious','syllie_brave','syllie_calm','syllie_cheerful',
    'syllie_thinker','syllie_explorer','syllie_reader','syllie_artist','syllie_sporty','syllie_starry'];
  u RECORD;
  candidate TEXT;
BEGIN
  FOR u IN SELECT id FROM app_user WHERE username IS NULL LOOP
    LOOP
      candidate := adjectives[1 + floor(random() * array_length(adjectives, 1))::int] || '_'
        || animals[1 + floor(random() * array_length(animals, 1))::int] || '_'
        || lpad(floor(random() * 10000)::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM app_user WHERE username = candidate);
    END LOOP;
    UPDATE app_user SET username = candidate, avatar_key = avatars[1 + floor(random() * array_length(avatars, 1))::int] WHERE id = u.id;
  END LOOP;
END $$;

ALTER TABLE app_user
    ALTER COLUMN username SET NOT NULL,
    ALTER COLUMN avatar_key SET NOT NULL,
    ADD CONSTRAINT app_user_username_key UNIQUE (username);

-- Privacy by default: nobody is listed until they opt in.
ALTER TABLE user_settings ADD COLUMN leaderboard_visible BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE learning_point_awards (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_user(id),
    session_id UUID NOT NULL REFERENCES learning_sessions(id),
    meaning_id UUID NOT NULL,
    award_type VARCHAR(32) NOT NULL
       CHECK (award_type IN ('new_meaning_completed','due_review_completed','extra_practice_completed')),
    award_key TEXT NOT NULL,
    points SMALLINT NOT NULL CHECK (points > 0),
    awarded_at TIMESTAMPTZ NOT NULL,
    scoring_day DATE NOT NULL,
    week_start DATE NOT NULL,
    lp_policy_version VARCHAR(40) NOT NULL,
    content_provenance VARCHAR(16) NOT NULL CHECK (content_provenance IN ('catalog','custom_owned')),
    UNIQUE (user_id, award_key),
    CHECK (scoring_day = (awarded_at AT TIME ZONE 'UTC')::date),
    CHECK (week_start = date_trunc('week', awarded_at AT TIME ZONE 'UTC')::date)
);
CREATE INDEX idx_learning_point_awards_user_meaning ON learning_point_awards(user_id, meaning_id, awarded_at);
CREATE INDEX idx_learning_point_awards_user_day ON learning_point_awards(user_id, scoring_day);

CREATE TABLE user_effort_totals (
    user_id UUID PRIMARY KEY REFERENCES app_user(id),
    lifetime_lp BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_lp >= 0),
    lifetime_active_days INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_active_days >= 0),
    tier_level SMALLINT NOT NULL DEFAULT 0 CHECK (tier_level BETWEEN 0 AND 7),
    tier_policy_version VARCHAR(40) NOT NULL,
    last_award_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every UTC day with LP, including days below the qualifying threshold.
CREATE TABLE user_effort_days (
    user_id UUID NOT NULL REFERENCES app_user(id),
    scoring_day DATE NOT NULL,
    earned_lp INTEGER NOT NULL CHECK (earned_lp > 0),
    PRIMARY KEY (user_id, scoring_day)
);

CREATE TABLE user_tier_unlocks (
    user_id UUID NOT NULL REFERENCES app_user(id),
    tier_level SMALLINT NOT NULL CHECK (tier_level BETWEEN 1 AND 7),
    tier_key VARCHAR(32) NOT NULL,
    unlocked_at TIMESTAMPTZ NOT NULL,
    tier_policy_version VARCHAR(40) NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('live','backfill','policy_migration')),
    PRIMARY KEY (user_id, tier_level)
);

CREATE TABLE weekly_lp_scores (
    user_id UUID NOT NULL REFERENCES app_user(id),
    week_start DATE NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    points BIGINT NOT NULL CHECK (points > 0),
    last_award_at TIMESTAMPTZ NOT NULL,
    listed BOOLEAN NOT NULL,
    PRIMARY KEY (user_id, week_start)
);
CREATE INDEX idx_weekly_lp_scores_board ON weekly_lp_scores(week_start, points DESC, last_award_at, user_id) WHERE listed;

CREATE TABLE weekly_rank_stats (
    week_start DATE PRIMARY KEY CHECK (extract(isodow FROM week_start) = 1),
    computed_at TIMESTAMPTZ NOT NULL,
    total_listed INTEGER NOT NULL CHECK (total_listed >= 0),
    top1000_min_points BIGINT,
    histogram JSONB NOT NULL CHECK (jsonb_typeof(histogram) = 'object')
);

-- Weekly results only: no Tier column, Tier is lifetime.
CREATE TABLE weekly_rank_snapshots (
    week_start DATE NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    user_id UUID NOT NULL REFERENCES app_user(id),
    points BIGINT NOT NULL CHECK (points > 0),
    rank BIGINT CHECK (rank >= 1),
    listed_at_close BOOLEAN NOT NULL,
    ranking_policy_version VARCHAR(40) NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (week_start, user_id),
    CHECK ((rank IS NOT NULL) = listed_at_close)
);
CREATE INDEX idx_weekly_rank_snapshots_user ON weekly_rank_snapshots(user_id, week_start);

CREATE FUNCTION forbid_weekly_rank_snapshot_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'weekly_rank_snapshots is immutable' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER weekly_rank_snapshots_immutable
  BEFORE UPDATE ON weekly_rank_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_weekly_rank_snapshot_update();

CREATE TABLE user_reports (
    id UUID PRIMARY KEY,
    reporter_id UUID NOT NULL REFERENCES app_user(id),
    target_user_id UUID NOT NULL REFERENCES app_user(id),
    reason VARCHAR(32) NOT NULL CHECK (reason IN ('offensive_name','impersonation','suspicious_activity','other')),
    week_start DATE NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    resolution VARCHAR(32) CHECK (resolution IN ('username_reset','ranking_ineligible','dismissed')),
    CHECK (reporter_id <> target_user_id),
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX user_reports_once ON user_reports(reporter_id, target_user_id, week_start);
CREATE INDEX idx_user_reports_open ON user_reports(created_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_user_reports_reporter ON user_reports(reporter_id, created_at);

CREATE TABLE ranking_eligibility_audit (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_user(id),
    actor_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    eligible BOOLEAN NOT NULL,
    reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_ranking_eligibility_audit_user ON ranking_eligibility_audit(user_id, created_at);

ALTER TABLE learning_point_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_effort_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_effort_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tier_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_lp_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_rank_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_rank_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking_eligibility_audit ENABLE ROW LEVEL SECURITY;
