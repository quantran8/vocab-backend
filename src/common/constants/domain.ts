export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const MEANING_POPULARITY = { MIN: 0, MAX: 100 } as const;

export const TEMPLATE = {
  SELECT: 'select',
  MATCH: 'match',
  CLOZE_SELECT: 'cloze_select',
  TYPING: 'typing',
  FLY_REORDER: 'fly_reorder',
  SURGERY: 'surgery',
  RECORDING: 'recording',
} as const;
export type Template = (typeof TEMPLATE)[keyof typeof TEMPLATE];
export const TEMPLATES = Object.values(TEMPLATE);

export const VARIANT = {
  GLOSS: 'gloss',
  REVERSE_GLOSS: 'reverse_gloss',
  MEANING_CLASH: 'meaning_clash',
  PHONETIC_CHOICE: 'phonetic_choice',
  STRESS_CHOICE: 'stress_choice',
  MEANING_PAIRS: 'meaning_pairs',
  WORD_PAIRS: 'word_pairs',
  SINGLE_BLANK: 'single_blank',
  CONTEXT_MEANING: 'context_meaning',
  MEANING_RECALL: 'meaning_recall',
  TRANSCRIPTION: 'transcription',
  SPELLING_RECALL: 'spelling_recall',
  FIX_SPELLING: 'fix_spelling',
  SCRIPTED_PRONUNCIATION: 'scripted_pronunciation',
} as const;
export type Variant = (typeof VARIANT)[keyof typeof VARIANT];
export const VARIANTS = Object.values(VARIANT);

export const TEMPLATE_VARIANTS: Record<Template, readonly Variant[]> = {
  [TEMPLATE.SELECT]: [VARIANT.GLOSS, VARIANT.REVERSE_GLOSS, VARIANT.MEANING_CLASH, VARIANT.PHONETIC_CHOICE, VARIANT.STRESS_CHOICE],
  [TEMPLATE.MATCH]: [VARIANT.MEANING_PAIRS, VARIANT.WORD_PAIRS],
  [TEMPLATE.CLOZE_SELECT]: [VARIANT.SINGLE_BLANK, VARIANT.CONTEXT_MEANING],
  [TEMPLATE.TYPING]: [VARIANT.MEANING_RECALL, VARIANT.TRANSCRIPTION],
  [TEMPLATE.FLY_REORDER]: [VARIANT.SPELLING_RECALL, VARIANT.TRANSCRIPTION],
  [TEMPLATE.SURGERY]: [VARIANT.FIX_SPELLING],
  [TEMPLATE.RECORDING]: [VARIANT.SCRIPTED_PRONUNCIATION],
};

export const PART_OF_SPEECH = {
  NOUN: 'noun',
  VERB: 'verb',
  ADJECTIVE: 'adjective',
  ADVERB: 'adverb',
  PRONOUN: 'pronoun',
  PREPOSITION: 'preposition',
  CONJUNCTION: 'conjunction',
  INTERJECTION: 'interjection',
  PHRASAL_VERB: 'phrasal_verb',
} as const;
export type PartOfSpeech = (typeof PART_OF_SPEECH)[keyof typeof PART_OF_SPEECH];
export const PARTS_OF_SPEECH = Object.values(PART_OF_SPEECH);

export const PROMPT_TYPE = { TEXT: 'text', AUDIO: 'audio' } as const;
export type PromptType = (typeof PROMPT_TYPE)[keyof typeof PROMPT_TYPE];

export const SESSION_MODE = {
  DAILY: 'daily',
  CHECKPOINT_CHALLENGE: 'checkpoint_challenge',
  RANDOM_PRACTICE: 'random_practice',
  WEAK_WORDS_PRACTICE: 'weak_words_practice',
} as const;
export type SessionMode = (typeof SESSION_MODE)[keyof typeof SESSION_MODE];
export const SESSION_MODES = Object.values(SESSION_MODE);

