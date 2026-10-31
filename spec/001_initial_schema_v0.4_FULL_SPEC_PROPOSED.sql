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
    learning_level VARCHAR(2) CHECK (learning_level IN ('A1','A2','B1','B2','C1','C2')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    learning_language VARCHAR(16) NOT NULL DEFAULT 'en',
    explanation_locale VARCHAR(32) NOT NULL DEFAULT 'vi-VN',
    ui_locale VARCHAR(32) NOT NULL DEFAULT 'vi-VN',
    time_zone VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    daily_new_word_goal SMALLINT NOT NULL DEFAULT 5 CHECK (daily_new_word_goal BETWEEN 1 AND 30),
    weekly_anchor_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    UNIQUE (collection_id, slug)
);
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

-- B. Canonical vocabulary data (editor may edit drafts; runtime reads published snapshots)
CREATE TABLE words (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    language VARCHAR(16) NOT NULL,
    lemma TEXT NOT NULL,
    homograph_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE word_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    word_id UUID NOT NULL REFERENCES words(id),
    part_of_speech VARCHAR(32) NOT NULL,
    UNIQUE (id, word_id)
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (meaning_id, locale)
);
CREATE TABLE example_localizations (
    example_id UUID NOT NULL REFERENCES meaning_examples(id),
    locale VARCHAR(32) NOT NULL,
    translation_text TEXT NOT NULL,
    PRIMARY KEY (example_id, locale)
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
       CHECK (template IN ('select','match','clozeSelect','typing','flyReorder','surgery','recording')),
    variant VARCHAR(40),
    -- For independent contextual practice, non-NULL means editorially rated.
    -- NULL contextual level is not eligible for unassisted contextual verification.
    -- Curated source_content may include a prompt descriptor; resolve and validate
    -- its concrete text/audio envelope before persisting a session_tasks row.
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
       CHECK (mode IN ('daily','weeklyChallenge','randomPractice','weakWordsPractice')),
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
    CHECK (expires_at > issued_at),
    CHECK (
       (status = 'committed' AND committed_at IS NOT NULL AND commit_request_sha256 IS NOT NULL AND commit_response IS NOT NULL)
       OR (status <> 'committed' AND committed_at IS NULL AND commit_request_sha256 IS NULL AND commit_response IS NULL)
    ),
    UNIQUE (id, user_id)
);
CREATE INDEX idx_sessions_user_issued ON learning_sessions(user_id, issued_at DESC);
CREATE INDEX idx_sessions_expiry ON learning_sessions(expires_at) WHERE status = 'issued';

CREATE TABLE session_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES learning_sessions(id),
    -- Globally ordered with session_learn_steps.ordinal; service ensures no overlaps.
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    phase VARCHAR(32) NOT NULL
       CHECK (phase IN ('dueReview','newPractice','weeklyChallenge','randomPractice','weakWordsPractice')),
    template VARCHAR(24) NOT NULL
       CHECK (template IN ('select','match','clozeSelect','typing','flyReorder','surgery','recording')),
    variant VARCHAR(40),
    curated_item_id UUID REFERENCES practice_items(id),
    -- Fully resolved client task; required prompt {type:text|audio,...} checked below.
    -- Template + variant-specific body/evaluation and audio delivery assessed by service.
    client_payload JSONB NOT NULL CHECK (jsonb_typeof(client_payload) = 'object'),
    -- Universal resolved prompt envelope: required for ALL templates, not just select.
    -- Content/localization/capability/asset and no-answer-leak rules live in service validators.
    CONSTRAINT session_task_prompt_shape CHECK (
        (client_payload ? 'prompt')
        AND (jsonb_typeof(client_payload->'prompt') = 'object')
        AND COALESCE((client_payload->'prompt'->>'type') IN ('text','audio'), FALSE)
        AND (
            (
                client_payload->'prompt'->>'type' = 'text'
                AND jsonb_typeof(client_payload->'prompt'->'text') = 'string'
                AND COALESCE(length(btrim(client_payload->'prompt'->>'text')) > 0, FALSE)
                AND NOT ((client_payload->'prompt') ? 'audio')
            ) OR (
                client_payload->'prompt'->>'type' = 'audio'
                AND jsonb_typeof(client_payload->'prompt'->'audio') = 'object'
                AND jsonb_typeof(client_payload->'prompt'->'audio'->'url') = 'string'
                AND COALESCE(length(btrim(client_payload->'prompt'->'audio'->>'url')) > 0, FALSE)
                AND jsonb_typeof(client_payload->'prompt'->'audio'->'locale') = 'string'
                AND COALESCE(length(btrim(client_payload->'prompt'->'audio'->>'locale')) > 0, FALSE)
                AND NOT ((client_payload->'prompt') ? 'text')
            )
        )
    ),
    server_evaluation JSONB NOT NULL CHECK (jsonb_typeof(server_evaluation) = 'object'),
    evaluator_version VARCHAR(40) NOT NULL,
    UNIQUE (session_id, ordinal),
    UNIQUE (session_id, id)
);
CREATE INDEX idx_session_tasks_session ON session_tasks(session_id);

CREATE TABLE session_task_targets (
    session_id UUID NOT NULL,
    task_id UUID NOT NULL,
    ordinal SMALLINT NOT NULL CHECK (ordinal >= 0),
    meaning_id UUID REFERENCES meanings(id),
    pronunciation_id UUID REFERENCES pronunciations(id),
    PRIMARY KEY (session_id, task_id, ordinal),
    FOREIGN KEY (session_id, task_id) REFERENCES session_tasks(session_id, id),
    -- Both IDs may be present when a task checks Meaning and pronunciation simultaneously,
    -- e.g. select with an audio lexical prompt; service validates same Word/Type alignment.
    CHECK (meaning_id IS NOT NULL OR pronunciation_id IS NOT NULL)
);
CREATE INDEX idx_session_target_meaning ON session_task_targets(meaning_id) WHERE meaning_id IS NOT NULL;

