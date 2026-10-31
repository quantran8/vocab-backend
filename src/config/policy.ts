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
  review: { semanticWeight: 2, skillWeight: 1, skillBonusChance: 0.3, audioChance: 0.5, matchChance: 0.3, candidateMultiplier: 3 },
  newLearning: { selectOptionCount: 4, recallTypingWeight: 0.5, matchPairCount: 4 },
  priming: { windowTasks: 1 },
  srs: {
    initialUnaidedHours: 48,
    initialAssistedHours: 24,
    initialFailedHours: 12,
    failedRecognitionDelayHours: 24,
    recognitionGraceHours: 24,
    assistedFollowUpHours: 24,
    failedRecallIntervalHours: 12,
    baseGrowth: 1.6,
    streakBonus: 0.15,
    maxGrowth: 2.2,
    minIntervalHours: 48,
    maxIntervalHours: 90 * HOURS_PER_DAY,
  },
  skill: { requiredSessions: 2, delayedRecheckHours: HOURS_PER_DAY },
  speech: { passAccuracy: 80, receiptTtlHours: 72, maxAudioBytes: 2 * 1024 * 1024 },
  weak: { lookbackDays: 30, minAttempts: 3 },
} as const;
