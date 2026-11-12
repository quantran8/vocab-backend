-- Vocab Flow MVP · Backend Spec v0.4 · PostgreSQL 16+ reference bootstrap · REVIEW DRAFT
-- Prerequisite: app-controlled migrations; DB role with UUID generator support.
-- UUID generation uses PostgreSQL built-in gen_random_uuid().
-- Operational precondition: existing auth system sends verified identity subject.
BEGIN;

-- A. Identity, preferences and curated scope
CREATE TABLE app_user (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_subject TEXT NOT NULL UNIQUE,
    proficiency_level VARCHAR(2) CHECK (proficiency_level IN ('A1','A2','B1','B2','C1','C2')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Public identity for the ranking; generated on provisioning, never derived from the email.
    username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z][a-z0-9_.]{2,19}$' AND position('..' IN username) = 0),
    username_generated BOOLEAN NOT NULL DEFAULT true,
    username_changed_at TIMESTAMPTZ,
    avatar_key VARCHAR(32) NOT NULL,
    ranking_eligible BOOLEAN NOT NULL DEFAULT true,
    ranking_intro_seen BOOLEAN NOT NULL DEFAULT false
);

-- A deleted account's access tokens stay valid until they expire; this stops them provisioning a new user.
CREATE TABLE deleted_identities (
    identity_subject TEXT PRIMARY KEY,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    learning_language VARCHAR(16) NOT NULL DEFAULT 'en',
    explanation_locale VARCHAR(32) NOT NULL DEFAULT 'vi-VN',
    ui_locale VARCHAR(32) NOT NULL DEFAULT 'vi-VN',
    time_zone VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    daily_new_word_goal SMALLINT NOT NULL DEFAULT 5 CHECK (daily_new_word_goal BETWEEN 1 AND 30),
    weekly_session_goal SMALLINT NOT NULL DEFAULT 7 CHECK (weekly_session_goal BETWEEN 1 AND 7), -- sessions per checkpoint challenge
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    auto_balance_new_words BOOLEAN NOT NULL DEFAULT false,
    -- A temporary lower new-word count the learner chose; below daily_new_word_goal.
    new_word_override SMALLINT CHECK (new_word_override >= 1),
    new_word_override_mode VARCHAR(32) CHECK (new_word_override_mode IN ('until_date','until_backlog_clear')),
    new_word_override_until TIMESTAMPTZ,
    leaderboard_visible BOOLEAN NOT NULL DEFAULT false,
    reviews_per_session SMALLINT CHECK (reviews_per_session BETWEEN 5 AND 50), -- NULL follows daily_new_word_goal
    CHECK ((new_word_override IS NULL) = (new_word_override_mode IS NULL)),
    CHECK ((new_word_override_until IS NOT NULL) = (new_word_override_mode IS NOT DISTINCT FROM 'until_date'))
);