export const SESSION_STATUS = { ISSUED: 'issued', COMMITTED: 'committed', EXPIRED: 'expired' } as const;
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export const TASK_PHASE = {
  DUE_REVIEW: 'due_review',
  NEW_PRACTICE: 'new_practice',
  // Optional recall before a Learn card: answered unaided, the word is learned without teaching.
  KNOWN_CHECK: 'known_check',
  CHECKPOINT_CHALLENGE: 'checkpoint_challenge',
  RANDOM_PRACTICE: 'random_practice',
  WEAK_WORDS_PRACTICE: 'weak_words_practice',
} as const;
export type TaskPhase = (typeof TASK_PHASE)[keyof typeof TASK_PHASE];

export const MEMORY_SIGNAL = {
  UNAIDED_RECALL: 'unaided_recall',
  ASSISTED_RECALL: 'assisted_recall',
  FAILED_RECALL: 'failed_recall',
  RECOGNITION_SUCCESS: 'recognition_success',
  FAILED_RECOGNITION: 'failed_recognition',
} as const;
export type MemorySignal = (typeof MEMORY_SIGNAL)[keyof typeof MEMORY_SIGNAL];

export const SKILL = {
  LISTENING: 'listening',
  SPEAKING: 'speaking',
  READING: 'reading',
  WRITING: 'writing',
} as const;
export type Skill = (typeof SKILL)[keyof typeof SKILL];
export const SKILLS = Object.values(SKILL);

export const SKILL_STATUS = {
  NOT_VERIFIED: 'not_verified',
  DEMONSTRATED: 'demonstrated',
  VERIFIED: 'verified',
} as const;
export type SkillStatus = (typeof SKILL_STATUS)[keyof typeof SKILL_STATUS];

/** Why an evidence row is not direct; an empty list means direct. */
export const SKILL_ISSUE = {
  FAILED: 'failed',
  ASSISTED: 'assisted',
} as const;
export type SkillIssue = (typeof SKILL_ISSUE)[keyof typeof SKILL_ISSUE];

export const EVIDENCE_REASON = {
  NEW_PRACTICE: 'new_practice',
  HINTED: 'hinted',
  REVEALED: 'revealed',
  RETRIED: 'retried',
  PRIMED: 'primed',
  WEAK_TEMPLATE: 'weak_template',
  QUALITY_UNQUALIFIED: 'quality_unqualified',
  AUDIO_NOT_PLAYED: 'audio_not_played',
  INVALID_RECORDING: 'invalid_recording',
  // Only on rows backfilled by migration 0010 whose plan was already cleared.
  UNKNOWN: 'unknown',
} as const;
export type EvidenceReason = (typeof EVIDENCE_REASON)[keyof typeof EVIDENCE_REASON];

export const VALIDITY = { VALID: 'valid', INVALID: 'invalid' } as const;
export type Validity = (typeof VALIDITY)[keyof typeof VALIDITY];

export const DELIVERY_MODE = { AUDIO: 'audio', FALLBACK: 'fallback', NONE: 'none' } as const;
export type DeliveryMode = (typeof DELIVERY_MODE)[keyof typeof DELIVERY_MODE];

export const EVENT_ACTION = {
  SUBMIT: 'submit',
  PAIR: 'pair',
  TAP_TILE: 'tap_tile',
  REMOVE_TILE: 'remove_tile',
  MOVE_TILE: 'move_tile',
  HINT: 'hint',
  REVEAL: 'reveal',
  ASSESSED: 'assessed',
  UNAVAILABLE: 'unavailable',
  TRANSCRIBED: 'transcribed',
} as const;
export type EventAction = (typeof EVENT_ACTION)[keyof typeof EVENT_ACTION];

// What a task proves, independent of template and prompt modality (AR-15).
export const ASSESSMENT_INTENT = {
  MEANING_RECOGNITION: 'meaning_recognition',
  MEANING_RECALL: 'meaning_recall',
  TRANSCRIPTION: 'transcription',
  SOUND_DISCRIMINATION: 'sound_discrimination',
  SPELLING_REPAIR: 'spelling_repair',
  PRONUNCIATION: 'pronunciation',
  PAIRING: 'pairing',
} as const;
export type AssessmentIntent = (typeof ASSESSMENT_INTENT)[keyof typeof ASSESSMENT_INTENT];

