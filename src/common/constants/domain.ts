export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const TEMPLATE = {
  select: 'select',
  match: 'match',
  clozeSelect: 'clozeSelect',
  typing: 'typing',
  flyReorder: 'flyReorder',
  surgery: 'surgery',
  recording: 'recording',
} as const;
export type Template = (typeof TEMPLATE)[keyof typeof TEMPLATE];
export const TEMPLATES = Object.values(TEMPLATE);

export const VARIANT = {
  gloss: 'gloss',
  reverseGloss: 'reverseGloss',
  meaningClash: 'meaningClash',
  phoneticChoice: 'phoneticChoice',
  stressChoice: 'stressChoice',
  meaningPairs: 'meaningPairs',
  wordPairs: 'wordPairs',
  singleBlank: 'singleBlank',
  contextMeaning: 'contextMeaning',
  meaningRecall: 'meaningRecall',
  transcription: 'transcription',
  spellingRecall: 'spellingRecall',
  fixSpelling: 'fixSpelling',
  scriptedPronunciation: 'scriptedPronunciation',
} as const;
export type Variant = (typeof VARIANT)[keyof typeof VARIANT];

export const TEMPLATE_VARIANTS: Record<Template, readonly Variant[]> = {
  select: [VARIANT.gloss, VARIANT.reverseGloss, VARIANT.meaningClash, VARIANT.phoneticChoice, VARIANT.stressChoice],
  match: [VARIANT.meaningPairs, VARIANT.wordPairs],
  clozeSelect: [VARIANT.singleBlank, VARIANT.contextMeaning],
  typing: [VARIANT.meaningRecall, VARIANT.transcription],
  flyReorder: [VARIANT.spellingRecall, VARIANT.transcription],
  surgery: [VARIANT.fixSpelling],
  recording: [VARIANT.scriptedPronunciation],
};

export const PROMPT_TYPE = { text: 'text', audio: 'audio' } as const;
export type PromptType = (typeof PROMPT_TYPE)[keyof typeof PROMPT_TYPE];

export const SESSION_MODE = {
  daily: 'daily',
  weeklyChallenge: 'weeklyChallenge',
  randomPractice: 'randomPractice',
  weakWordsPractice: 'weakWordsPractice',
} as const;
export type SessionMode = (typeof SESSION_MODE)[keyof typeof SESSION_MODE];
export const SESSION_MODES = Object.values(SESSION_MODE);

export const SESSION_STATUS = { issued: 'issued', committed: 'committed', expired: 'expired' } as const;

export const TASK_PHASE = {
  dueReview: 'dueReview',
  newPractice: 'newPractice',
  weeklyChallenge: 'weeklyChallenge',
  randomPractice: 'randomPractice',
  weakWordsPractice: 'weakWordsPractice',
} as const;
export type TaskPhase = (typeof TASK_PHASE)[keyof typeof TASK_PHASE];

export const MEMORY_SIGNAL = {
  unaidedRecall: 'unaidedRecall',
  assistedRecall: 'assistedRecall',
  failedRecall: 'failedRecall',
  recognitionSuccess: 'recognitionSuccess',
  failedRecognition: 'failedRecognition',
} as const;
export type MemorySignal = (typeof MEMORY_SIGNAL)[keyof typeof MEMORY_SIGNAL];

export const SKILL = {
  listening: 'listening',
  speaking: 'speaking',
  reading: 'reading',
  writing: 'writing',
} as const;
export type Skill = (typeof SKILL)[keyof typeof SKILL];

export const SKILL_STATUS = {
  notVerified: 'notVerified',
  demonstrated: 'demonstrated',
  verified: 'verified',
} as const;
export type SkillStatus = (typeof SKILL_STATUS)[keyof typeof SKILL_STATUS];

export const DIRECTNESS = { direct: 'direct', supporting: 'supporting' } as const;
export type Directness = (typeof DIRECTNESS)[keyof typeof DIRECTNESS];

export const VALIDITY = { valid: 'valid', invalid: 'invalid' } as const;
export type Validity = (typeof VALIDITY)[keyof typeof VALIDITY];

export const DELIVERY_MODE = { audio: 'audio', fallback: 'fallback', none: 'none' } as const;
export type DeliveryMode = (typeof DELIVERY_MODE)[keyof typeof DELIVERY_MODE];

export const EVENT_ACTION = {
  submit: 'submit',
  pair: 'pair',
  tapTile: 'tapTile',
  removeTile: 'removeTile',
  moveTile: 'moveTile',
  hint: 'hint',
  reveal: 'reveal',
  assessed: 'assessed',
  unavailable: 'unavailable',
} as const;
export type EventAction = (typeof EVENT_ACTION)[keyof typeof EVENT_ACTION];

// What a task proves, independent of template and prompt modality (AR-15).
export const ASSESSMENT_INTENT = {
  meaningRecognition: 'meaningRecognition',
  meaningRecall: 'meaningRecall',
  transcription: 'transcription',
  soundDiscrimination: 'soundDiscrimination',
  spellingRepair: 'spellingRepair',
  pronunciation: 'pronunciation',
  pairing: 'pairing',
} as const;
export type AssessmentIntent = (typeof ASSESSMENT_INTENT)[keyof typeof ASSESSMENT_INTENT];

export const OUTCOME = {
  correct: 'correct',
  incorrect: 'incorrect',
  correctedAfterRetry: 'correctedAfterRetry',
  revealed: 'revealed',
  assessedPassed: 'assessedPassed',
  assessedFailed: 'assessedFailed',
  invalid: 'invalid',
  unavailable: 'unavailable',
} as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export const CONTENT_STATUS = { draft: 'draft', published: 'published', archived: 'archived' } as const;
export const EDITORIAL_STATE = { draft: 'draft', approved: 'approved' } as const;
export const ITEM_STATUS = { draft: 'draft', approved: 'approved', published: 'published', retired: 'retired' } as const;
export const WEEKLY_STATE = { available: 'available', completed: 'completed' } as const;

export const ADMIN_ROLES = ['editor', 'admin'] as const;

export const PLAN_VERSION = 'plan-v0.4';
export const EVALUATOR_VERSION = 'eval-v0.4';
export const SCHEDULER_VERSION = 'srs-trial-v0.4';
export const EVENT_SCHEMA_VERSION = 1;

export const DEFAULT_LOCALE = 'vi-VN';
export const DEFAULT_ACCENT = 'en-US';
export const LEARNING_LANGUAGE = 'en';
