// Mirrors 001_initial_schema_v0.4_FULL_SPEC_PROPOSED.sql, except ids are UUID v7.
// CHECK constraints, partial indexes, triggers and foreign keys live in the SQL migrations.
import { relations } from 'drizzle-orm';
import {
  boolean, char, date, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, unique, uuid, varchar,
} from 'drizzle-orm/pg-core';
import {
  CONTENT_STATUS, EDITORIAL_STATE, ITEM_STATUS, MEANING_ORIGIN, SESSION_STATUS, CHECKPOINT_STATE,
  type LexicalDraftKind, type MeaningOrigin, type CefrLevel, type ContentStatus, type EditorialState, type ItemStatus, type MemorySignal, type PartOfSpeech, type SessionMode, type SessionStatus, type Skill, type Template, type Validity, type Variant, type CheckpointState, type EvidenceReason,
} from '../common/constants/domain';
import { newId } from '../common/ids';
import type { MeaningOverride } from '../modules/practice-resolver/meaning-override';
import type { SessionPlan } from '../modules/session-planner/domain/session-plan';

const id = () => uuid('id').primaryKey().$defaultFn(newId);
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 6 });
const createdAt = () => ts('created_at').notNull().defaultNow();

// A. Identity, preferences and curated scope
export const appUsers = pgTable('app_user', {
  id: id(),
  identitySubject: text('identity_subject').notNull().unique('app_user_identity_subject_key'),
  proficiencyLevel: varchar('proficiency_level', { length: 2 }).$type<CefrLevel>(),
  createdAt: createdAt(),
});

export const deletedIdentities = pgTable('deleted_identities', {
  identitySubject: text('identity_subject').primaryKey(),
  deletedAt: ts('deleted_at').notNull().defaultNow(),
});

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey(),
  learningLanguage: varchar('learning_language', { length: 16 }).notNull().default('en'),
  explanationLocale: varchar('explanation_locale', { length: 32 }).notNull().default('vi-VN'),
  uiLocale: varchar('ui_locale', { length: 32 }).notNull().default('vi-VN'),
  timeZone: varchar('time_zone', { length: 64 }).notNull().default('Asia/Ho_Chi_Minh'),
  dailyNewWordGoal: smallint('daily_new_word_goal').notNull().default(5),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const collections = pgTable('collections', {
  id: id(),
  slug: text('slug').notNull().unique('collections_slug_key'),
  title: text('title').notNull(),
  status: varchar('status', { length: 16 }).$type<ContentStatus>().notNull().default(CONTENT_STATUS.DRAFT),
});

export const topics = pgTable('topics', {
  id: id(),
  collectionId: uuid('collection_id').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  status: varchar('status', { length: 16 }).$type<ContentStatus>().notNull().default(CONTENT_STATUS.DRAFT),
  ownerUserId: uuid('owner_user_id'),
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
  partOfSpeech: varchar('part_of_speech', { length: 32 }).$type<PartOfSpeech>().notNull(),
}, (t) => [
  unique('word_types_id_word_id_key').on(t.id, t.wordId),
  unique('word_types_word_id_part_of_speech_key').on(t.wordId, t.partOfSpeech),
]);

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
  cefrLevel: varchar('cefr_level', { length: 2 }).$type<CefrLevel>(),
  coreDefinition: text('core_definition'),
  origin: varchar('origin', { length: 16 }).$type<MeaningOrigin>().notNull().default(MEANING_ORIGIN.CURATED),
  createdByUserId: uuid('created_by_user_id'),
  ownerUserId: uuid('owner_user_id'),
  reviewedByUserId: uuid('reviewed_by_user_id'),
  reviewedAt: ts('reviewed_at'),
  lexicalDraftId: uuid('lexical_draft_id'),
  draftSenseIndex: smallint('draft_sense_index'),
  createdAt: createdAt(),
}, (t) => [unique('meanings_lexical_draft_id_draft_sense_index_key').on(t.lexicalDraftId, t.draftSenseIndex)]);

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
  editorialState: varchar('editorial_state', { length: 16 }).$type<EditorialState>().notNull().default(EDITORIAL_STATE.DRAFT),
  origin: varchar('origin', { length: 16 }).$type<MeaningOrigin>().notNull().default(MEANING_ORIGIN.CURATED),
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

// Custom words: drafts are AI output and the only source of what enters the shared pool.
export const lexicalDrafts = pgTable('lexical_drafts', {
  id: id(),
  kind: varchar('kind', { length: 16 }).$type<LexicalDraftKind>().notNull(),
  language: varchar('language', { length: 16 }).notNull(),
  normalizedText: text('normalized_text').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  contextKey: text('context_key').notNull().default(''),
  meaningId: uuid('meaning_id'),
  ownerUserId: uuid('owner_user_id'),
  payload: jsonb('payload').notNull(),
  model: text('model').notNull(),
  createdAt: createdAt(),
}, (t) => [unique('lexical_drafts_language_normalized_text_locale_context_key_key').on(t.language, t.normalizedText, t.locale, t.contextKey)]);

export const userMeaningOverrides = pgTable('user_meaning_overrides', {
  userId: uuid('user_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  content: jsonb('content').notNull().$type<MeaningOverride>(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.meaningId, t.locale] })]);

export const customWordUsage = pgTable('custom_word_usage', {
  userId: uuid('user_id').notNull(),
  day: date('day').notNull(),
  lookups: integer('lookups').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day] })]);