export const OUTCOME = {
  CORRECT: 'correct',
  INCORRECT: 'incorrect',
  CORRECTED_AFTER_RETRY: 'corrected_after_retry',
  REVEALED: 'revealed',
  ASSESSED_PASSED: 'assessed_passed',
  ASSESSED_FAILED: 'assessed_failed',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
} as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

// Commit summary groups (results screen). Values are the JSON keys of `summary.*.groups`, so they stay camelCase.
export const REVIEW_GROUP = { SOLID: 'solid', SHAKY: 'shaky', RELEARN: 'relearn' } as const;
export type ReviewGroup = (typeof REVIEW_GROUP)[keyof typeof REVIEW_GROUP];
export const REVIEW_GROUPS = Object.values(REVIEW_GROUP);

export const NEW_WORD_GROUP = { SMOOTH: 'smooth', RETRIED: 'retried', REVEALED: 'revealed', KNOWN: 'known' } as const;
export type NewWordGroup = (typeof NEW_WORD_GROUP)[keyof typeof NEW_WORD_GROUP];
export const NEW_WORD_GROUPS = Object.values(NEW_WORD_GROUP);

export const PRACTICE_GROUP = { CLEAN: 'clean', HELPED: 'helped', MISSED: 'missed' } as const;
export type PracticeGroup = (typeof PRACTICE_GROUP)[keyof typeof PRACTICE_GROUP];
export const PRACTICE_GROUPS = Object.values(PRACTICE_GROUP);

export const SKILL_CHANGE = { LEVELED_UP: 'leveledUp', CLEARED: 'cleared', PENDING_CONFIRM: 'pendingConfirm', REGRESSED: 'regressed' } as const;
export type SkillChange = (typeof SKILL_CHANGE)[keyof typeof SKILL_CHANGE];
export const SKILL_CHANGES = Object.values(SKILL_CHANGE);

/** Why a word landed in a weaker group: the answer that decided it. Shown per word on the results sheet. */
export const RESULT_CAUSE = {
  HINTED: 'hinted',
  RETRIED: 'retried',
  PRIMED: 'primed',
  RECOGNIZED_ONLY: 'recognized_only',
  REVEALED: 'revealed',
  OUT_OF_TRIES: 'out_of_tries',
  WRONG_CHOICE: 'wrong_choice',
  NOT_PASSED: 'not_passed',
} as const;
export type ResultCause = (typeof RESULT_CAUSE)[keyof typeof RESULT_CAUSE];

export const CONTENT_STATUS = { DRAFT: 'draft', PUBLISHED: 'published', ARCHIVED: 'archived' } as const;
export type ContentStatus = (typeof CONTENT_STATUS)[keyof typeof CONTENT_STATUS];
export const EDITORIAL_STATE = { DRAFT: 'draft', APPROVED: 'approved' } as const;
export type EditorialState = (typeof EDITORIAL_STATE)[keyof typeof EDITORIAL_STATE];
export const ITEM_STATUS = { DRAFT: 'draft', APPROVED: 'approved', PUBLISHED: 'published', RETIRED: 'retired' } as const;
export type ItemStatus = (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS];
export const CHECKPOINT_STATE = { AVAILABLE: 'available', COMPLETED: 'completed' } as const;
export type CheckpointState = (typeof CHECKPOINT_STATE)[keyof typeof CHECKPOINT_STATE];

