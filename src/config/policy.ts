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
  // Legacy: no new challenges are generated and nothing gates Daily; the Challenge Map replaces them.
  checkpoint: { defaultSessionsPerChallenge: 7, maxSessionsPerChallenge: 7 },
  journey: { defaultHistorySegments: 2, maxHistorySegments: 10, defaultFutureSegments: 1, maxFutureSegments: 3 },
  // Match Madness [TRIAL]: recognition practice only, never SRS or skill evidence. Bump `version` when any value changes.
  challenge: {
    version: 'match-madness-trial-v1',
    chapterNewMeaningCount: 12,
    chapterReviewMeaningCount: 3,
    // Bounds one candidate read; dedup by word and gloss only drops a few rows.
    candidateScanLimit: 500,
    timeLimitMs: 90_000,
    issuedRunTtlMinutes: 15,
    startedRunCommitTtlMinutes: 15,
    maxMatchEvents: 200,
    // Client elapsed time may run ahead of server time since start by at most this (network and clock jitter).
    clockSlackMs: 5_000,
    maxOccurrencesPerMeaning: 2,
    minMatchesBetweenRepeats: 3,
    eventsRetentionDays: 90,
    score: { match: 100, streakStep: 10, maxStreakSteps: 5, mistake: 20, perSecondLeft: 5 },
    // 1 star is any clear; a tier needs both its time and its mistake bound.
    levels: [
      { levelNo: 1, targetMatches: 8, visiblePairs: 3, coreCount: 8, useReview: false,
        stars: { two: { maxElapsedMs: 80_000, maxMistakes: 2 }, three: { maxElapsedMs: 60_000, maxMistakes: 0 } } },
      { levelNo: 2, targetMatches: 12, visiblePairs: 4, coreCount: 12, useReview: false,
        stars: { two: { maxElapsedMs: 80_000, maxMistakes: 3 }, three: { maxElapsedMs: 60_000, maxMistakes: 1 } } },
      { levelNo: 3, targetMatches: 16, visiblePairs: 5, coreCount: 12, useReview: true,
        stars: { two: { maxElapsedMs: 80_000, maxMistakes: 3 }, three: { maxElapsedMs: 65_000, maxMistakes: 1 } } },
    ],
  },
  // A level passes at this ratio; the result is the highest level with every level below it passed too.
  placement: { questionsPerLevel: 3, minCorrectRatio: 0.6 },
  customWords: { maxRoadmapWords: 500, dailyLookups: 30, maxTextLength: 64, maxContextLength: 200, maxMeaningsPerWord: 8, maxSensesPerDraft: 3 },
} as const;
