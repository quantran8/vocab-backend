export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

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

export const SKILL_STATUS = {
  NOT_VERIFIED: 'not_verified',
  DEMONSTRATED: 'demonstrated',
  VERIFIED: 'verified',
} as const;
export type SkillStatus = (typeof SKILL_STATUS)[keyof typeof SKILL_STATUS];

/** Why an evidence row is not direct; an empty list means direct. */
export const EVIDENCE_REASON = {
  NEW_PRACTICE: 'new_practice',
  HINTED: 'hinted',
  REVEALED: 'revealed',
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

export const CONTENT_STATUS = { DRAFT: 'draft', PUBLISHED: 'published', ARCHIVED: 'archived' } as const;
export type ContentStatus = (typeof CONTENT_STATUS)[keyof typeof CONTENT_STATUS];
export const EDITORIAL_STATE = { DRAFT: 'draft', APPROVED: 'approved' } as const;
export type EditorialState = (typeof EDITORIAL_STATE)[keyof typeof EDITORIAL_STATE];
export const ITEM_STATUS = { DRAFT: 'draft', APPROVED: 'approved', PUBLISHED: 'published', RETIRED: 'retired' } as const;
export type ItemStatus = (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS];
export const CHECKPOINT_STATE = { AVAILABLE: 'available', COMPLETED: 'completed' } as const;
export type CheckpointState = (typeof CHECKPOINT_STATE)[keyof typeof CHECKPOINT_STATE];

export const ADMIN_ROLES = ['editor', 'admin'] as const;

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

export const PLAN_VERSION = 'plan-v0.4';
export const EVALUATOR_VERSION = 'eval-v0.4';
export const SCHEDULER_VERSION = 'srs-trial-v0.4';
export const EVENT_SCHEMA_VERSION = 1;

export const DEFAULT_LOCALE = 'vi-VN';
export const DEFAULT_ACCENT = 'en-US';
export const LEARNING_LANGUAGE = 'en';