CREATE TABLE collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft'
       CHECK (status IN ('draft','published','archived'))
);
CREATE TABLE topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id UUID NOT NULL REFERENCES collections(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft'
       CHECK (status IN ('draft','published','archived')),
    owner_user_id UUID REFERENCES app_user(id), -- set only on a learner's personal roadmap topic
    UNIQUE (collection_id, slug)
);
CREATE UNIQUE INDEX topics_owner_user_id_key ON topics(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE TABLE collection_localizations (
    collection_id UUID NOT NULL REFERENCES collections(id),
    locale VARCHAR(32) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (collection_id, locale)
);
CREATE TABLE topic_localizations (
    topic_id UUID NOT NULL REFERENCES topics(id),
    locale VARCHAR(32) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (topic_id, locale)
);
CREATE TABLE user_learning_scope (
    user_id UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    collection_id UUID NOT NULL REFERENCES collections(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE user_active_topics (
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id),
    PRIMARY KEY (user_id, topic_id)
);
-- Learned Meanings of a paused collection leave review unless they are also in the active collection or the learner's own words.
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

-- B. Canonical vocabulary data (editor may edit drafts; runtime reads published snapshots)
CREATE TABLE words (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    language VARCHAR(16) NOT NULL,
    lemma TEXT NOT NULL,
    homograph_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A lemma exists once per language, whatever its case; homograph_key separates true homographs.
CREATE UNIQUE INDEX words_language_lemma_key ON words(language, lower(btrim(lemma)), homograph_key) NULLS NOT DISTINCT;
CREATE TABLE word_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    word_id UUID NOT NULL REFERENCES words(id),
    part_of_speech VARCHAR(32) NOT NULL CHECK (part_of_speech IN
       ('noun','verb','adjective','adverb','pronoun','preposition','conjunction','interjection','phrasal_verb')),
    UNIQUE (id, word_id),
    UNIQUE (word_id, part_of_speech)
);
CREATE TABLE pronunciations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type_id UUID NOT NULL REFERENCES word_types(id),
    accent_locale VARCHAR(32) NOT NULL,
    ipa TEXT, -- may be NULL in draft; publish validator requires IPA
    audio_asset_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type_id, accent_locale),
    CHECK (ipa IS NULL OR length(btrim(ipa)) > 0)
);
CREATE TABLE meanings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type_id UUID NOT NULL REFERENCES word_types(id),
    cefr_level VARCHAR(2) CHECK (cefr_level IN ('A1','A2','B1','B2','C1','C2')),
    core_definition TEXT, -- nullable in draft; publish requires a usable definition
    origin VARCHAR(16) NOT NULL DEFAULT 'curated' CHECK (origin IN ('curated','ai_generated')),
    created_by_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    owner_user_id UUID REFERENCES app_user(id), -- set on a private meaning; NULL means the shared pool
    reviewed_by_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    lexical_draft_id UUID, -- FK added after lexical_drafts
    draft_sense_index SMALLINT,
    popularity SMALLINT CHECK (popularity BETWEEN 0 AND 100), -- higher = more common sense; picks which meaning of a word is learned first
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (lexical_draft_id, draft_sense_index)
);
CREATE INDEX idx_meanings_ai_generated ON meanings(created_at DESC) WHERE origin = 'ai_generated';
CREATE INDEX idx_meanings_owner ON meanings(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE TABLE meaning_examples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    source_text TEXT NOT NULL,
    target_locator JSONB NOT NULL,
    CHECK (jsonb_typeof(target_locator) = 'object')
);
CREATE TABLE meaning_localizations (
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    locale VARCHAR(32) NOT NULL,
    meaning_text TEXT NOT NULL,
    definition_text TEXT NOT NULL,
    editorial_state VARCHAR(16) NOT NULL DEFAULT 'draft'
       CHECK (editorial_state IN ('draft','approved')),
    origin VARCHAR(16) NOT NULL DEFAULT 'curated' CHECK (origin IN ('curated','ai_generated')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (meaning_id, locale)
);
CREATE TABLE example_localizations (
    example_id UUID NOT NULL REFERENCES meaning_examples(id),
    locale VARCHAR(32) NOT NULL,
    translation_text TEXT NOT NULL,
    PRIMARY KEY (example_id, locale)
);
-- Custom words: AI output, shared across users; the pool is written only from these rows.
CREATE TABLE lexical_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('word','meaning','translation')),
    language VARCHAR(16) NOT NULL,
    normalized_text TEXT NOT NULL,
    locale VARCHAR(32) NOT NULL,
    context_key TEXT NOT NULL DEFAULT '',
    meaning_id UUID REFERENCES meanings(id),
    owner_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    model TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (language, normalized_text, locale, context_key)
);
CREATE INDEX idx_lexical_drafts_meaning ON lexical_drafts(meaning_id, locale) WHERE meaning_id IS NOT NULL;
ALTER TABLE meanings ADD FOREIGN KEY (lexical_draft_id) REFERENCES lexical_drafts(id);
-- A learner's private edit; the shared publication is never changed by it.
CREATE TABLE user_meaning_overrides (
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    locale VARCHAR(32) NOT NULL,
    content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, meaning_id, locale)
);
CREATE TABLE custom_word_usage (
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    lookups INTEGER NOT NULL DEFAULT 0 CHECK (lookups >= 0),
    PRIMARY KEY (user_id, day)
);
CREATE TABLE topic_meanings (
    topic_id UUID NOT NULL REFERENCES topics(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    curated_rank INTEGER NOT NULL CHECK (curated_rank > 0),
    PRIMARY KEY (topic_id, meaning_id),
    UNIQUE (topic_id, curated_rank)
);

-- Published Meaning×locale content is an immutable approved JSON snapshot.
-- Runtime MUST resolve from meaning_publications + active_meaning_publications,
-- never from mutable draft/localization tables.
CREATE TABLE meaning_publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    locale VARCHAR(32) NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    approved_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (meaning_id, locale, revision),
    UNIQUE (id, meaning_id, locale)
);
CREATE TABLE active_meaning_publications (
    meaning_id UUID NOT NULL,
    locale VARCHAR(32) NOT NULL,
    publication_id UUID NOT NULL,
    recalled_at TIMESTAMPTZ,
    PRIMARY KEY (meaning_id, locale),
    FOREIGN KEY (publication_id, meaning_id, locale)
        REFERENCES meaning_publications (id, meaning_id, locale)
);