CREATE TABLE session_learn_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES learning_sessions(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    -- Globally ordered with session_tasks.ordinal; service ensures no overlaps.
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    client_card JSONB NOT NULL CHECK (jsonb_typeof(client_card) = 'object'),
    -- Must resolve to the first Meaning-cued recall task: typing OR fly.
    first_recall_task_id UUID NOT NULL,
    UNIQUE (session_id, meaning_id),
    UNIQUE (session_id, ordinal),
    FOREIGN KEY (session_id, first_recall_task_id) REFERENCES session_tasks(session_id, id)
);

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
    FOREIGN KEY (session_id, task_id) REFERENCES session_tasks(session_id, id),
    CHECK ((validity = 'valid' AND passed IS NOT NULL)
           OR (validity = 'invalid' AND passed IS NULL)),
    CHECK (accuracy_score IS NULL OR (accuracy_score BETWEEN 0 AND 100)),
    CHECK (expires_at > assessed_at)
);
CREATE INDEX idx_speech_receipts_expiry ON speech_assessment_receipts(expires_at);

-- E. Committed practice and normalized evidence. No records before Finish commit.
CREATE TABLE practice_task_results (
    session_id UUID NOT NULL,
    task_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES app_user(id),
    raw_events JSONB NOT NULL CHECK (jsonb_typeof(raw_events) = 'array'),
    normalized_result JSONB NOT NULL CHECK (jsonb_typeof(normalized_result) = 'object'),
    committed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (session_id, task_id),
    FOREIGN KEY (session_id, task_id) REFERENCES session_tasks(session_id, id)
);
CREATE INDEX idx_practice_results_user ON practice_task_results(user_id, committed_at DESC);

CREATE TABLE practice_target_results (
    session_id UUID NOT NULL,
    task_id UUID NOT NULL,
    target_ordinal SMALLINT NOT NULL,
    outcome VARCHAR(40) NOT NULL,
    first_attempt_correct BOOLEAN,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    hint_count INTEGER NOT NULL DEFAULT 0 CHECK (hint_count >= 0),
    -- Actual delivery, independent of planned prompt.type; text fallback is not Listening direct.
    delivery_mode VARCHAR(16) CHECK (delivery_mode IN ('audio','fallback','none')),
    PRIMARY KEY (session_id, task_id, target_ordinal),
    FOREIGN KEY (session_id, task_id) REFERENCES practice_task_results(session_id, task_id),
    FOREIGN KEY (session_id, task_id, target_ordinal)
        REFERENCES session_task_targets(session_id, task_id, ordinal)
);

CREATE TABLE user_meaning_progress (
    user_id UUID NOT NULL REFERENCES app_user(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    learned_at TIMESTAMPTZ NOT NULL,
    last_reviewed_at TIMESTAMPTZ,
    next_review_at TIMESTAMPTZ NOT NULL,
    interval_hours NUMERIC(12,3) NOT NULL CHECK (interval_hours >= 0),
    unaided_streak INTEGER NOT NULL DEFAULT 0 CHECK (unaided_streak >= 0),
    lapse_count INTEGER NOT NULL DEFAULT 0 CHECK (lapse_count >= 0),
    recognition_grace_used BOOLEAN NOT NULL DEFAULT false,
    scheduler_version VARCHAR(40) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (user_id, meaning_id)
);
CREATE INDEX idx_progress_due ON user_meaning_progress(user_id, next_review_at);
CREATE INDEX idx_progress_learned ON user_meaning_progress(user_id, learned_at);

CREATE TABLE memory_observations (
    session_id UUID NOT NULL REFERENCES learning_sessions(id),
    user_id UUID NOT NULL REFERENCES app_user(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    signal VARCHAR(24) NOT NULL CHECK (signal IN
       ('unaidedRecall','assistedRecall','failedRecall','recognitionSuccess','failedRecognition')),
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
    directness VARCHAR(12) NOT NULL CHECK (directness IN ('direct','supporting')),
    validity VARCHAR(12) NOT NULL CHECK (validity IN ('valid','invalid')),
    passed BOOLEAN,
    meaning_id UUID REFERENCES meanings(id),
    pronunciation_id UUID REFERENCES pronunciations(id),
    assessed_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL,
    assessment_receipt_id UUID REFERENCES speech_assessment_receipts(id),
    evaluator_version VARCHAR(40) NOT NULL,
    FOREIGN KEY (session_id, task_id, target_ordinal)
       REFERENCES practice_target_results(session_id, task_id, target_ordinal),
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

-- F. Weekly challenge snapshots by user-specific 7-day period.
CREATE TABLE weekly_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_user(id),
    cycle_start_at TIMESTAMPTZ NOT NULL,
    cycle_end_at TIMESTAMPTZ NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'available'
       CHECK (state IN ('available','completed')),
    completed_session_id UUID REFERENCES learning_sessions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, cycle_start_at),
    CHECK (cycle_end_at > cycle_start_at),
    CHECK ((state = 'completed' AND completed_session_id IS NOT NULL)
        OR (state = 'available' AND completed_session_id IS NULL))
);
CREATE TABLE weekly_challenge_meanings (
    challenge_id UUID NOT NULL REFERENCES weekly_challenges(id),
    meaning_id UUID NOT NULL REFERENCES meanings(id),
    PRIMARY KEY (challenge_id, meaning_id)
);
CREATE INDEX idx_weekly_challenges_user ON weekly_challenges(user_id, cycle_start_at DESC);

COMMIT;