export const JOURNEY_NODE_TYPE = { LEARNING: 'learning', REVIEW: 'review' } as const;
export type JourneyNodeType = (typeof JOURNEY_NODE_TYPE)[keyof typeof JOURNEY_NODE_TYPE];
export const JOURNEY_NODE_STATE = { LOCKED: 'locked', CURRENT: 'current', COMPLETED: 'completed' } as const;
export type JourneyNodeState = (typeof JOURNEY_NODE_STATE)[keyof typeof JOURNEY_NODE_STATE];
export const JOURNEY_SEGMENT_STATUS = { COMPLETED: 'completed', ACTIVE: 'active', PREVIEW: 'preview' } as const;
export type JourneySegmentStatus = (typeof JOURNEY_SEGMENT_STATUS)[keyof typeof JOURNEY_SEGMENT_STATUS];

export const GAME_MODE = { MATCH_MADNESS: 'match_madness' } as const;
export type GameMode = (typeof GAME_MODE)[keyof typeof GAME_MODE];
export const CHALLENGE_ROLE = { CORE: 'core', REVIEW: 'review' } as const;
export type ChallengeRole = (typeof CHALLENGE_ROLE)[keyof typeof CHALLENGE_ROLE];
export const CHALLENGE_RUN_STATUS = {
  ISSUED: 'issued', STARTED: 'started', COMMITTED: 'committed', ABANDONED: 'abandoned', EXPIRED: 'expired',
} as const;
export type ChallengeRunStatus = (typeof CHALLENGE_RUN_STATUS)[keyof typeof CHALLENGE_RUN_STATUS];
export const CHALLENGE_OPEN_STATUSES = [CHALLENGE_RUN_STATUS.ISSUED, CHALLENGE_RUN_STATUS.STARTED] as const;
export const CHALLENGE_ENDED_REASON = { GOAL_REACHED: 'goal_reached', TIME_UP: 'time_up', QUIT: 'quit' } as const;
export type ChallengeEndedReason = (typeof CHALLENGE_ENDED_REASON)[keyof typeof CHALLENGE_ENDED_REASON];
export const CHALLENGE_EVENT_TYPE = { MATCH: 'match' } as const;
export const CHALLENGE_OUTCOME = { CLEARED: 'cleared', FAILED: 'failed', QUIT: 'quit' } as const;
export type ChallengeOutcome = (typeof CHALLENGE_OUTCOME)[keyof typeof CHALLENGE_OUTCOME];
export const CHALLENGE_CHAPTER_STATE = { ACTIVE: 'active', COMPLETED: 'completed', CONTENT_UNAVAILABLE: 'content_unavailable' } as const;
export type ChallengeChapterState = (typeof CHALLENGE_CHAPTER_STATE)[keyof typeof CHALLENGE_CHAPTER_STATE];
export const CHALLENGE_NEXT_CHAPTER_STATE = { LOCKED: 'locked', NEEDS_VOCABULARY: 'needs_vocabulary', READY: 'ready' } as const;
export type ChallengeNextChapterState = (typeof CHALLENGE_NEXT_CHAPTER_STATE)[keyof typeof CHALLENGE_NEXT_CHAPTER_STATE];
export const CHALLENGE_LEVEL_STATE = { LOCKED: 'locked', AVAILABLE: 'available', CLEARED: 'cleared' } as const;
export type ChallengeLevelState = (typeof CHALLENGE_LEVEL_STATE)[keyof typeof CHALLENGE_LEVEL_STATE];
export const CHALLENGE_UNLOCK = { LEVEL: 'level', CHAPTER_READY: 'chapter_ready', NEEDS_VOCABULARY: 'needs_vocabulary', NONE: 'none' } as const;
export type ChallengeUnlock = (typeof CHALLENGE_UNLOCK)[keyof typeof CHALLENGE_UNLOCK];
export const CHALLENGE_NEXT_ACTION = { PLAY_NEXT_LEVEL: 'play_next_level', OPEN_MAP: 'open_map', LEARN_MORE: 'learn_more', RETRY: 'retry' } as const;
export type ChallengeNextAction = (typeof CHALLENGE_NEXT_ACTION)[keyof typeof CHALLENGE_NEXT_ACTION];
export const TILE_SIDE = { WORD: 'word', MEANING: 'meaning' } as const;
export type TileSide = (typeof TILE_SIDE)[keyof typeof TILE_SIDE];