-- C. Curated practice: each row is one immutable approved/published CONTENT REVISION.
-- New revision => new item ID; no in-place edit of published content.
-- Generated tasks do NOT need practice_items rows.
-- Canonical 7 templates: select, match, clozeSelect, typing, flyReorder,
-- surgery, recording. The former audioSelect/split/trace are select/typing
-- variants, not independent template values.
-- Valid variants (select: gloss/reverseGloss/meaningClash/phoneticChoice/
-- stressChoice; typing: meaningRecall/transcription) require service validation.
-- Prompt modality (text/audio) is orthogonal to template and variant.

CREATE TABLE practice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template VARCHAR(24) NOT NULL
       CHECK (template IN ('select','match','cloze_select','typing','fly_reorder','surgery','recording')),
    variant VARCHAR(40) CHECK (variant IN ('gloss','reverse_gloss','meaning_clash','phonetic_choice','stress_choice',
       'meaning_pairs','word_pairs','single_blank','context_meaning','meaning_recall','transcription','spelling_recall','fix_spelling','scripted_pronunciation')),
    -- For independent contextual practice, non-NULL means editorially rated.
    -- NULL contextual level is not eligible for unassisted contextual verification.
    -- Curated source_content may include a prompt descriptor; resolve and validate
    -- its concrete text/audio envelope before persisting it in learning_sessions.plan.
    context_cefr_level VARCHAR(2) CHECK (context_cefr_level IN ('A1','A2','B1','B2','C1','C2')),
    source_content JSONB NOT NULL CHECK (jsonb_typeof(source_content) = 'object'),
    source_evaluation JSONB NOT NULL CHECK (jsonb_typeof(source_evaluation) = 'object'),
    status VARCHAR(16) NOT NULL DEFAULT 'draft'
       CHECK (status IN ('draft','approved','published','retired')),
    supersedes_item_id UUID REFERENCES practice_items(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Localized *instruction/clue/contextual explanation* only; authored English
-- language-learning context stays in practice_items.source_content.
CREATE TABLE practice_item_localizations (
    practice_item_id UUID NOT NULL REFERENCES practice_items(id),
    locale VARCHAR(32) NOT NULL,
    localized_content JSONB NOT NULL DEFAULT '{}'::jsonb
       CHECK (jsonb_typeof(localized_content) = 'object'),
    contextual_explain TEXT,
    editorial_state VARCHAR(16) NOT NULL DEFAULT 'draft'
       CHECK (editorial_state IN ('draft','approved')),
    approved_at TIMESTAMPTZ,
    PRIMARY KEY (practice_item_id, locale)
);
CREATE TABLE practice_item_targets (
    practice_item_id UUID NOT NULL REFERENCES practice_items(id),
    ordinal SMALLINT NOT NULL CHECK (ordinal >= 0),
    meaning_id UUID REFERENCES meanings(id),
    pronunciation_id UUID REFERENCES pronunciations(id),
    PRIMARY KEY (practice_item_id, ordinal),
    -- Both IDs may be present when a task checks Meaning and pronunciation simultaneously,
    -- e.g. select with an audio lexical prompt; service validates same Word/Type alignment.
    CHECK (meaning_id IS NOT NULL OR pronunciation_id IS NOT NULL)
);
CREATE INDEX idx_practice_items_lookup ON practice_items(template, status);
CREATE INDEX idx_practice_item_locales ON practice_item_localizations(locale, editorial_state);
CREATE INDEX idx_practice_targets_meaning ON practice_item_targets(meaning_id) WHERE meaning_id IS NOT NULL;
CREATE INDEX idx_practice_targets_pron ON practice_item_targets(pronunciation_id) WHERE pronunciation_id IS NOT NULL;

-- D. Session plans persist technical snapshots only. Issued != committed learning.
CREATE TABLE learning_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_user(id),
    mode VARCHAR(24) NOT NULL
       CHECK (mode IN ('daily','checkpoint_challenge','random_practice','weak_words_practice')),
    status VARCHAR(16) NOT NULL DEFAULT 'issued'
       CHECK (status IN ('issued','committed','expired')),
    scope_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
       CHECK (jsonb_typeof(scope_snapshot) = 'object'),
    plan_version VARCHAR(40) NOT NULL,
    policy_versions JSONB NOT NULL DEFAULT '{}'::jsonb
       CHECK (jsonb_typeof(policy_versions) = 'object'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ,
    commit_request_sha256 CHAR(64),
    commit_response JSONB,
    -- Immutable issued snapshot: tasks, targets, answer keys, Learn cards. NULL once purged.
    plan JSONB CHECK (jsonb_typeof(plan) = 'object'),
    raw_events JSONB CHECK (jsonb_typeof(raw_events) = 'array'),
    -- Durable per-task and per-target outcomes; kept after plan and raw_events are purged.
    result JSONB CHECK (jsonb_typeof(result) = 'object'),
    CHECK (expires_at > issued_at),
    CHECK (
       (status = 'committed' AND committed_at IS NOT NULL AND commit_request_sha256 IS NOT NULL AND commit_response IS NOT NULL AND result IS NOT NULL)
       OR (status <> 'committed' AND committed_at IS NULL AND commit_request_sha256 IS NULL AND commit_response IS NULL AND result IS NULL)
    ),
    CHECK (status <> 'issued' OR plan IS NOT NULL),
    UNIQUE (id, user_id)
);
CREATE INDEX idx_sessions_user_issued ON learning_sessions(user_id, issued_at DESC);
CREATE INDEX idx_sessions_expiry ON learning_sessions(expires_at) WHERE status = 'issued';

-- Azure result receipt is temporary technical staging, not learned progress.
CREATE TABLE speech_assessment_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    task_id UUID NOT NULL,
    validity VARCHAR(12) NOT NULL CHECK (validity IN ('valid','invalid')),
    passed BOOLEAN,
    accuracy_score NUMERIC(5,2),
    provider_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    FOREIGN KEY (session_id) REFERENCES learning_sessions(id),
    CHECK ((validity = 'valid' AND passed IS NOT NULL)
           OR (validity = 'invalid' AND passed IS NULL)),
    CHECK (accuracy_score IS NULL OR (accuracy_score BETWEEN 0 AND 100)),
    CHECK (expires_at > assessed_at)
);
CREATE INDEX idx_speech_receipts_expiry ON speech_assessment_receipts(expires_at);
CREATE INDEX idx_speech_receipts_task ON speech_assessment_receipts(session_id, task_id);

