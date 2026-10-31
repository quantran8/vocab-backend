// Mirrors 001_initial_schema_v0.4_FULL_SPEC_PROPOSED.sql, except ids are UUID v7.
// CHECK constraints, partial indexes, triggers and foreign keys live in the SQL migrations.
import { relations } from 'drizzle-orm';
import {
  boolean, char, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, unique, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { newId } from '../common/ids';

const id = () => uuid('id').primaryKey().$defaultFn(newId);
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 6 });
const createdAt = () => ts('created_at').notNull().defaultNow();

// A. Identity, preferences and curated scope
export const appUsers = pgTable('app_user', {
  id: id(),
  identitySubject: text('identity_subject').notNull().unique('app_user_identity_subject_key'),
  proficiencyLevel: varchar('proficiency_level', { length: 2 }),
  learningLevel: varchar('learning_level', { length: 2 }),
  createdAt: createdAt(),
});

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey(),
  learningLanguage: varchar('learning_language', { length: 16 }).notNull().default('en'),
  explanationLocale: varchar('explanation_locale', { length: 32 }).notNull().default('vi-VN'),
  uiLocale: varchar('ui_locale', { length: 32 }).notNull().default('vi-VN'),
  timeZone: varchar('time_zone', { length: 64 }).notNull().default('Asia/Ho_Chi_Minh'),
  dailyNewWordGoal: smallint('daily_new_word_goal').notNull().default(5),
  weeklyAnchorAt: ts('weekly_anchor_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const collections = pgTable('collections', {
  id: id(),
  slug: text('slug').notNull().unique('collections_slug_key'),
  title: text('title').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
});

export const topics = pgTable('topics', {
  id: id(),
  collectionId: uuid('collection_id').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
}, (t) => [unique('topics_collection_id_slug_key').on(t.collectionId, t.slug)]);

export const collectionLocalizations = pgTable('collection_localizations', {
  collectionId: uuid('collection_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
}, (t) => [primaryKey({ columns: [t.collectionId, t.locale] })]);

export const topicLocalizations = pgTable('topic_localizations', {
  topicId: uuid('topic_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
}, (t) => [primaryKey({ columns: [t.topicId, t.locale] })]);

export const userLearningScope = pgTable('user_learning_scope', {
  userId: uuid('user_id').primaryKey(),
  collectionId: uuid('collection_id').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const userActiveTopics = pgTable('user_active_topics', {
  userId: uuid('user_id').notNull(),
  topicId: uuid('topic_id').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.topicId] })]);

// B. Canonical vocabulary data
export const words = pgTable('words', {
  id: id(),
  language: varchar('language', { length: 16 }).notNull(),
  lemma: text('lemma').notNull(),
  homographKey: text('homograph_key'),
  createdAt: createdAt(),
});

export const wordTypes = pgTable('word_types', {
  id: id(),
  wordId: uuid('word_id').notNull(),
  partOfSpeech: varchar('part_of_speech', { length: 32 }).notNull(),
}, (t) => [unique('word_types_id_word_id_key').on(t.id, t.wordId)]);

export const pronunciations = pgTable('pronunciations', {
  id: id(),
  typeId: uuid('type_id').notNull(),
  accentLocale: varchar('accent_locale', { length: 32 }).notNull(),
  ipa: text('ipa'),
  audioAssetKey: text('audio_asset_key'),
  createdAt: createdAt(),
}, (t) => [unique('pronunciations_type_id_accent_locale_key').on(t.typeId, t.accentLocale)]);

export const meanings = pgTable('meanings', {
  id: id(),
  typeId: uuid('type_id').notNull(),
  cefrLevel: varchar('cefr_level', { length: 2 }),
  coreDefinition: text('core_definition'),
  createdAt: createdAt(),
});

export const meaningExamples = pgTable('meaning_examples', {
  id: id(),
  meaningId: uuid('meaning_id').notNull(),
  sourceText: text('source_text').notNull(),
  targetLocator: jsonb('target_locator').notNull().$type<Record<string, unknown>>(),
});

export const meaningLocalizations = pgTable('meaning_localizations', {
  meaningId: uuid('meaning_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  meaningText: text('meaning_text').notNull(),
  definitionText: text('definition_text').notNull(),
  editorialState: varchar('editorial_state', { length: 16 }).notNull().default('draft'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.meaningId, t.locale] })]);

