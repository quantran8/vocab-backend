import { TEMPLATE } from '../common/constants/domain';
import { HOURS_PER_DAY } from '../common/constants/time';

// Every [TRIAL] value from the spec; tune here, not at call sites.
export const POLICY = {
  version: 'policy-trial-v0.4',
  session: {
    ttlHours: 72,
    retentionHours: 30 * HOURS_PER_DAY,
    reviewCap: 10,
    practiceTaskCap: 10,
    maxEventsPerTask: 200,
    maxTasksPerCommit: 500,
    distractorPoolSize: 200,
    commitTimeoutMs: 15_000,
  },
  // Supabase allows access tokens to live up to a week.
  account: { deletedIdentityRetentionHours: 7 * HOURS_PER_DAY },
  review: { semanticWeight: 2, skillWeight: 1, skillBonusChance: 0.3, audioChance: 0.5, matchChance: 0.3, candidateMultiplier: 3 },
  newLearning: { introBatchSize: 3, selectOptionCount: 4, recallTypingWeight: 0.5, matchPairCount: 4 },
  practice: {
    // Retries after a wrong answer before the app moves on. match counts per left item; recording counts speech assessments.
    maxRetries: {
      [TEMPLATE.SELECT]: 1,
      [TEMPLATE.CLOZE_SELECT]: 1,
      [TEMPLATE.MATCH]: 1,
      [TEMPLATE.TYPING]: 2,
      [TEMPLATE.FLY_REORDER]: 2,
      [TEMPLATE.SURGERY]: 2,
      [TEMPLATE.RECORDING]: 2,
    },
  },
  priming: { windowTasks: 1 },
  srs: {
    initialUnaidedHours: 48,
    initialAssistedHours: 24,
    initialFailedHours: 12,
    failedRecognitionDelayHours: 24,
    recognitionGraceHours: 24,
    assistedFollowUpHours: 24,
    failedRecallIntervalHours: 12,
    weakenedIntervalFactor: 0.5,
    baseGrowth: 1.6,
    streakBonus: 0.15,
    maxGrowth: 2.2,
    minIntervalHours: 48,
    maxIntervalHours: 90 * HOURS_PER_DAY,
  },
  memory: { lightRetryAttempts: 2, recoveryHours: 12 },
  skill: { requiredSessions: 2, delayedRecheckHours: HOURS_PER_DAY },
  speech: { passAccuracy: 80, receiptTtlHours: 72, maxAudioBytes: 2 * 1024 * 1024 },
  weak: { lookbackDays: 30, minAttempts: 3 },
  checkpoint: { sessionsPerChallenge: 7 },
  // A level passes at this ratio; the result is the highest level with every level below it passed too.
  placement: { questionsPerLevel: 3, minCorrectRatio: 0.6 },
  customWords: { maxRoadmapWords: 500, dailyLookups: 30, maxTextLength: 64, maxContextLength: 200, maxMeaningsPerWord: 8, maxSensesPerDraft: 3 },
} as const;