-- E. Committed practice and normalized evidence. No records before Finish commit.
CREATE TABLE user_meaning_progress (
    user_id UUID NOT NULL REFERENCES app_user(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    learned_at TIMESTAMPTZ NOT NULL,
    learned_session_id UUID REFERENCES learning_sessions(id),
    last_reviewed_at TIMESTAMPTZ,
    next_review_at TIMESTAMPTZ NOT NULL,
    interval_hours NUMERIC(12,3) NOT NULL CHECK (interval_hours >= 0),
    unaided_streak INTEGER NOT NULL DEFAULT 0 CHECK (unaided_streak >= 0),
    lapse_count INTEGER NOT NULL DEFAULT 0 CHECK (lapse_count >= 0),
    recognition_grace_used BOOLEAN NOT NULL DEFAULT false,
    scheduler_version VARCHAR(40) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    learned_via_topic_id UUID REFERENCES topics(id) ON DELETE SET NULL, -- topic the Meaning was first learned from
    PRIMARY KEY (user_id, meaning_id)
);
CREATE INDEX idx_progress_due ON user_meaning_progress(user_id, next_review_at);
CREATE INDEX idx_progress_learned ON user_meaning_progress(user_id, learned_at);

CREATE TABLE memory_observations (
    session_id UUID NOT NULL REFERENCES learning_sessions(id),
    user_id UUID NOT NULL REFERENCES app_user(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    signal VARCHAR(24) NOT NULL CHECK (signal IN
       ('unaided_recall','assisted_recall','failed_recall','recognition_success','failed_recognition')),
    is_primed BOOLEAN NOT NULL DEFAULT false,
    source_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb
       CHECK (jsonb_typeof(source_task_ids) = 'array'),
    observed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (session_id, meaning_id)
);
CREATE INDEX idx_memory_user_meaning ON memory_observations(user_id, meaning_id, observed_at DESC);

CREATE TABLE skill_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_user(id),
    session_id UUID NOT NULL,
    task_id UUID NOT NULL,
    target_ordinal SMALLINT NOT NULL,
    skill VARCHAR(12) NOT NULL CHECK (skill IN ('listening','speaking','reading','writing')),
    reasons JSONB NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND reasons <@ '["new_practice","hinted","revealed","retried","primed","weak_template","quality_unqualified","audio_not_played","invalid_recording","unknown"]'::jsonb),
    validity VARCHAR(12) NOT NULL CHECK (validity IN ('valid','invalid')),
    passed BOOLEAN,
    meaning_id UUID REFERENCES meanings(id),
    pronunciation_id UUID REFERENCES pronunciations(id),
    assessed_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL,
    assessment_receipt_id UUID REFERENCES speech_assessment_receipts(id),
    evaluator_version VARCHAR(40) NOT NULL,
    FOREIGN KEY (session_id, user_id) REFERENCES learning_sessions(id, user_id),
    UNIQUE (session_id, task_id, target_ordinal, skill),
    CHECK ((meaning_id IS NOT NULL) <> (pronunciation_id IS NOT NULL)),
    CHECK ((skill IN ('reading','writing') AND meaning_id IS NOT NULL)
        OR (skill IN ('listening','speaking') AND pronunciation_id IS NOT NULL)),
    CHECK ((validity = 'valid' AND passed IS NOT NULL)
        OR (validity = 'invalid' AND passed IS NULL))
);
CREATE INDEX idx_skill_meaning ON skill_evidence(user_id, skill, meaning_id, committed_at DESC)
    WHERE meaning_id IS NOT NULL;
CREATE INDEX idx_skill_pronunciation ON skill_evidence(user_id, skill, pronunciation_id, committed_at DESC)
    WHERE pronunciation_id IS NOT NULL;

-- F. Checkpoint challenge snapshots, one per N learning sessions.
CREATE TABLE checkpoint_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_user(id),
    sequence INTEGER NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'available'
       CHECK (state IN ('available','completed')),
    completed_session_id UUID REFERENCES learning_sessions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, sequence),
    CHECK ((state = 'completed' AND completed_session_id IS NOT NULL)
        OR (state = 'available' AND completed_session_id IS NULL))
);
CREATE TABLE checkpoint_challenge_meanings (
    challenge_id UUID NOT NULL REFERENCES checkpoint_challenges(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    PRIMARY KEY (challenge_id, meaning_id)
);

-- G. Challenge Map (Match Madness): recognition games over learned Meanings, never SRS or skill evidence.
CREATE TABLE challenge_chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

COMMIT;

-- Ranking & Tier v1.2: LP ledger (source of truth) and the aggregates rebuilt from it.
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