export const exampleLocalizations = pgTable('example_localizations', {
  exampleId: uuid('example_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  translationText: text('translation_text').notNull(),
}, (t) => [primaryKey({ columns: [t.exampleId, t.locale] })]);

export const topicMeanings = pgTable('topic_meanings', {
  topicId: uuid('topic_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
  curatedRank: integer('curated_rank').notNull(),
}, (t) => [
  primaryKey({ columns: [t.topicId, t.meaningId] }),
  unique('topic_meanings_topic_id_curated_rank_key').on(t.topicId, t.curatedRank),
]);

export const meaningPublications = pgTable('meaning_publications', {
  id: id(),
  meaningId: uuid('meaning_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  revision: integer('revision').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  approvedAt: ts('approved_at').notNull(),
  publishedAt: ts('published_at').notNull().defaultNow(),
}, (t) => [
  unique('meaning_publications_meaning_id_locale_revision_key').on(t.meaningId, t.locale, t.revision),
  unique('meaning_publications_id_meaning_id_locale_key').on(t.id, t.meaningId, t.locale),
]);

export const activeMeaningPublications = pgTable('active_meaning_publications', {
  meaningId: uuid('meaning_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  publicationId: uuid('publication_id').notNull(),
  recalledAt: ts('recalled_at'),
}, (t) => [primaryKey({ columns: [t.meaningId, t.locale] })]);

// C. Curated practice: each row is one immutable content revision
export const practiceItems = pgTable('practice_items', {
  id: id(),
  template: varchar('template', { length: 24 }).notNull(),
  variant: varchar('variant', { length: 40 }),
  contextCefrLevel: varchar('context_cefr_level', { length: 2 }),
  sourceContent: jsonb('source_content').notNull(),
  sourceEvaluation: jsonb('source_evaluation').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  supersedesItemId: uuid('supersedes_item_id'),
  approvedAt: ts('approved_at'),
  createdAt: createdAt(),
}, (t) => [index('idx_practice_items_lookup').on(t.template, t.status)]);

export const practiceItemLocalizations = pgTable('practice_item_localizations', {
  practiceItemId: uuid('practice_item_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  localizedContent: jsonb('localized_content').notNull().default({}).$type<Record<string, unknown>>(),
  contextualExplain: text('contextual_explain'),
  editorialState: varchar('editorial_state', { length: 16 }).notNull().default('draft'),
  approvedAt: ts('approved_at'),
}, (t) => [
  primaryKey({ columns: [t.practiceItemId, t.locale] }),
  index('idx_practice_item_locales').on(t.locale, t.editorialState),
]);

export const practiceItemTargets = pgTable('practice_item_targets', {
  practiceItemId: uuid('practice_item_id').notNull(),
  ordinal: smallint('ordinal').notNull(),
  meaningId: uuid('meaning_id'),
  pronunciationId: uuid('pronunciation_id'),
}, (t) => [primaryKey({ columns: [t.practiceItemId, t.ordinal] })]);

// D. Session plans persist technical snapshots only
export const learningSessions = pgTable('learning_sessions', {
  id: id(),
  userId: uuid('user_id').notNull(),
  mode: varchar('mode', { length: 24 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('issued'),
  scopeSnapshot: jsonb('scope_snapshot').notNull().default({}).$type<{ challengeId?: string; [key: string]: unknown }>(),
  planVersion: varchar('plan_version', { length: 40 }).notNull(),
  policyVersions: jsonb('policy_versions').notNull().default({}),
  issuedAt: ts('issued_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  committedAt: ts('committed_at'),
  commitRequestSha256: char('commit_request_sha256', { length: 64 }),
  commitResponse: jsonb('commit_response'),
}, (t) => [
  unique('learning_sessions_id_user_id_key').on(t.id, t.userId),
  index('idx_sessions_user_issued').on(t.userId, t.issuedAt.desc()),
]);

export const sessionTasks = pgTable('session_tasks', {
  id: id(),
  sessionId: uuid('session_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  phase: varchar('phase', { length: 32 }).notNull(),
  template: varchar('template', { length: 24 }).notNull(),
  variant: varchar('variant', { length: 40 }),
  curatedItemId: uuid('curated_item_id'),
  clientPayload: jsonb('client_payload').notNull(),
  serverEvaluation: jsonb('server_evaluation').notNull(),
  evaluatorVersion: varchar('evaluator_version', { length: 40 }).notNull(),
}, (t) => [
  unique('session_tasks_session_id_ordinal_key').on(t.sessionId, t.ordinal),
  unique('session_tasks_session_id_id_key').on(t.sessionId, t.id),
  index('idx_session_tasks_session').on(t.sessionId),
]);

export const sessionTaskTargets = pgTable('session_task_targets', {
  sessionId: uuid('session_id').notNull(),
  taskId: uuid('task_id').notNull(),
  ordinal: smallint('ordinal').notNull(),
  meaningId: uuid('meaning_id'),
  pronunciationId: uuid('pronunciation_id'),
}, (t) => [primaryKey({ columns: [t.sessionId, t.taskId, t.ordinal] })]);

export const sessionLearnSteps = pgTable('session_learn_steps', {
  id: id(),
  sessionId: uuid('session_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  clientCard: jsonb('client_card').notNull(),
  firstRecallTaskId: uuid('first_recall_task_id').notNull(),
}, (t) => [
  unique('session_learn_steps_session_id_meaning_id_key').on(t.sessionId, t.meaningId),
  unique('session_learn_steps_session_id_ordinal_key').on(t.sessionId, t.ordinal),
]);

export const speechAssessmentReceipts = pgTable('speech_assessment_receipts', {
  id: id(),
  sessionId: uuid('session_id').notNull(),
  taskId: uuid('task_id').notNull(),
  validity: varchar('validity', { length: 12 }).notNull(),
  passed: boolean('passed'),
  accuracyScore: numeric('accuracy_score', { precision: 5, scale: 2, mode: 'number' }),
  providerMeta: jsonb('provider_meta').notNull().default({}),
  assessedAt: ts('assessed_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
}, (t) => [index('idx_speech_receipts_expiry').on(t.expiresAt)]);

// E. Committed practice and normalized evidence
export const practiceTaskResults = pgTable('practice_task_results', {
  sessionId: uuid('session_id').notNull(),
  taskId: uuid('task_id').notNull(),
  userId: uuid('user_id').notNull(),
  rawEvents: jsonb('raw_events').notNull(),
  normalizedResult: jsonb('normalized_result').notNull(),
  committedAt: ts('committed_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.taskId] }),
  index('idx_practice_results_user').on(t.userId, t.committedAt.desc()),
]);

export const practiceTargetResults = pgTable('practice_target_results', {
  sessionId: uuid('session_id').notNull(),
  taskId: uuid('task_id').notNull(),
  targetOrdinal: smallint('target_ordinal').notNull(),
  outcome: varchar('outcome', { length: 40 }).notNull(),
  firstAttemptCorrect: boolean('first_attempt_correct'),
  attemptCount: integer('attempt_count').notNull().default(0),
  hintCount: integer('hint_count').notNull().default(0),
  deliveryMode: varchar('delivery_mode', { length: 16 }),
}, (t) => [primaryKey({ columns: [t.sessionId, t.taskId, t.targetOrdinal] })]);

export const userMeaningProgress = pgTable('user_meaning_progress', {
  userId: uuid('user_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
  learnedAt: ts('learned_at').notNull(),
  lastReviewedAt: ts('last_reviewed_at'),
  nextReviewAt: ts('next_review_at').notNull(),
  intervalHours: numeric('interval_hours', { precision: 12, scale: 3, mode: 'number' }).notNull(),
  unaidedStreak: integer('unaided_streak').notNull().default(0),
  lapseCount: integer('lapse_count').notNull().default(0),
  recognitionGraceUsed: boolean('recognition_grace_used').notNull().default(false),
  schedulerVersion: varchar('scheduler_version', { length: 40 }).notNull(),
  version: integer('version').notNull().default(1),
}, (t) => [
  primaryKey({ columns: [t.userId, t.meaningId] }),
  index('idx_progress_due').on(t.userId, t.nextReviewAt),
  index('idx_progress_learned').on(t.userId, t.learnedAt),
]);

export const memoryObservations = pgTable('memory_observations', {
  sessionId: uuid('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
  signal: varchar('signal', { length: 24 }).notNull(),
  isPrimed: boolean('is_primed').notNull().default(false),
  sourceTaskIds: jsonb('source_task_ids').notNull().default([]).$type<string[]>(),
  observedAt: ts('observed_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.meaningId] }),
  index('idx_memory_user_meaning').on(t.userId, t.meaningId, t.observedAt.desc()),
]);

export const skillEvidence = pgTable('skill_evidence', {
  id: id(),
  userId: uuid('user_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  taskId: uuid('task_id').notNull(),
  targetOrdinal: smallint('target_ordinal').notNull(),
  skill: varchar('skill', { length: 12 }).notNull(),
  directness: varchar('directness', { length: 12 }).notNull(),
  validity: varchar('validity', { length: 12 }).notNull(),
  passed: boolean('passed'),
  meaningId: uuid('meaning_id'),
  pronunciationId: uuid('pronunciation_id'),
  assessedAt: ts('assessed_at').notNull(),
  committedAt: ts('committed_at').notNull(),
  assessmentReceiptId: uuid('assessment_receipt_id'),
  evaluatorVersion: varchar('evaluator_version', { length: 40 }).notNull(),
}, (t) => [unique('skill_evidence_session_id_task_id_target_ordinal_skill_key').on(t.sessionId, t.taskId, t.targetOrdinal, t.skill)]);

// F. Weekly challenge snapshots by user-specific 7-day period
export const weeklyChallenges = pgTable('weekly_challenges', {
  id: id(),
  userId: uuid('user_id').notNull(),
  cycleStartAt: ts('cycle_start_at').notNull(),
  cycleEndAt: ts('cycle_end_at').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('available'),
  completedSessionId: uuid('completed_session_id'),
  createdAt: createdAt(),
}, (t) => [
  unique('weekly_challenges_user_id_cycle_start_at_key').on(t.userId, t.cycleStartAt),
  index('idx_weekly_challenges_user').on(t.userId, t.cycleStartAt.desc()),
]);

export const weeklyChallengeMeanings = pgTable('weekly_challenge_meanings', {
  challengeId: uuid('challenge_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
}, (t) => [primaryKey({ columns: [t.challengeId, t.meaningId] })]);

// Relations are only declared for the nested reads that use `db.query`.
export const appUsersRelations = relations(appUsers, ({ one, many }) => ({
  settings: one(userSettings, { fields: [appUsers.id], references: [userSettings.userId] }),
  learningScope: one(userLearningScope, { fields: [appUsers.id], references: [userLearningScope.userId] }),
  activeTopics: many(userActiveTopics),
}));
export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(appUsers, { fields: [userSettings.userId], references: [appUsers.id] }),
}));
export const userLearningScopeRelations = relations(userLearningScope, ({ one }) => ({
  user: one(appUsers, { fields: [userLearningScope.userId], references: [appUsers.id] }),
}));
export const userActiveTopicsRelations = relations(userActiveTopics, ({ one }) => ({
  user: one(appUsers, { fields: [userActiveTopics.userId], references: [appUsers.id] }),
}));

export const collectionsRelations = relations(collections, ({ many }) => ({
  topics: many(topics),
  localizations: many(collectionLocalizations),
}));
export const topicsRelations = relations(topics, ({ one, many }) => ({
  collection: one(collections, { fields: [topics.collectionId], references: [collections.id] }),
  localizations: many(topicLocalizations),
}));
export const collectionLocalizationsRelations = relations(collectionLocalizations, ({ one }) => ({
  collection: one(collections, { fields: [collectionLocalizations.collectionId], references: [collections.id] }),
}));
export const topicLocalizationsRelations = relations(topicLocalizations, ({ one }) => ({
  topic: one(topics, { fields: [topicLocalizations.topicId], references: [topics.id] }),
}));

export const wordsRelations = relations(words, ({ many }) => ({ types: many(wordTypes) }));
export const wordTypesRelations = relations(wordTypes, ({ one, many }) => ({
  word: one(words, { fields: [wordTypes.wordId], references: [words.id] }),
  pronunciations: many(pronunciations),
  meanings: many(meanings),
}));
export const pronunciationsRelations = relations(pronunciations, ({ one }) => ({
  type: one(wordTypes, { fields: [pronunciations.typeId], references: [wordTypes.id] }),
}));
export const meaningsRelations = relations(meanings, ({ one, many }) => ({
  type: one(wordTypes, { fields: [meanings.typeId], references: [wordTypes.id] }),
  examples: many(meaningExamples),
  localizations: many(meaningLocalizations),
}));
export const meaningExamplesRelations = relations(meaningExamples, ({ one, many }) => ({
  meaning: one(meanings, { fields: [meaningExamples.meaningId], references: [meanings.id] }),
  localizations: many(exampleLocalizations),
}));
export const meaningLocalizationsRelations = relations(meaningLocalizations, ({ one }) => ({
  meaning: one(meanings, { fields: [meaningLocalizations.meaningId], references: [meanings.id] }),
}));
export const exampleLocalizationsRelations = relations(exampleLocalizations, ({ one }) => ({
  example: one(meaningExamples, { fields: [exampleLocalizations.exampleId], references: [meaningExamples.id] }),
}));

export const practiceItemsRelations = relations(practiceItems, ({ many }) => ({
  localizations: many(practiceItemLocalizations),
  targets: many(practiceItemTargets),
}));
export const practiceItemLocalizationsRelations = relations(practiceItemLocalizations, ({ one }) => ({
  item: one(practiceItems, { fields: [practiceItemLocalizations.practiceItemId], references: [practiceItems.id] }),
}));
export const practiceItemTargetsRelations = relations(practiceItemTargets, ({ one }) => ({
  item: one(practiceItems, { fields: [practiceItemTargets.practiceItemId], references: [practiceItems.id] }),
}));
