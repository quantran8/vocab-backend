-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "identity_subject" TEXT NOT NULL,
    "proficiency_level" VARCHAR(2),
    "learning_level" VARCHAR(2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "learning_language" VARCHAR(16) NOT NULL DEFAULT 'en',
    "explanation_locale" VARCHAR(32) NOT NULL DEFAULT 'vi-VN',
    "ui_locale" VARCHAR(32) NOT NULL DEFAULT 'vi-VN',
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "daily_new_word_goal" SMALLINT NOT NULL DEFAULT 5,
    "weekly_anchor_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_localizations" (
    "collection_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "collection_localizations_pkey" PRIMARY KEY ("collection_id","locale")
);

-- CreateTable
CREATE TABLE "topic_localizations" (
    "topic_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "topic_localizations_pkey" PRIMARY KEY ("topic_id","locale")
);

-- CreateTable
CREATE TABLE "user_learning_scope" (
    "user_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_learning_scope_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_active_topics" (
    "user_id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,

    CONSTRAINT "user_active_topics_pkey" PRIMARY KEY ("user_id","topic_id")
);

-- CreateTable
CREATE TABLE "words" (
    "id" UUID NOT NULL,
    "language" VARCHAR(16) NOT NULL,
    "lemma" TEXT NOT NULL,
    "homograph_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "words_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "word_types" (
    "id" UUID NOT NULL,
    "word_id" UUID NOT NULL,
    "part_of_speech" VARCHAR(32) NOT NULL,

    CONSTRAINT "word_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pronunciations" (
    "id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "accent_locale" VARCHAR(32) NOT NULL,
    "ipa" TEXT,
    "audio_asset_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pronunciations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meanings" (
    "id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "cefr_level" VARCHAR(2),
    "core_definition" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meanings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meaning_examples" (
    "id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,
    "source_text" TEXT NOT NULL,
    "target_locator" JSONB NOT NULL,

    CONSTRAINT "meaning_examples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meaning_localizations" (
    "meaning_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "meaning_text" TEXT NOT NULL,
    "definition_text" TEXT NOT NULL,
    "editorial_state" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meaning_localizations_pkey" PRIMARY KEY ("meaning_id","locale")
);

-- CreateTable
CREATE TABLE "example_localizations" (
    "example_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "translation_text" TEXT NOT NULL,

    CONSTRAINT "example_localizations_pkey" PRIMARY KEY ("example_id","locale")
);

-- CreateTable
CREATE TABLE "topic_meanings" (
    "topic_id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,
    "curated_rank" INTEGER NOT NULL,

    CONSTRAINT "topic_meanings_pkey" PRIMARY KEY ("topic_id","meaning_id")
);

-- CreateTable
CREATE TABLE "meaning_publications" (
    "id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meaning_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_meaning_publications" (
    "meaning_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "publication_id" UUID NOT NULL,
    "recalled_at" TIMESTAMPTZ(6),

    CONSTRAINT "active_meaning_publications_pkey" PRIMARY KEY ("meaning_id","locale")
);

-- CreateTable
CREATE TABLE "practice_items" (
    "id" UUID NOT NULL,
    "template" VARCHAR(24) NOT NULL,
    "variant" VARCHAR(40),
    "context_cefr_level" VARCHAR(2),
    "source_content" JSONB NOT NULL,
    "source_evaluation" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "supersedes_item_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_item_localizations" (
    "practice_item_id" UUID NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "localized_content" JSONB NOT NULL DEFAULT '{}',
    "contextual_explain" TEXT,
    "editorial_state" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "approved_at" TIMESTAMPTZ(6),

    CONSTRAINT "practice_item_localizations_pkey" PRIMARY KEY ("practice_item_id","locale")
);

-- CreateTable
CREATE TABLE "practice_item_targets" (
    "practice_item_id" UUID NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "meaning_id" UUID,
    "pronunciation_id" UUID,

    CONSTRAINT "practice_item_targets_pkey" PRIMARY KEY ("practice_item_id","ordinal")
);

-- CreateTable
CREATE TABLE "learning_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'issued',
    "scope_snapshot" JSONB NOT NULL DEFAULT '{}',
    "plan_version" VARCHAR(40) NOT NULL,
    "policy_versions" JSONB NOT NULL DEFAULT '{}',
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "committed_at" TIMESTAMPTZ(6),
    "commit_request_sha256" CHAR(64),
    "commit_response" JSONB,

    CONSTRAINT "learning_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_tasks" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "phase" VARCHAR(32) NOT NULL,
    "template" VARCHAR(24) NOT NULL,
    "variant" VARCHAR(40),
    "curated_item_id" UUID,
    "client_payload" JSONB NOT NULL,
    "server_evaluation" JSONB NOT NULL,
    "evaluator_version" VARCHAR(40) NOT NULL,

    CONSTRAINT "session_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_task_targets" (
    "session_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "meaning_id" UUID,
    "pronunciation_id" UUID,

    CONSTRAINT "session_task_targets_pkey" PRIMARY KEY ("session_id","task_id","ordinal")
);

-- CreateTable
CREATE TABLE "session_learn_steps" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "client_card" JSONB NOT NULL,
    "first_recall_task_id" UUID NOT NULL,

    CONSTRAINT "session_learn_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "speech_assessment_receipts" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "validity" VARCHAR(12) NOT NULL,
    "passed" BOOLEAN,
    "accuracy_score" DECIMAL(5,2),
    "provider_meta" JSONB NOT NULL DEFAULT '{}',
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "speech_assessment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_task_results" (
    "session_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "raw_events" JSONB NOT NULL,
    "normalized_result" JSONB NOT NULL,
    "committed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practice_task_results_pkey" PRIMARY KEY ("session_id","task_id")
);

-- CreateTable
CREATE TABLE "practice_target_results" (
    "session_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "target_ordinal" SMALLINT NOT NULL,
    "outcome" VARCHAR(40) NOT NULL,
    "first_attempt_correct" BOOLEAN,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "hint_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_mode" VARCHAR(16),

    CONSTRAINT "practice_target_results_pkey" PRIMARY KEY ("session_id","task_id","target_ordinal")
);

-- CreateTable
CREATE TABLE "user_meaning_progress" (
    "user_id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,
    "learned_at" TIMESTAMPTZ(6) NOT NULL,
    "last_reviewed_at" TIMESTAMPTZ(6),
    "next_review_at" TIMESTAMPTZ(6) NOT NULL,
    "interval_hours" DECIMAL(12,3) NOT NULL,
    "unaided_streak" INTEGER NOT NULL DEFAULT 0,
    "lapse_count" INTEGER NOT NULL DEFAULT 0,
    "recognition_grace_used" BOOLEAN NOT NULL DEFAULT false,
    "scheduler_version" VARCHAR(40) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_meaning_progress_pkey" PRIMARY KEY ("user_id","meaning_id")
);

-- CreateTable
CREATE TABLE "memory_observations" (
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,
    "signal" VARCHAR(24) NOT NULL,
    "is_primed" BOOLEAN NOT NULL DEFAULT false,
    "source_task_ids" JSONB NOT NULL DEFAULT '[]',
    "observed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memory_observations_pkey" PRIMARY KEY ("session_id","meaning_id")
);

-- CreateTable
CREATE TABLE "skill_evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "target_ordinal" SMALLINT NOT NULL,
    "skill" VARCHAR(12) NOT NULL,
    "directness" VARCHAR(12) NOT NULL,
    "validity" VARCHAR(12) NOT NULL,
    "passed" BOOLEAN,
    "meaning_id" UUID,
    "pronunciation_id" UUID,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,
    "committed_at" TIMESTAMPTZ(6) NOT NULL,
    "assessment_receipt_id" UUID,
    "evaluator_version" VARCHAR(40) NOT NULL,

    CONSTRAINT "skill_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "cycle_start_at" TIMESTAMPTZ(6) NOT NULL,
    "cycle_end_at" TIMESTAMPTZ(6) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'available',
    "completed_session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_challenge_meanings" (
    "challenge_id" UUID NOT NULL,
    "meaning_id" UUID NOT NULL,

    CONSTRAINT "weekly_challenge_meanings_pkey" PRIMARY KEY ("challenge_id","meaning_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_identity_subject_key" ON "app_user"("identity_subject");

-- CreateIndex
CREATE UNIQUE INDEX "collections_slug_key" ON "collections"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "topics_collection_id_slug_key" ON "topics"("collection_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "word_types_id_word_id_key" ON "word_types"("id", "word_id");

-- CreateIndex
CREATE UNIQUE INDEX "pronunciations_type_id_accent_locale_key" ON "pronunciations"("type_id", "accent_locale");

-- CreateIndex
CREATE UNIQUE INDEX "topic_meanings_topic_id_curated_rank_key" ON "topic_meanings"("topic_id", "curated_rank");

-- CreateIndex
CREATE UNIQUE INDEX "meaning_publications_meaning_id_locale_revision_key" ON "meaning_publications"("meaning_id", "locale", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "meaning_publications_id_meaning_id_locale_key" ON "meaning_publications"("id", "meaning_id", "locale");

-- CreateIndex
CREATE INDEX "idx_practice_items_lookup" ON "practice_items"("template", "status");

-- CreateIndex
CREATE INDEX "idx_practice_item_locales" ON "practice_item_localizations"("locale", "editorial_state");

-- CreateIndex
CREATE INDEX "idx_sessions_user_issued" ON "learning_sessions"("user_id", "issued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "learning_sessions_id_user_id_key" ON "learning_sessions"("id", "user_id");

-- CreateIndex
CREATE INDEX "idx_session_tasks_session" ON "session_tasks"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_tasks_session_id_ordinal_key" ON "session_tasks"("session_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "session_tasks_session_id_id_key" ON "session_tasks"("session_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "session_learn_steps_session_id_meaning_id_key" ON "session_learn_steps"("session_id", "meaning_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_learn_steps_session_id_ordinal_key" ON "session_learn_steps"("session_id", "ordinal");

-- CreateIndex
CREATE INDEX "idx_speech_receipts_expiry" ON "speech_assessment_receipts"("expires_at");

-- CreateIndex
CREATE INDEX "idx_practice_results_user" ON "practice_task_results"("user_id", "committed_at" DESC);

-- CreateIndex
CREATE INDEX "idx_progress_due" ON "user_meaning_progress"("user_id", "next_review_at");

-- CreateIndex
CREATE INDEX "idx_progress_learned" ON "user_meaning_progress"("user_id", "learned_at");

-- CreateIndex
CREATE INDEX "idx_memory_user_meaning" ON "memory_observations"("user_id", "meaning_id", "observed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "skill_evidence_session_id_task_id_target_ordinal_skill_key" ON "skill_evidence"("session_id", "task_id", "target_ordinal", "skill");

-- CreateIndex
CREATE INDEX "idx_weekly_challenges_user" ON "weekly_challenges"("user_id", "cycle_start_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "weekly_challenges_user_id_cycle_start_at_key" ON "weekly_challenges"("user_id", "cycle_start_at");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "collection_localizations" ADD CONSTRAINT "collection_localizations_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "topic_localizations" ADD CONSTRAINT "topic_localizations_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_learning_scope" ADD CONSTRAINT "user_learning_scope_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_learning_scope" ADD CONSTRAINT "user_learning_scope_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_active_topics" ADD CONSTRAINT "user_active_topics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_active_topics" ADD CONSTRAINT "user_active_topics_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "word_types" ADD CONSTRAINT "word_types_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "words"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pronunciations" ADD CONSTRAINT "pronunciations_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "word_types"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meanings" ADD CONSTRAINT "meanings_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "word_types"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meaning_examples" ADD CONSTRAINT "meaning_examples_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meaning_localizations" ADD CONSTRAINT "meaning_localizations_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "example_localizations" ADD CONSTRAINT "example_localizations_example_id_fkey" FOREIGN KEY ("example_id") REFERENCES "meaning_examples"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "topic_meanings" ADD CONSTRAINT "topic_meanings_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "topic_meanings" ADD CONSTRAINT "topic_meanings_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meaning_publications" ADD CONSTRAINT "meaning_publications_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "active_meaning_publications" ADD CONSTRAINT "active_meaning_publications_publication_id_meaning_id_loca_fkey" FOREIGN KEY ("publication_id", "meaning_id", "locale") REFERENCES "meaning_publications"("id", "meaning_id", "locale") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_items" ADD CONSTRAINT "practice_items_supersedes_item_id_fkey" FOREIGN KEY ("supersedes_item_id") REFERENCES "practice_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_item_localizations" ADD CONSTRAINT "practice_item_localizations_practice_item_id_fkey" FOREIGN KEY ("practice_item_id") REFERENCES "practice_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_item_targets" ADD CONSTRAINT "practice_item_targets_practice_item_id_fkey" FOREIGN KEY ("practice_item_id") REFERENCES "practice_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_item_targets" ADD CONSTRAINT "practice_item_targets_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_item_targets" ADD CONSTRAINT "practice_item_targets_pronunciation_id_fkey" FOREIGN KEY ("pronunciation_id") REFERENCES "pronunciations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_tasks" ADD CONSTRAINT "session_tasks_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "learning_sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_tasks" ADD CONSTRAINT "session_tasks_curated_item_id_fkey" FOREIGN KEY ("curated_item_id") REFERENCES "practice_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_task_targets" ADD CONSTRAINT "session_task_targets_session_id_task_id_fkey" FOREIGN KEY ("session_id", "task_id") REFERENCES "session_tasks"("session_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_task_targets" ADD CONSTRAINT "session_task_targets_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_task_targets" ADD CONSTRAINT "session_task_targets_pronunciation_id_fkey" FOREIGN KEY ("pronunciation_id") REFERENCES "pronunciations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_learn_steps" ADD CONSTRAINT "session_learn_steps_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "learning_sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_learn_steps" ADD CONSTRAINT "session_learn_steps_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "session_learn_steps" ADD CONSTRAINT "session_learn_steps_session_id_first_recall_task_id_fkey" FOREIGN KEY ("session_id", "first_recall_task_id") REFERENCES "session_tasks"("session_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "speech_assessment_receipts" ADD CONSTRAINT "speech_assessment_receipts_session_id_task_id_fkey" FOREIGN KEY ("session_id", "task_id") REFERENCES "session_tasks"("session_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_task_results" ADD CONSTRAINT "practice_task_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_task_results" ADD CONSTRAINT "practice_task_results_session_id_task_id_fkey" FOREIGN KEY ("session_id", "task_id") REFERENCES "session_tasks"("session_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_target_results" ADD CONSTRAINT "practice_target_results_session_id_task_id_fkey" FOREIGN KEY ("session_id", "task_id") REFERENCES "practice_task_results"("session_id", "task_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "practice_target_results" ADD CONSTRAINT "practice_target_results_session_id_task_id_target_ordinal_fkey" FOREIGN KEY ("session_id", "task_id", "target_ordinal") REFERENCES "session_task_targets"("session_id", "task_id", "ordinal") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_meaning_progress" ADD CONSTRAINT "user_meaning_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_meaning_progress" ADD CONSTRAINT "user_meaning_progress_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "learning_sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_pronunciation_id_fkey" FOREIGN KEY ("pronunciation_id") REFERENCES "pronunciations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_assessment_receipt_id_fkey" FOREIGN KEY ("assessment_receipt_id") REFERENCES "speech_assessment_receipts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_session_id_task_id_target_ordinal_fkey" FOREIGN KEY ("session_id", "task_id", "target_ordinal") REFERENCES "practice_target_results"("session_id", "task_id", "target_ordinal") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_challenges" ADD CONSTRAINT "weekly_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_challenges" ADD CONSTRAINT "weekly_challenges_completed_session_id_fkey" FOREIGN KEY ("completed_session_id") REFERENCES "learning_sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_challenge_meanings" ADD CONSTRAINT "weekly_challenge_meanings_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "weekly_challenges"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_challenge_meanings" ADD CONSTRAINT "weekly_challenge_meanings_meaning_id_fkey" FOREIGN KEY ("meaning_id") REFERENCES "meanings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Not expressible in Prisma schema: CHECK constraints
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_proficiency_level_check" CHECK ("proficiency_level" IN ('A1','A2','B1','B2','C1','C2')),
  ADD CONSTRAINT "app_user_learning_level_check" CHECK ("learning_level" IN ('A1','A2','B1','B2','C1','C2'));
ALTER TABLE "user_settings"
  ADD CONSTRAINT "user_settings_daily_new_word_goal_check" CHECK ("daily_new_word_goal" BETWEEN 1 AND 30);
ALTER TABLE "collections"
  ADD CONSTRAINT "collections_status_check" CHECK ("status" IN ('draft','published','archived'));
ALTER TABLE "topics"
  ADD CONSTRAINT "topics_status_check" CHECK ("status" IN ('draft','published','archived'));
ALTER TABLE "pronunciations"
  ADD CONSTRAINT "pronunciations_ipa_check" CHECK ("ipa" IS NULL OR length(btrim("ipa")) > 0);
ALTER TABLE "meanings"
  ADD CONSTRAINT "meanings_cefr_level_check" CHECK ("cefr_level" IN ('A1','A2','B1','B2','C1','C2'));
ALTER TABLE "meaning_examples"
  ADD CONSTRAINT "meaning_examples_target_locator_check" CHECK (jsonb_typeof("target_locator") = 'object');
ALTER TABLE "meaning_localizations"
  ADD CONSTRAINT "meaning_localizations_editorial_state_check" CHECK ("editorial_state" IN ('draft','approved'));
ALTER TABLE "topic_meanings"
  ADD CONSTRAINT "topic_meanings_curated_rank_check" CHECK ("curated_rank" > 0);
ALTER TABLE "meaning_publications"
  ADD CONSTRAINT "meaning_publications_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "meaning_publications_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object');
ALTER TABLE "practice_items"
  ADD CONSTRAINT "practice_items_template_check" CHECK ("template" IN ('select','match','clozeSelect','typing','flyReorder','surgery','recording')),
  ADD CONSTRAINT "practice_items_context_cefr_level_check" CHECK ("context_cefr_level" IN ('A1','A2','B1','B2','C1','C2')),
  ADD CONSTRAINT "practice_items_source_content_check" CHECK (jsonb_typeof("source_content") = 'object'),
  ADD CONSTRAINT "practice_items_source_evaluation_check" CHECK (jsonb_typeof("source_evaluation") = 'object'),
  ADD CONSTRAINT "practice_items_status_check" CHECK ("status" IN ('draft','approved','published','retired'));
ALTER TABLE "practice_item_localizations"
  ADD CONSTRAINT "practice_item_localizations_localized_content_check" CHECK (jsonb_typeof("localized_content") = 'object'),
  ADD CONSTRAINT "practice_item_localizations_editorial_state_check" CHECK ("editorial_state" IN ('draft','approved'));
ALTER TABLE "practice_item_targets"
  ADD CONSTRAINT "practice_item_targets_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "practice_item_targets_check" CHECK ("meaning_id" IS NOT NULL OR "pronunciation_id" IS NOT NULL);
ALTER TABLE "learning_sessions"
  ADD CONSTRAINT "learning_sessions_mode_check" CHECK ("mode" IN ('daily','weeklyChallenge','randomPractice','weakWordsPractice')),
  ADD CONSTRAINT "learning_sessions_status_check" CHECK ("status" IN ('issued','committed','expired')),
  ADD CONSTRAINT "learning_sessions_scope_snapshot_check" CHECK (jsonb_typeof("scope_snapshot") = 'object'),
  ADD CONSTRAINT "learning_sessions_policy_versions_check" CHECK (jsonb_typeof("policy_versions") = 'object'),
  ADD CONSTRAINT "learning_sessions_check" CHECK ("expires_at" > "issued_at"),
  ADD CONSTRAINT "learning_sessions_check1" CHECK (
    ("status" = 'committed' AND "committed_at" IS NOT NULL AND "commit_request_sha256" IS NOT NULL AND "commit_response" IS NOT NULL)
    OR ("status" <> 'committed' AND "committed_at" IS NULL AND "commit_request_sha256" IS NULL AND "commit_response" IS NULL)
  );
ALTER TABLE "session_tasks"
  ADD CONSTRAINT "session_tasks_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "session_tasks_phase_check" CHECK ("phase" IN ('dueReview','newPractice','weeklyChallenge','randomPractice','weakWordsPractice')),
  ADD CONSTRAINT "session_tasks_template_check" CHECK ("template" IN ('select','match','clozeSelect','typing','flyReorder','surgery','recording')),
  ADD CONSTRAINT "session_tasks_client_payload_check" CHECK (jsonb_typeof("client_payload") = 'object'),
  ADD CONSTRAINT "session_tasks_server_evaluation_check" CHECK (jsonb_typeof("server_evaluation") = 'object'),
  ADD CONSTRAINT "session_task_prompt_shape" CHECK (
    ("client_payload" ? 'prompt')
    AND (jsonb_typeof("client_payload"->'prompt') = 'object')
    AND COALESCE(("client_payload"->'prompt'->>'type') IN ('text','audio'), FALSE)
    AND (
      (
        "client_payload"->'prompt'->>'type' = 'text'
        AND jsonb_typeof("client_payload"->'prompt'->'text') = 'string'
        AND COALESCE(length(btrim("client_payload"->'prompt'->>'text')) > 0, FALSE)
        AND NOT (("client_payload"->'prompt') ? 'audio')
      ) OR (
        "client_payload"->'prompt'->>'type' = 'audio'
        AND jsonb_typeof("client_payload"->'prompt'->'audio') = 'object'
        AND jsonb_typeof("client_payload"->'prompt'->'audio'->'url') = 'string'
        AND COALESCE(length(btrim("client_payload"->'prompt'->'audio'->>'url')) > 0, FALSE)
        AND jsonb_typeof("client_payload"->'prompt'->'audio'->'locale') = 'string'
        AND COALESCE(length(btrim("client_payload"->'prompt'->'audio'->>'locale')) > 0, FALSE)
        AND NOT (("client_payload"->'prompt') ? 'text')
      )
    )
  );
ALTER TABLE "session_task_targets"
  ADD CONSTRAINT "session_task_targets_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "session_task_targets_check" CHECK ("meaning_id" IS NOT NULL OR "pronunciation_id" IS NOT NULL);
ALTER TABLE "session_learn_steps"
  ADD CONSTRAINT "session_learn_steps_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "session_learn_steps_client_card_check" CHECK (jsonb_typeof("client_card") = 'object');
ALTER TABLE "speech_assessment_receipts"
  ADD CONSTRAINT "speech_assessment_receipts_validity_check" CHECK ("validity" IN ('valid','invalid')),
  ADD CONSTRAINT "speech_assessment_receipts_check" CHECK (("validity" = 'valid' AND "passed" IS NOT NULL) OR ("validity" = 'invalid' AND "passed" IS NULL)),
  ADD CONSTRAINT "speech_assessment_receipts_accuracy_score_check" CHECK ("accuracy_score" IS NULL OR ("accuracy_score" BETWEEN 0 AND 100)),
  ADD CONSTRAINT "speech_assessment_receipts_check1" CHECK ("expires_at" > "assessed_at");
ALTER TABLE "practice_task_results"
  ADD CONSTRAINT "practice_task_results_raw_events_check" CHECK (jsonb_typeof("raw_events") = 'array'),
  ADD CONSTRAINT "practice_task_results_normalized_result_check" CHECK (jsonb_typeof("normalized_result") = 'object');
ALTER TABLE "practice_target_results"
  ADD CONSTRAINT "practice_target_results_attempt_count_check" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "practice_target_results_hint_count_check" CHECK ("hint_count" >= 0),
  ADD CONSTRAINT "practice_target_results_delivery_mode_check" CHECK ("delivery_mode" IN ('audio','fallback','none'));
ALTER TABLE "user_meaning_progress"
  ADD CONSTRAINT "user_meaning_progress_interval_hours_check" CHECK ("interval_hours" >= 0),
  ADD CONSTRAINT "user_meaning_progress_unaided_streak_check" CHECK ("unaided_streak" >= 0),
  ADD CONSTRAINT "user_meaning_progress_lapse_count_check" CHECK ("lapse_count" >= 0),
  ADD CONSTRAINT "user_meaning_progress_version_check" CHECK ("version" > 0);
ALTER TABLE "memory_observations"
  ADD CONSTRAINT "memory_observations_signal_check" CHECK ("signal" IN ('unaidedRecall','assistedRecall','failedRecall','recognitionSuccess','failedRecognition')),
  ADD CONSTRAINT "memory_observations_source_task_ids_check" CHECK (jsonb_typeof("source_task_ids") = 'array');
ALTER TABLE "skill_evidence"
  ADD CONSTRAINT "skill_evidence_skill_check" CHECK ("skill" IN ('listening','speaking','reading','writing')),
  ADD CONSTRAINT "skill_evidence_directness_check" CHECK ("directness" IN ('direct','supporting')),
  ADD CONSTRAINT "skill_evidence_validity_check" CHECK ("validity" IN ('valid','invalid')),
  ADD CONSTRAINT "skill_evidence_check" CHECK (("meaning_id" IS NOT NULL) <> ("pronunciation_id" IS NOT NULL)),
  ADD CONSTRAINT "skill_evidence_check1" CHECK (("skill" IN ('reading','writing') AND "meaning_id" IS NOT NULL) OR ("skill" IN ('listening','speaking') AND "pronunciation_id" IS NOT NULL)),
  ADD CONSTRAINT "skill_evidence_check2" CHECK (("validity" = 'valid' AND "passed" IS NOT NULL) OR ("validity" = 'invalid' AND "passed" IS NULL));
ALTER TABLE "weekly_challenges"
  ADD CONSTRAINT "weekly_challenges_state_check" CHECK ("state" IN ('available','completed')),
  ADD CONSTRAINT "weekly_challenges_check" CHECK ("cycle_end_at" > "cycle_start_at"),
  ADD CONSTRAINT "weekly_challenges_check1" CHECK (("state" = 'completed' AND "completed_session_id" IS NOT NULL) OR ("state" = 'available' AND "completed_session_id" IS NULL));

-- Not expressible in Prisma schema: partial indexes
CREATE INDEX "idx_practice_targets_meaning" ON "practice_item_targets"("meaning_id") WHERE "meaning_id" IS NOT NULL;
CREATE INDEX "idx_practice_targets_pron" ON "practice_item_targets"("pronunciation_id") WHERE "pronunciation_id" IS NOT NULL;
CREATE INDEX "idx_sessions_expiry" ON "learning_sessions"("expires_at") WHERE "status" = 'issued';
CREATE INDEX "idx_session_target_meaning" ON "session_task_targets"("meaning_id") WHERE "meaning_id" IS NOT NULL;
CREATE INDEX "idx_skill_meaning" ON "skill_evidence"("user_id", "skill", "meaning_id", "committed_at" DESC) WHERE "meaning_id" IS NOT NULL;
CREATE INDEX "idx_skill_pronunciation" ON "skill_evidence"("user_id", "skill", "pronunciation_id", "committed_at" DESC) WHERE "pronunciation_id" IS NOT NULL;