// C. Curated practice: each row is one immutable content revision
export const practiceItems = pgTable('practice_items', {
  id: id(),
  template: varchar('template', { length: 24 }).$type<Template>().notNull(),
  variant: varchar('variant', { length: 40 }).$type<Variant>(),
  contextCefrLevel: varchar('context_cefr_level', { length: 2 }).$type<CefrLevel>(),
  sourceContent: jsonb('source_content').notNull(),
  sourceEvaluation: jsonb('source_evaluation').notNull(),
  status: varchar('status', { length: 16 }).$type<ItemStatus>().notNull().default(ITEM_STATUS.DRAFT),
  supersedesItemId: uuid('supersedes_item_id'),
  approvedAt: ts('approved_at'),
  createdAt: createdAt(),
}, (t) => [index('idx_practice_items_lookup').on(t.template, t.status)]);

export const practiceItemLocalizations = pgTable('practice_item_localizations', {
  practiceItemId: uuid('practice_item_id').notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  localizedContent: jsonb('localized_content').notNull().default({}).$type<Record<string, unknown>>(),
  contextualExplain: text('contextual_explain'),
  editorialState: varchar('editorial_state', { length: 16 }).$type<EditorialState>().notNull().default(EDITORIAL_STATE.DRAFT),
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

// D. One session is one practice-history row; plan and raw_events are purgeable, result is kept
export const learningSessions = pgTable('learning_sessions', {
  id: id(),
  userId: uuid('user_id').notNull(),
  mode: varchar('mode', { length: 24 }).$type<SessionMode>().notNull(),
  status: varchar('status', { length: 16 }).$type<SessionStatus>().notNull().default(SESSION_STATUS.ISSUED),
  scopeSnapshot: jsonb('scope_snapshot').notNull().default({}).$type<{ challengeId?: string; [key: string]: unknown }>(),
  planVersion: varchar('plan_version', { length: 40 }).notNull(),
  policyVersions: jsonb('policy_versions').notNull().default({}),
  issuedAt: ts('issued_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  committedAt: ts('committed_at'),
  commitRequestSha256: char('commit_request_sha256', { length: 64 }),
  commitResponse: jsonb('commit_response'),
  plan: jsonb('plan').$type<SessionPlan>(),
  rawEvents: jsonb('raw_events'),
  result: jsonb('result'),
}, (t) => [
  unique('learning_sessions_id_user_id_key').on(t.id, t.userId),
  index('idx_sessions_user_issued').on(t.userId, t.issuedAt.desc()),
]);

export const speechAssessmentReceipts = pgTable('speech_assessment_receipts', {
  id: id(),
  sessionId: uuid('session_id').notNull(),
  taskId: uuid('task_id').notNull(),
  validity: varchar('validity', { length: 12 }).$type<Validity>().notNull(),
  passed: boolean('passed'),
  accuracyScore: numeric('accuracy_score', { precision: 5, scale: 2, mode: 'number' }),
  providerMeta: jsonb('provider_meta').notNull().default({}),
  assessedAt: ts('assessed_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  consumedAt: ts('consumed_at'),
}, (t) => [index('idx_speech_receipts_expiry').on(t.expiresAt), index('idx_speech_receipts_task').on(t.sessionId, t.taskId)]);

// E. Cross-session learning state and evidence
export const userMeaningProgress = pgTable('user_meaning_progress', {
  userId: uuid('user_id').notNull(),
  meaningId: uuid('meaning_id').notNull(),
  learnedAt: ts('learned_at').notNull(),
  learnedSessionId: uuid('learned_session_id'),
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
  signal: varchar('signal', { length: 24 }).$type<MemorySignal>().notNull(),
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
  skill: varchar('skill', { length: 12 }).$type<Skill>().notNull(),
  reasons: jsonb('reasons').notNull().$type<EvidenceReason[]>(),
  validity: varchar('validity', { length: 12 }).$type<Validity>().notNull(),
  passed: boolean('passed'),
  meaningId: uuid('meaning_id'),
  pronunciationId: uuid('pronunciation_id'),
  assessedAt: ts('assessed_at').notNull(),
  committedAt: ts('committed_at').notNull(),
  assessmentReceiptId: uuid('assessment_receipt_id'),
  evaluatorVersion: varchar('evaluator_version', { length: 40 }).notNull(),
}, (t) => [unique('skill_evidence_session_id_task_id_target_ordinal_skill_key').on(t.sessionId, t.taskId, t.targetOrdinal, t.skill)]);

// F. Checkpoint challenge snapshots, one per N learning sessions
export const checkpointChallenges = pgTable('checkpoint_challenges', {
  id: id(),
  userId: uuid('user_id').notNull(),
  sequence: integer('sequence').notNull(),
  state: varchar('state', { length: 16 }).$type<CheckpointState>().notNull().default(CHECKPOINT_STATE.AVAILABLE),
  completedSessionId: uuid('completed_session_id'),
  createdAt: createdAt(),
}, (t) => [unique('checkpoint_challenges_user_id_sequence_key').on(t.userId, t.sequence)]);

export const checkpointChallengeMeanings = pgTable('checkpoint_challenge_meanings', {
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
