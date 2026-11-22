# Graph Report - backend  (2026-11-22)

## Corpus Check
- 243 files · ~193,017 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 6 file(s) not represented in the graph (top: (none) 4, .example 1, .caddy 1)

## Summary
- 2985 nodes · 8237 edges · 154 communities (115 shown, 39 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 480 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Spec Schema DDL
- Admin Words Module
- Auth Provider & Service
- Initial DB Migration
- Domain Constants & Speaking Progress
- Controllers & Current User
- Seeds & Repo Schema Usage
- Drizzle Schema & Ranking
- Drizzle DB Core
- Time Helpers & LP Awards
- App Module & Zod Pipes
- Admin Catalog Module
- Commit Service & Evaluator
- Integration Test Suite
- Admin Request Schemas
- Admin Meaning Approval
- Plan Builder
- Task Answer Evaluators
- Challenge Run Service
- Admin Content Controllers
- Policy & Tier Config
- API Errors
- Dev Dependencies
- Match Madness Board
- Identity Module
- Registry Prune Workflow
- Ranking Service
- Review Load Module
- Result Summary
- Admin Practice Items
- Deploy Env Secrets
- Memory Reducer & Evidence
- Test Harness & Providers
- Custom Words Repository
- Logs Workflow
- Task Types & Curated Items
- Journey View
- TypeScript Config
- Challenge Chapter Content
- FSRS Scheduler
- Username Generation
- Admin Ranking Moderation
- Anthropic Lexical Provider
- Placement Module
- JWT Guard & Provisioning
- Azure Speech Provider
- Custom Words Service
- Review Scope SQL (R/C/B)
- Weak Scope & Commit Repo
- Admin Audio Controller
- Implementation Decisions
- Spec: Resolver & Planner
- Placement Domain
- Admin Tests & Collections
- Admin Audio Generation
- Maintenance Cron
- Planner Target Selection
- Docker Compose Prod
- Ranking Tier Migration
- Runtime Dependencies
- Planner Snapshots & Locale
- Learn Home Review Load
- Spec: Templates & Learning Cycle
- Pronunciation Audio
- Spec: Atomic Commit
- Custom Word Lookup/Add
- Frontend: Onboarding & LP
- Challenge Map Domain
- Challenge Map State
- Progress Word Views
- Frontend: Results & Speaking
- Task Validation
- HTTP Adapter & CORS
- Admin Examples & Patch
- SigV4 Audio Storage
- App Config & TTS
- Interleaver
- Rules: Schema Deviations
- Test DB Setup
- Custom Word Text
- Deployment Docs
- Custom Words Migration
- Challenge Map Migration
- Package Scripts
- Spec: REST API & Speech
- Meaning Publication
- Resolver Spec Tests
- Planner Service
- Rules: Constants & scopeEvents
- Learner Pool Isolation
- README Concepts
- Deploy Workflow Jobs
- Docker Build Args
- Speech Service
- pnpm Workspace
- Catalog Repository
- Custom Word Overrides API
- Session Commit Controller
- Speech Controller
- Review Scope Decisions
- Ranking & LP Decisions
- Speaking Decisions
- Frontend: Session Plan Modes
- Frontend: Learn Home & Map
- Deploy Triggers
- Canonical Hashing
- Spec: Session Tables
- Challenge API Schemas
- Journey Controller
- Frontend: Task Events
- Frontend: Commit & Runs
- Speaking Progress Migration
- Spec: SRS Policy
- Spec: Superseded Skills
- Session Planner Controller
- Session History Migration
- Deploy Steps
- Deploy Job
- Custom Words Worker
- Frontend: Daily & Known Check
- Nest CLI Config
- Build Job
- Vitest Setup
- API Exception Filter
- Review Pause Migration
- ESLint No-Query-In-Loop
- DB Pool Shutdown
- DB Module
- Rules: Drizzle Pitfalls
- Rules: Timestamp Pitfalls
- Deleted Identities Migration

## God Nodes (most connected - your core abstractions)
1. `ApiError` - 151 edges
2. `@nestjs/common` - 87 edges
3. `AuthUser` - 74 edges
4. `CurrentUser` - 65 edges
5. `Db` - 58 edges
6. `drizzle-orm` - 52 edges
7. `POLICY` - 52 edges
8. `AppConfig` - 44 edges
9. `Tx` - 44 edges
10. `Clock` - 39 edges

## Surprising Connections (you probably didn't know these)
- `Deviations from the spec SQL` --semantically_similar_to--> `App-generated UUID v7 ids (newId)`  [INFERRED] [semantically similar]
  docs/DECISIONS.md → CLAUDE.md
- `DB session TimeZone must be UTC` --semantically_similar_to--> `Deviations from the spec SQL`  [INFERRED] [semantically similar]
  README.md → docs/DECISIONS.md
- `Custom words: approval` --semantically_similar_to--> `Learner pool isolation (non-negotiable)`  [INFERRED] [semantically similar]
  docs/DECISIONS.md → CLAUDE.md
- `Review source D2 (all learned minus paused)` --semantically_similar_to--> `reviewableSql (all learned Meanings minus paused collections)`  [INFERRED] [semantically similar]
  docs/DECISIONS.md → CLAUDE.md
- `needPractice cost (before inside writeCommit)` --semantically_similar_to--> `scopeEvents computed inside writeCommit`  [INFERRED] [semantically similar]
  docs/DECISIONS.md → CLAUDE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **New Meaning mandatory template groups** — spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_tpl_select, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_tpl_typing, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_tpl_flyreorder, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_tpl_recording, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_new_learning_cycle [EXTRACTED 1.00]
- **Finish commit flow (replay, reduce, persist)** — spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_ep_commit, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_atomic_commit, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_evaluators, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_result_reducer, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_t_user_meaning_progress, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_t_memory_observations [EXTRACTED 1.00]
- **Immutable snapshot pattern** — spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_t_meaning_publications, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_t_learning_sessions, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_t_practice_items, spec_vocab_flow_backend_full_spec_v0_4_2026_10_30_publication_rules [INFERRED 0.85]
- **Learning session lifecycle (plan, run tasks, commit, summary)** — docs_frontend_flow_session_plan, docs_frontend_flow_task_structure, docs_frontend_flow_event_rules, docs_frontend_flow_session_commit, docs_frontend_flow_result_summary [EXTRACTED 1.00]
- **Speaking assessment pipeline** — docs_frontend_flow_tpl_recording, docs_frontend_flow_recording_assess, docs_frontend_flow_on_device_transcription, docs_frontend_flow_speaking_status, docs_frontend_flow_summary_speaking [INFERRED 0.85]
- **LP, Tier and Ranking gamification** — docs_frontend_flow_lp, docs_frontend_flow_tier, docs_frontend_flow_ranking, docs_frontend_flow_ranking_profile [EXTRACTED 1.00]
- **Learner content isolation (overrides, owned meanings, admin approval)** — claude_learner_pool_isolation, claude_user_meaning_overrides, claude_meanings_owner_user_id, docs_decisions_custom_words_approval, docs_decisions_custom_words_review, docs_decisions_private_meanings_admin [EXTRACTED 1.00]
- **Speaking measured outside FSRS** — docs_decisions_speaking_progress, docs_decisions_azure_speech_track, docs_decisions_on_device_track, docs_decisions_speaking_practice_mode, docs_decisions_speaking_never_feeds_fsrs [EXTRACTED 1.00]
- **Deploy path through money-space edge** — deployment_ci_pipeline, deployment_ocir_repository, deployment_caddy_route, deployment_edge_network, deployment_money_space [EXTRACTED 1.00]

## Communities (154 total, 39 thin omitted)

### Community 0 - "Spec Schema DDL"
Cohesion: 0.06
Nodes (77): active_meaning_publications, app_user, challenge_chapter_meanings, challenge_chapter_meanings_core_key, challenge_chapter_meanings_meaning_key, challenge_chapter_meanings_slot_key, challenge_chapters, challenge_level_progress (+69 more)

### Community 1 - "Admin Words Module"
Cohesion: 0.05
Nodes (7): mapPgErrors(), MeaningBody, PatchPronunciation, WordTypeBody, AdminWordsRepository, purgeMeanings(), AdminWordsService

### Community 2 - "Auth Provider & Service"
Cohesion: 0.06
Nodes (26): AdminUsersService, AuthController, changePasswordSchema, credentialsSchema, email, idTokenSchema, loginName, loginSchema (+18 more)

### Community 3 - "Initial DB Migration"
Cohesion: 0.06
Nodes (67): "active_meaning_publications", "app_user", app_user_identity_subject_key, "collection_localizations", "collections", collections_slug_key, "example_localizations", idx_memory_user_meaning (+59 more)

### Community 4 - "Domain Constants & Speaking Progress"
Cohesion: 0.05
Nodes (64): AVATAR_KEY, ChallengeChapterState, ChallengeNextAction, ChallengeNextChapterState, ChallengeUnlock, ContentStatus, EditorialState, EVENT_SCHEMA_VERSION (+56 more)

### Community 5 - "Controllers & Current User"
Cohesion: 0.06
Nodes (10): AuthUser, CurrentUser, ChallengeController, CustomWordsController, ProgressController, ProgressService, MeRankingController, RankingController (+2 more)

### Community 6 - "Seeds & Repo Schema Usage"
Cohesion: 0.08
Nodes (45): @nestjs/core, reflect-metadata, uuidv7, AppModule, DEFAULT_ACCENT, DEFAULT_LOCALE, EDITORIAL_STATE, LEARNING_LANGUAGE (+37 more)

### Community 7 - "Drizzle Schema & Ranking"
Cohesion: 0.06
Nodes (53): AvatarKey, ReportReason, appUsers, appUsersRelations, challengeChapterMeanings, challengeChapters, challengeLevelProgress, challengeRuns (+45 more)

### Community 8 - "Drizzle DB Core"
Cohesion: 0.07
Nodes (31): drizzle-orm, CHECKPOINT_STATE, CONTENT_STATUS, MEANING_ORIGIN, NewWordOverrideMode, PERSONAL_COLLECTION_SLUG, DB, Db (+23 more)

### Community 9 - "Time Helpers & LP Awards"
Cohesion: 0.06
Nodes (43): CONTENT_PROVENANCE, ContentProvenance, LP_AWARD_TYPE, LpAwardType, SESSION_MODE, SessionMode, TaskPhase, TIER_UNLOCK_SOURCE (+35 more)

### Community 10 - "App Module & Zod Pipes"
Cohesion: 0.08
Nodes (25): @nestjs/common, @nestjs/schedule, zod, FullAdminOnly(), IS_ADMIN, IS_FULL_ADMIN, IS_PUBLIC, Public() (+17 more)

### Community 11 - "Admin Catalog Module"
Cohesion: 0.07
Nodes (11): CatalogLocale, CreateCollection, CreateTopic, PatchCollection, PatchTopic, PronunciationBody, SetRole, TopicMeaningIds (+3 more)

### Community 12 - "Commit Service & Evaluator"
Cohesion: 0.07
Nodes (37): DELIVERY_MODE, DeliveryMode, EVENT_ACTION, TASK_PHASE, reviewResult(), TargetOutcome, base, CommitBody (+29 more)

### Community 13 - "Integration Test Suite"
Cohesion: 0.08
Nodes (47): VALIDITY, checkpointChallengeMeanings, customWordUsage, deletedIdentities, lexicalDrafts, buildAccount(), curated(), Json (+39 more)

### Community 14 - "Admin Request Schemas"
Cohesion: 0.07
Nodes (44): AI_MEANING_SCOPE, ASSIGNABLE_ROLES, CEFR_LEVELS, PARTS_OF_SPEECH, uuid, aiMeaningsSchema, audioIds, catalogEntry (+36 more)

### Community 15 - "Admin Meaning Approval"
Cohesion: 0.09
Nodes (7): AiMeaningScope, AdminController, CreateWord, ItemLocale, MeaningLocale, AdminRepository, AdminService

### Community 16 - "Plan Builder"
Cohesion: 0.16
Nodes (39): PromptType, evidenceClassOf(), assemble(), audioPrompt(), AZURE_ASSESSMENT, buildFlyReorder(), buildMatch(), buildOptions() (+31 more)

### Community 17 - "Task Answer Evaluators"
Cohesion: 0.10
Nodes (33): applyEdits(), assertMonotonic(), attemptLimit(), AttemptTally, ClientBody, evaluateFlyReorder(), EvaluateInput, evaluateMatch() (+25 more)

### Community 18 - "Challenge Run Service"
Cohesion: 0.14
Nodes (7): Tx, Slot, RunResult, ChallengeRepository, ChallengeRunService, runView(), challenge()

### Community 19 - "Admin Content Controllers"
Cohesion: 0.09
Nodes (12): AdminOnly(), AdminCatalogController, AdminPracticeItemsController, AdminUsersController, AdminWordsController, listCatalogSchema, ListItems, ListMeanings (+4 more)

### Community 20 - "Policy & Tier Config"
Cohesion: 0.11
Nodes (26): LEADERBOARD_VIEW, PRONUNCIATION_BAND, RANKING_POSITION_KIND, REPORT_REASONS, SYLLABLE_BAND, TIER_KEY, TierKey, POLICY (+18 more)

### Community 21 - "API Errors"
Cohesion: 0.11
Nodes (18): ITEM_STATUS, TEMPLATE_VARIANTS, ERROR, ErrorCode, ApiError, STATUS_TO_CODE, codeOf(), IN_USE (+10 more)

### Community 22 - "Dev Dependencies"
Cohesion: 0.08
Nodes (31): devDependencies, drizzle-kit@0.31.11, eslint@^10.14.0, @nestjs/cli@^12.0.11, @nestjs/testing@^12.3.2, supertest@^7.3.1, @swc/core@^1.16.20, ts-fsrs@^6.0.0 (+23 more)

### Community 23 - "Match Madness Board"
Cohesion: 0.11
Nodes (24): ChallengeEndedReason, ChallengeOutcome, TILE_SIDE, TileSide, Board, buildPlan(), buildQueue(), columnOrder() (+16 more)

### Community 24 - "Identity Module"
Cohesion: 0.11
Nodes (9): IdentityController, cefr, levelsSchema, locale, scopeSchema, settingsSchema, IdentityRepository, IdentityService (+1 more)

### Community 25 - "Registry Prune Workflow"
Cohesion: 0.06
Nodes (31): default, description, type, env, DRY_RUN, KEEP, OCI_CLI_FINGERPRINT, OCI_CLI_KEY_CONTENT (+23 more)

### Community 26 - "Ranking Service"
Cohesion: 0.10
Nodes (5): addDays(), aboveCountSql(), boardRow(), RankingRepository, RankingService

### Community 27 - "Review Load Module"
Cohesion: 0.11
Nodes (6): NEW_WORD_OVERRIDE_MODES, ReviewLoadController, ackSchema, overrideSchema, ReviewLoadRepository, ReviewLoadService

### Community 28 - "Result Summary"
Cohesion: 0.11
Nodes (21): SrsState, skillOf(), LearnStepRow, answersByMeaning(), countedAsReview(), emptyGroups(), iso(), item() (+13 more)

### Community 29 - "Admin Practice Items"
Cohesion: 0.10
Nodes (4): CreateItem, PatchItem, AdminPracticeItemsRepository, AdminPracticeItemsService

### Community 30 - "Deploy Env Secrets"
Cohesion: 0.07
Nodes (29): ANTHROPIC_API_KEY, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, CORS_ORIGINS, DATABASE_URL, DB_POOL_SIZE, DIRECT_URL, ELEVENLABS_API_KEY (+21 more)

### Community 31 - "Memory Reducer & Evidence"
Cohesion: 0.12
Nodes (25): CLASS_BY_VARIANT, EVIDENCE_CLASS, EvidenceClass, FSRS_GRADE, MEMORY_SIGNAL, OUTCOME, Outcome, AnswerShape (+17 more)

### Community 32 - "Test Harness & Providers"
Cohesion: 0.12
Nodes (18): TtsProvider, SpeechProvider, seedTopic(), SeedWord, ANON_KEY, CORS_TEST_ORIGIN, createHarness(), FakeAudioStorage (+10 more)

### Community 33 - "Custom Words Repository"
Cohesion: 0.13
Nodes (4): CustomWordsRepository, sameLemma(), sourceOf(), MeaningOverride

### Community 34 - "Logs Workflow"
Cohesion: 0.07
Nodes (26): LINES, PATTERN, SSH_KEY, default, description, type, grep, lines (+18 more)

### Community 35 - "Task Types & Curated Items"
Cohesion: 0.14
Nodes (24): AssessmentIntent, Template, Variant, AnswerKey, resolveAudioUrl(), cefrRank(), CuratedItem, INTENT_BY_VARIANT (+16 more)

### Community 36 - "Journey View"
Cohesion: 0.11
Nodes (19): CheckpointState, JOURNEY_NODE_STATE, JOURNEY_NODE_TYPE, JOURNEY_SEGMENT_STATUS, JourneyNodeState, JourneyNodeType, JourneySegmentStatus, buildJourney() (+11 more)

### Community 37 - "TypeScript Config"
Cohesion: 0.07
Nodes (25): exclude, extends, include, compilerOptions, allowSyntheticDefaultImports, declaration, emitDecoratorMetadata, esModuleInterop (+17 more)

### Community 38 - "Challenge Chapter Content"
Cohesion: 0.17
Nodes (16): CHALLENGE_ROLE, ChallengeRole, GAME_MODE, Candidate, composeChapter(), normalizeKey(), pickDistinct(), pickReview() (+8 more)

### Community 39 - "FSRS Scheduler"
Cohesion: 0.18
Nodes (24): FsrsGrade, MemorySignal, applyReview(), clamp(), clampS(), DECAY, FACTOR, forgetStability() (+16 more)

### Community 40 - "Username Generation"
Cohesion: 0.12
Nodes (21): AVATAR_KEYS, constraintOf(), ADJECTIVES, ANIMALS, canonicalUsername(), generateUsername(), LEET, normalizeForCheck() (+13 more)

### Community 41 - "Admin Ranking Moderation"
Cohesion: 0.10
Nodes (5): ReportResolution, AdminRankingService, eligibilitySchema, listReportsSchema, resolveReportSchema

### Community 42 - "Anthropic Lexical Provider"
Cohesion: 0.15
Nodes (12): AnthropicLexicalProvider, word, DraftSense, generatedSchema, GeneratedWord, GenerateRequest, SourceMeaning, TranslatedMeaning (+4 more)

### Community 43 - "Placement Module"
Cohesion: 0.11
Nodes (5): PlacementController, PlacementSubmit, placementSubmitSchema, PlacementRepository, PlacementService

### Community 44 - "JWT Guard & Provisioning"
Cohesion: 0.11
Nodes (5): SupabaseJwtGuard, UserIdCache, UserProvisioningRepository, AccountDeletionRepository, AccountDeletionService

### Community 45 - "Azure Speech Provider"
Cohesion: 0.12
Nodes (15): Validity, envSchema, parseVoices(), AzureResponse, AzureRestSpeechProvider, AzureScored, AzureSyllable, readSyllables() (+7 more)

### Community 46 - "Custom Words Service"
Cohesion: 0.15
Nodes (7): LexicalProvider, WordMatch, clampPopularity(), CustomWordsService, statusOf(), toPayload(), withLocators()

### Community 47 - "Review Scope SQL (R/C/B)"
Cohesion: 0.16
Nodes (18): NEW_WORDS_BLOCKED_REASON, defaultPronunciationSql, DIACRITICS, FOLD_FROM, FOLD_MAP, FOLD_PAIRS, FOLD_TO, foldedColumn() (+10 more)

### Community 48 - "Weak Scope & Commit Repo"
Cohesion: 0.13
Nodes (13): SESSION_STATUS, ProgressRepository, needPracticeWordsSql(), weakMeaningsSql(), weakSignal, weakSince(), MeaningLabel, NO_SCOPE_EVENTS (+5 more)

### Community 49 - "Admin Audio Controller"
Cohesion: 0.14
Nodes (8): AdminAudioController, generateAudioSchema, ListAudioMissing, listAudioMissingSchema, ListAudioStale, listAudioStaleSchema, refreshAudioSchema, AdminAudioService

### Community 50 - "Implementation Decisions"
Cohesion: 0.11
Nodes (21): Repeated Meaning on the board rule, Challenge Map (Match Madness), Checkpoint gate removed, Commit completeness, Daily review (one meaning task per due word), Daily speaking (opt-in), deliveryMode on audio-prompt tasks, Empty plan {sessionId:null, steps:[]} (+13 more)

### Community 51 - "Spec: Resolver & Planner"
Cohesion: 0.11
Nodes (20): Content/admin API, Audio asset storage (object storage/CDN, audio_asset_key), Daily selection algorithm, Decision register D01-D31, Dual-target mapping (Meaning + Pronunciation), PUT /v1/me/levels, POST /v1/sessions/plan, Localization pipeline (template copy + published vocab locale + curated item locale) (+12 more)

### Community 52 - "Placement Domain"
Cohesion: 0.14
Nodes (16): ASSESSMENT_INTENT, CefrLevel, PROMPT_TYPE, buildPlacementQuestions(), buildQuestion(), estimateLevel(), PlacementAnswer, PlacementCandidate (+8 more)

### Community 53 - "Admin Tests & Collections"
Cohesion: 0.10
Nodes (17): collectionLocalizations, collections, topicLocalizations, topicMeanings, userActiveTopics, userLearningScope, userMeaningOverrides, isCatalogCollection (+9 more)

### Community 54 - "Admin Audio Generation"
Cohesion: 0.13
Nodes (8): GenerateAudio, PublicationKey, RefreshAudio, AdminAudioRepository, escapeLike(), idsIn(), outdatedAudio(), mapLimit()

### Community 56 - "Planner Target Selection"
Cohesion: 0.16
Nodes (8): reviewableSql(), inScope(), PlannerRepository, practiceSource(), uuidList(), formStateSql(), learnedFormsSql(), spokenFormSql()

### Community 57 - "Docker Compose Prod"
Cohesion: 0.10
Nodes (20): external, NODE_ENV, PORT, interval, retries, start_period, test, timeout (+12 more)

### Community 58 - "Ranking Tier Migration"
Cohesion: 0.17
Nodes (18): idx_learning_point_awards_user_day, idx_learning_point_awards_user_meaning, idx_ranking_eligibility_audit_user, idx_user_reports_open, idx_user_reports_reporter, idx_weekly_lp_scores_board, idx_weekly_rank_snapshots_user, learning_point_awards (+10 more)

### Community 59 - "Runtime Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @anthropic-ai/sdk@^1.3.0, drizzle-orm@0.45.4, fastify@5.12.7, @fastify/multipart@^10.1.6, @fastify/static@^10.1.8, jose@^6.2.14, @nestjs/common@^12.3.2 (+12 more)

### Community 60 - "Planner Snapshots & Locale"
Cohesion: 0.11
Nodes (15): EVALUATOR_VERSION, PLAN_VERSION, SCHEDULER_VERSION, SESSION_MODES, COPY, hasLocaleCopy(), SUPPORTED_LOCALES, MeaningSnapshot (+7 more)

### Community 61 - "Learn Home Review Load"
Cohesion: 0.18
Nodes (18): NEW_WORD_OVERRIDE_MODE, NEW_WORD_REASON, NewWordReason, SCOPE_STATUS, ScopeStatus, WithheldReason, learnHomeView(), activeOverride() (+10 more)

### Community 62 - "Spec: Templates & Learning Cycle"
Cohesion: 0.18
Nodes (15): First Meaning-cued active recall (firstRecallTaskId), Retired templates audioSelect / split / trace, New Meaning Learning Cycle (select + typing|flyReorder + recording), 7 practice templates, clozeSelect template, flyReorder template, match template, recording template (+7 more)

### Community 63 - "Pronunciation Audio"
Cohesion: 0.16
Nodes (6): AudioTarget, Voiced, bareIpa(), AudioStorage, IPA_MISSING, PronunciationAudio

### Community 64 - "Spec: Atomic Commit"
Cohesion: 0.13
Nodes (15): Atomic commit algorithm, Vocab Flow MVP System Design Blueprint v1.1, Collection -> Topic -> Word -> Type -> Meaning hierarchy, Daily Session (Review Due -> Learn New -> Active Recall -> Finish), 7 evaluators, Suggested implementation sequence, Vocab Flow MVP System Design Master Spec, Modular monolith (NestJS/TypeScript, REST) (+7 more)

### Community 65 - "Custom Word Lookup/Add"
Cohesion: 0.15
Nodes (3): AddRequest, LookupRequest, assertEdits()

### Community 66 - "Frontend: Onboarding & LP"
Cohesion: 0.16
Nodes (15): Account deletion (DELETE /v1/me), Auth API (/v1/auth/*, Supabase proxy), GET /v1/catalog/collections, Vocab Flow Frontend Integration Guide, Error format {code,message,retryable,requestId}, explanationLocale, LP (learning points), GET /v1/me profile (+7 more)

### Community 67 - "Challenge Map Domain"
Cohesion: 0.17
Nodes (11): CHALLENGE_CHAPTER_STATE, CHALLENGE_LEVEL_STATE, CHALLENGE_NEXT_CHAPTER_STATE, ChallengeLevelState, buildMap(), ChapterSummary, isChapterCleared(), LevelBest (+3 more)

### Community 68 - "Challenge Map State"
Cohesion: 0.17
Nodes (14): CHALLENGE_OPEN_STATUSES, CHALLENGE_RUN_STATUS, ChallengeRunStatus, NewWordsBlockedReason, asJsonArray(), CandidateRow, learnedContent(), LevelProgressRow (+6 more)

### Community 69 - "Progress Word Views"
Cohesion: 0.23
Nodes (13): applyOverride(), RawMeaningRow, defaultPronunciation(), ipaVaries(), MeaningRow, meaningView(), memoryView(), parseMeaningRows() (+5 more)

### Community 70 - "Frontend: Results & Speaking"
Cohesion: 0.15
Nodes (15): meaningCue two-step recall, Mode speaking_practice, Mode weak_words_practice, GET /v1/me/words and stats, On-device speech transcription (transcribed event), POST /sessions/{id}/recording-assess (Azure), learning_sessions.result.summary retention, Session result statistics summary (+7 more)

### Community 71 - "Task Validation"
Cohesion: 0.20
Nodes (14): normalizeAnswer(), promptSchema, accepted, BODY_SCHEMAS, common, contains(), findTaskProblem(), FORBIDDEN_CLIENT_KEYS (+6 more)

### Community 72 - "HTTP Adapter & CORS"
Cohesion: 0.23
Nodes (11): @nestjs/platform-fastify@^12.3.2, @nestjs/swagger@^12.0.5, @nestjs/platform-fastify, @nestjs/swagger, configureCors(), bodyForLog(), createHttpAdapter(), logger (+3 more)

### Community 74 - "SigV4 Audio Storage"
Cohesion: 0.30
Nodes (8): R2AudioStorage, encodeRfc3986(), hmac(), lowerKeys(), sha256Hex(), signV4(), SignV4Input, config

### Community 75 - "App Config & TTS"
Cohesion: 0.20
Nodes (3): Clock, AppConfig, ElevenLabsTtsProvider

### Community 76 - "Interleaver"
Cohesion: 0.23
Nodes (10): TEMPLATE, VARIANT, batchSizes(), LearnSlot, pickRecall(), pickWeighted(), planBatch(), planNewMeanings() (+2 more)

### Community 77 - "Rules: Schema Deviations"
Cohesion: 0.17
Nodes (10): Tests against embedded real Postgres, Hand-written SQL migrations (CHECK, partial indexes, triggers, FKs), Immutable learning_sessions.plan and meaning_publications (triggers), Query-count test (1 vs 20 Meanings), Admin CRUD rules, Session retention (plan/raw_events cleared after 30 days), Deviations from the spec SQL, Admin roles (editor/admin, seeded admin) (+2 more)

### Community 78 - "Test DB Setup"
Cohesion: 0.17
Nodes (4): pg@^8.23.1, embedded-postgres@17.10.0-beta.17, embedded-postgres, pg

### Community 79 - "Custom Word Text"
Cohesion: 0.27
Nodes (10): CUSTOM_MEANING_STATUS, CUSTOM_WORD_LOOKUP_RESULT, CustomMeaningStatus, LEXICAL_DRAFT_KIND, MEANING_POPULARITY, audioKey(), contextKey(), locateTarget() (+2 more)

### Community 80 - "Deployment Docs"
Cohesion: 0.24
Nodes (11): Caddy route routes/vocab.caddy (handle_path /service/vocab), Deploy pipeline: push to master -> arm64 image -> OCIR -> ssh, deploy user / APP_DIR without sudo, Deployment (vocab-backend), edge network (shared Caddy), Migrations run before restart (skip_migrations), money-space (host project), Shared OCI VM with money-space-backend (+3 more)

### Community 81 - "Custom Words Migration"
Cohesion: 0.23
Nodes (8): custom_word_usage, idx_lexical_drafts_meaning, idx_meanings_ai_generated, idx_meanings_owner, lexical_drafts, topics_owner_user_id_key, user_meaning_overrides, words_language_lemma_key

### Community 82 - "Challenge Map Migration"
Cohesion: 0.32
Nodes (11): challenge_chapter_meanings, challenge_chapter_meanings_core_key, challenge_chapter_meanings_meaning_key, challenge_chapter_meanings_slot_key, challenge_chapters, challenge_level_progress, challenge_runs, challenge_runs_open_key (+3 more)

### Community 83 - "Package Scripts"
Cohesion: 0.17
Nodes (12): scripts, build, db:generate, db:migrate, db:seed, db:seed:heteronyms, lint, start (+4 more)

### Community 84 - "Spec: REST API & Speech"
Cohesion: 0.17
Nodes (12): Azure Pronunciation Assessment adapter, Checkpoint Challenge (every 7 new-learning sessions), Commit body (raw events only, deliveryMode), POST /v1/sessions/{id}/commit, GET /v1/sessions/{id}/commit-status, GET /v1/me/learn-home, POST /v1/sessions/{id}/recording-assess, API error codes (SESSION_PAYLOAD_CONFLICT etc.) (+4 more)

### Community 85 - "Meaning Publication"
Cohesion: 0.23
Nodes (3): Executor, PublicationRepository, reject()

### Community 86 - "Resolver Spec Tests"
Cohesion: 0.17
Nodes (7): achieve, bothPrompts, clarify, ctx, CURATED_BY_TEMPLATE, options, pool

### Community 87 - "Planner Service"
Cohesion: 0.18
Nodes (6): SessionPlan, empty(), label(), PlannerService, toClientStep(), toSessionPlan()

### Community 88 - "Rules: Constants & scopeEvents"
Cohesion: 0.18
Nodes (8): src/config/policy.ts (trial numbers / POLICY), NestJS (Fastify) + Drizzle ORM + Supabase stack, App-generated UUID v7 ids (newId), Vocab Flow backend (CLAUDE.md), Drizzle ORM pinned to 0.45.4, FRONTEND_FLOW.md, needPractice cost (before inside writeCommit), Session result statistics

### Community 89 - "Learner Pool Isolation"
Cohesion: 0.22
Nodes (9): lexical_drafts, meanings.owner_user_id, user_meaning_overrides, words unique on language + lower(btrim(lemma)) + homograph_key, Custom words: review (/admin/ai-meanings), Custom words: personal roadmap topic, Custom words: shared pool, Custom words: translation (+1 more)

### Community 90 - "README Concepts"
Cohesion: 0.25
Nodes (11): Not implemented items, Admin audio endpoints (status/generate/missing), Supabase Auth proxy routes (/v1/auth/*), Cloudflare R2 audio storage, /v1/custom-words, ElevenLabs TTS from IPA, Pronunciations per Meaning, Spec case IDs C01-C62 in tests (+3 more)

### Community 91 - "Deploy Workflow Jobs"
Cohesion: 0.18
Nodes (10): concurrency, cancel-in-progress, group, env, EDGE_DIR, OCIR_NAMESPACE, OCIR_REGISTRY, OCIR_REPOSITORY (+2 more)

### Community 92 - "Docker Build Args"
Cohesion: 0.18
Nodes (11): with, build-args, cache-from, cache-to, context, password, platforms, push (+3 more)

### Community 94 - "pnpm Workspace"
Cohesion: 0.20
Nodes (9): allowBuilds, embedded-postgres, @embedded-postgres/darwin-arm64, esbuild, @scarf/scarf, @swc/core, autoInstallPeers, overrides (+1 more)

### Community 96 - "Custom Word Overrides API"
Cohesion: 0.31
Nodes (5): addSchema, field, lookupSchema, OverrideRequest, overrideSchema

### Community 99 - "Review Scope Decisions"
Cohesion: 0.25
Nodes (8): known_check / skippableTaskIds / knownLearnSteps rules, Review scope R/C/B (review-scope.sql.ts), reviewableSql (all learned Meanings minus paused collections), Auto-balance formula, Known check (D), Practice as review (C), Review source D2 (all learned minus paused), Scope completion and review load

### Community 100 - "Ranking & LP Decisions"
Cohesion: 0.25
Nodes (8): src/config/app-config.ts defaults, GitHub secrets and variables, In-process hourly cron (ENABLE_CRON), Learning Points (LP), RANKING_ENABLED launch gate, Ranking & Tier (v1.2), Tier never drops, Week close job

### Community 101 - "Speaking Decisions"
Cohesion: 0.25
Nodes (9): Azure speech track (EWMA, hysteresis), Event shapes (iOS contract), On-device speaking track, Random practice (mixed only), Skill system removed, docs/SPEAKING_PLAN.md, speaking_practice mode, Speaking progress (user_speaking_progress) (+1 more)

### Community 102 - "Frontend: Session Plan Modes"
Cohesion: 0.22
Nodes (9): Client capabilities (audioPlayback, microphone), POST /v1/custom-words, POST /v1/custom-words/lookup, Custom word override (PUT/DELETE .../override), Custom words (user-added words), Learn step card, Mode random_practice, Review pauses per collection (+1 more)

### Community 103 - "Frontend: Learn Home & Map"
Cohesion: 0.25
Nodes (9): Challenge Map (Match Madness), Checkpoint challenge (deprecated), Journey API (deprecated), GET /v1/me/learn-home, New word override (PUT /v1/me/new-word-override), POLICY (trial values), Review Load Choice prompt (review-load/ack), scopeEvents in commit response (+1 more)

### Community 104 - "Deploy Triggers"
Cohesion: 0.22
Nodes (9): skip_migrations, on, push, workflow_dispatch, branches, default, description, type (+1 more)

### Community 105 - "Canonical Hashing"
Cohesion: 0.31
Nodes (6): CHALLENGE_NEXT_ACTION, CHALLENGE_OUTCOME, CHALLENGE_UNLOCK, LoadedRun, canonicalHash(), canonicalize()

### Community 106 - "Spec: Session Tables"
Cohesion: 0.31
Nodes (8): Memory signals (unaided/assisted/failed recall, recognition success/failure), PostgreSQL 16+ with JSONB, Random / Weak practice selection, Result reducer (task -> target -> MemoryObservation + SkillEvidence), learning_sessions table (plan, raw_events, result), memory_observations table, skill_evidence table, speech_assessment_receipts table

### Community 107 - "Challenge API Schemas"
Cohesion: 0.33
Nodes (7): CHALLENGE_ENDED_REASON, CHALLENGE_EVENT_TYPE, CommitRunBody, commitRunSchema, elapsed, LevelParams, levelParamsSchema

### Community 109 - "Frontend: Task Events"
Cohesion: 0.29
Nodes (6): Task structure (template, variant, prompt, evaluation), fly_reorder template, match template, select / cloze_select template, surgery template, typing template

### Community 110 - "Frontend: Commit & Runs"
Cohesion: 0.29
Nodes (5): Challenge run lifecycle (create/start/commit/quit/status), Challenge scoring and star criteria, GET /sessions/{id}/commit-status, deliveryMode (audio/fallback/none), POST /v1/sessions/{id}/commit

### Community 111 - "Speaking Progress Migration"
Cohesion: 0.29
Nodes (5): pronunciation_map, pronunciation_republish, pronunciations_meaning_id_accent_locale_key, idx_speaking_user_due, user_speaking_progress

### Community 112 - "Spec: SRS Policy"
Cohesion: 0.29
Nodes (7): Adaptive Meaning SRS trial parameters (superseded), FSRS-6 with weighted evidence, docs/FSRS_PLAN.md, memory-srs module, Recognition Grace, Mode-specific SRS policy (superseded by FSRS-6), vocab_flow_srs_reference.py

### Community 113 - "Spec: Superseded Skills"
Cohesion: 0.25
Nodes (8): Custom word appendix, docs/DECISIONS.md, lexical_drafts, Skill status notVerified -> demonstrated -> verified, Four-skill verification (superseded: skill system removed), docs/SPEAKING_PLAN.md, user_speaking_progress, WordFullyVerifiedForLearnedMeanings

### Community 115 - "Session History Migration"
Cohesion: 0.33
Nodes (3): forbid_session_plan_rewrite(), learning_sessions_plan_immutable, idx_speech_receipts_task

### Community 116 - "Deploy Steps"
Cohesion: 0.38
Nodes (7): steps, steps, id, if, name, run, uses

### Community 117 - "Deploy Job"
Cohesion: 0.29
Nodes (7): env, needs, runs-on, APP_DIR, APP_PORT, BACKEND_IMAGE, deploy

### Community 119 - "Frontend: Daily & Known Check"
Cohesion: 0.33
Nodes (5): dailySpeaking setting, 'I know this word' known check, FSRS memory (stabilityDays, retrievability), Mode daily, Daily summary groups (review solid/shaky/relearn, newWords)

### Community 120 - "Nest CLI Config"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 121 - "Build Job"
Cohesion: 0.40
Nodes (5): if, outputs, runs-on, build, version

### Community 122 - "Vitest Setup"
Cohesion: 0.40
Nodes (4): unplugin-swc@^2.0.0, vitest@^5.0.5, unplugin-swc, vitest

### Community 125 - "ESLint No-Query-In-Loop"
Cohesion: 0.50
Nodes (3): noQueryInLoop, typescript-eslint@^8.72.1, typescript-eslint

## Knowledge Gaps
- **80 isolated node(s):** `Collection -> Topic -> Word -> Type -> Meaning hierarchy`, `Daily Session (Review Due -> Learn New -> Active Recall -> Finish)`, `select.gloss variant`, `user_settings table`, `GET /v1/sessions/{id}/commit-status` (+75 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 724 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **39 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ApiError` connect `API Errors` to `Admin Words Module`, `Auth Provider & Service`, `Controllers & Current User`, `Seeds & Repo Schema Usage`, `Drizzle DB Core`, `App Module & Zod Pipes`, `Admin Catalog Module`, `Commit Service & Evaluator`, `Integration Test Suite`, `Admin Meaning Approval`, `Plan Builder`, `Task Answer Evaluators`, `Challenge Run Service`, `Admin Content Controllers`, `Policy & Tier Config`, `Identity Module`, `Ranking Service`, `Review Load Module`, `Admin Practice Items`, `Custom Words Repository`, `Admin Ranking Moderation`, `Anthropic Lexical Provider`, `Placement Module`, `JWT Guard & Provisioning`, `Azure Speech Provider`, `Custom Words Service`, `Review Scope SQL (R/C/B)`, `Placement Domain`, `Admin Tests & Collections`, `Admin Audio Generation`, `Planner Target Selection`, `Planner Snapshots & Locale`, `Pronunciation Audio`, `Custom Word Lookup/Add`, `Progress Word Views`, `Admin Examples & Patch`, `SigV4 Audio Storage`, `Custom Word Text`, `Meaning Publication`, `Planner Service`, `Speech Service`, `Catalog Repository`, `Custom Word Overrides API`, `Canonical Hashing`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **What connects `Collection -> Topic -> Word -> Type -> Meaning hierarchy`, `Daily Session (Review Due -> Learn New -> Active Recall -> Finish)`, `select.gloss variant` to the rest of the system?**
  _80 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Spec Schema DDL` be split into smaller, more focused modules?**
  _Cohesion score 0.055944055944055944 - nodes in this community are weakly interconnected._
- **Why does `AdminCatalogController` connect `Admin Content Controllers` to `Admin Words Module`, `App Module & Zod Pipes`, `Admin Catalog Module`, `Admin Request Schemas`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Should `Admin Words Module` be split into smaller, more focused modules?**
  _Cohesion score 0.05228070175438596 - nodes in this community are weakly interconnected._
- **Why does `@nestjs/common` connect `App Module & Zod Pipes` to `Auth Provider & Service`, `Seeds & Repo Schema Usage`, `Drizzle Schema & Ranking`, `Drizzle DB Core`, `Time Helpers & LP Awards`, `Admin Catalog Module`, `Commit Service & Evaluator`, `Admin Request Schemas`, `Policy & Tier Config`, `API Errors`, `Dev Dependencies`, `Identity Module`, `Review Load Module`, `Challenge Chapter Content`, `Anthropic Lexical Provider`, `Placement Module`, `Azure Speech Provider`, `Review Scope SQL (R/C/B)`, `Weak Scope & Commit Repo`, `Admin Audio Controller`, `Placement Domain`, `Admin Tests & Collections`, `Runtime Dependencies`, `Planner Snapshots & Locale`, `Pronunciation Audio`, `Challenge Map State`, `Progress Word Views`, `HTTP Adapter & CORS`, `SigV4 Audio Storage`, `Custom Word Text`, `Custom Word Overrides API`, `Canonical Hashing`, `Challenge API Schemas`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `Auth Provider & Service` be split into smaller, more focused modules?**
  _Cohesion score 0.05738615327656423 - nodes in this community are weakly interconnected._