export const ADMIN_ROLE = { EDITOR: 'editor', ADMIN: 'admin' } as const;
export const ADMIN_ROLES = [ADMIN_ROLE.EDITOR, ADMIN_ROLE.ADMIN] as const;
export const ASSIGNABLE_ROLES = [ADMIN_ROLE.EDITOR] as const;

export const MEANING_ORIGIN = { CURATED: 'curated', AI_GENERATED: 'ai_generated' } as const;
export type MeaningOrigin = (typeof MEANING_ORIGIN)[keyof typeof MEANING_ORIGIN];

export const LEXICAL_DRAFT_KIND = { WORD: 'word', MEANING: 'meaning', TRANSLATION: 'translation' } as const;
export type LexicalDraftKind = (typeof LEXICAL_DRAFT_KIND)[keyof typeof LEXICAL_DRAFT_KIND];

export const CUSTOM_WORD_LOOKUP_RESULT = {
  EXISTING: 'existing',
  DRAFT: 'draft',
  NEW_MEANING_DRAFT: 'new_meaning_draft',
  INVALID: 'invalid',
} as const;

export const CUSTOM_MEANING_STATUS = { AVAILABLE: 'available', TRANSLATION_DRAFT: 'translation_draft', UNAVAILABLE: 'unavailable' } as const;
export type CustomMeaningStatus = (typeof CUSTOM_MEANING_STATUS)[keyof typeof CUSTOM_MEANING_STATUS];

export const AI_MEANING_SCOPE = { ALL: 'all', SHARED: 'shared', PRIVATE: 'private' } as const;
export type AiMeaningScope = (typeof AI_MEANING_SCOPE)[keyof typeof AI_MEANING_SCOPE];

export const PERSONAL_COLLECTION_SLUG = 'personal';

export const SCOPE_STATUS = { OK: 'ok', LOW: 'low', EXHAUSTED: 'exhausted' } as const;
export type ScopeStatus = (typeof SCOPE_STATUS)[keyof typeof SCOPE_STATUS];

/** Why a daily session has fewer new words than the goal. CHECKPOINT_GATE is reserved: nothing gates Daily yet. */
export const NEW_WORD_REASON = {
  GOAL: 'goal',
  USER_OVERRIDE: 'user_override',
  AUTO_BALANCED: 'auto_balanced',
  CHECKPOINT_GATE: 'checkpoint_gate',
  SCOPE_LIMITED: 'scope_limited',
  SCOPE_EXHAUSTED: 'scope_exhausted',
  REVIEW_ONLY: 'review_only',
} as const;
export type NewWordReason = (typeof NEW_WORD_REASON)[keyof typeof NEW_WORD_REASON];
export type WithheldReason = Exclude<NewWordReason, typeof NEW_WORD_REASON.GOAL>;

export const NEW_WORD_OVERRIDE_MODE = { UNTIL_DATE: 'until_date', UNTIL_BACKLOG_CLEAR: 'until_backlog_clear' } as const;
export type NewWordOverrideMode = (typeof NEW_WORD_OVERRIDE_MODE)[keyof typeof NEW_WORD_OVERRIDE_MODE];
export const NEW_WORD_OVERRIDE_MODES = Object.values(NEW_WORD_OVERRIDE_MODE);

export const NEW_WORDS_BLOCKED_REASON = { SCOPE_EXHAUSTED: 'scope_exhausted', CHECKPOINT_GATE: 'checkpoint_gate' } as const;
export type NewWordsBlockedReason = (typeof NEW_WORDS_BLOCKED_REASON)[keyof typeof NEW_WORDS_BLOCKED_REASON];

export const PLAN_VERSION = 'plan-v0.4';
export const EVALUATOR_VERSION = 'eval-v0.4';
export const SCHEDULER_VERSION = 'srs-trial-v0.5';
export const EVENT_SCHEMA_VERSION = 1;

export const DEFAULT_LOCALE = 'vi-VN';
export const DEFAULT_ACCENT = 'en-US';
export const LEARNING_LANGUAGE = 'en';

// Ranking & Tier v1.2: LP ledger, lifetime Tier, opt-in weekly ranking. See memory ranking-tier.
export const LP_AWARD_TYPE = {
  NEW_MEANING_COMPLETED: 'new_meaning_completed',
  DUE_REVIEW_COMPLETED: 'due_review_completed',
  EXTRA_PRACTICE_COMPLETED: 'extra_practice_completed',
} as const;
export type LpAwardType = (typeof LP_AWARD_TYPE)[keyof typeof LP_AWARD_TYPE];

export const CONTENT_PROVENANCE = { CATALOG: 'catalog', CUSTOM_OWNED: 'custom_owned' } as const;
export type ContentProvenance = (typeof CONTENT_PROVENANCE)[keyof typeof CONTENT_PROVENANCE];

export const TIER_KEY = {
  FIRST_STEPS: 'first_steps',
  IN_MOTION: 'in_motion',
  BUILDING_UP: 'building_up',
  STEADY_EFFORT: 'steady_effort',
  COMMITTED: 'committed',
  DEDICATED: 'dedicated',
  LASTING_MARK: 'lasting_mark',
} as const;
export type TierKey = (typeof TIER_KEY)[keyof typeof TIER_KEY];

export const TIER_UNLOCK_SOURCE = { LIVE: 'live', BACKFILL: 'backfill', POLICY_MIGRATION: 'policy_migration' } as const;
export type TierUnlockSource = (typeof TIER_UNLOCK_SOURCE)[keyof typeof TIER_UNLOCK_SOURCE];

export const AVATAR_KEY = {
  SYLLIE_SUNNY: 'syllie_sunny',
  SYLLIE_SLEEPY: 'syllie_sleepy',
  SYLLIE_CURIOUS: 'syllie_curious',
  SYLLIE_BRAVE: 'syllie_brave',
  SYLLIE_CALM: 'syllie_calm',
  SYLLIE_CHEERFUL: 'syllie_cheerful',
  SYLLIE_THINKER: 'syllie_thinker',
  SYLLIE_EXPLORER: 'syllie_explorer',
  SYLLIE_READER: 'syllie_reader',
  SYLLIE_ARTIST: 'syllie_artist',
  SYLLIE_SPORTY: 'syllie_sporty',
  SYLLIE_STARRY: 'syllie_starry',
} as const;
export type AvatarKey = (typeof AVATAR_KEY)[keyof typeof AVATAR_KEY];
export const AVATAR_KEYS = Object.values(AVATAR_KEY);

export const REPORT_REASON = {
  OFFENSIVE_NAME: 'offensive_name',
  IMPERSONATION: 'impersonation',
  SUSPICIOUS_ACTIVITY: 'suspicious_activity',
  OTHER: 'other',
} as const;
export type ReportReason = (typeof REPORT_REASON)[keyof typeof REPORT_REASON];
export const REPORT_REASONS = Object.values(REPORT_REASON);

export const REPORT_RESOLUTION = { USERNAME_RESET: 'username_reset', RANKING_INELIGIBLE: 'ranking_ineligible', DISMISSED: 'dismissed' } as const;
export type ReportResolution = (typeof REPORT_RESOLUTION)[keyof typeof REPORT_RESOLUTION];
export const REPORT_RESOLUTIONS = Object.values(REPORT_RESOLUTION);
export const REPORT_STATUS = { OPEN: 'open', RESOLVED: 'resolved' } as const;

export const RANKING_POSITION_KIND = { RANK: 'rank', PERCENTILE: 'percentile', UNRANKED: 'unranked' } as const;
export type RankingPositionKind = (typeof RANKING_POSITION_KIND)[keyof typeof RANKING_POSITION_KIND];
export const LEADERBOARD_VIEW = { TOP: 'top', AROUND: 'around' } as const;
