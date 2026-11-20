import { EVIDENCE_CLASS, TEMPLATE, TIER_KEY } from '../common/constants/domain';
import { HOURS_PER_DAY } from '../common/constants/time';

// Every [TRIAL] value from the spec; tune here, not at call sites.
export const POLICY = {
  version: 'policy-trial-v0.4',
  session: {
    ttlHours: 72,
    retentionHours: 30 * HOURS_PER_DAY,
    // Reviews per daily session the learner may choose (min–max); unset follows dailyNewWordGoal, never below followMin.
    reviewsPerSession: { min: 1, max: 50, followMin: 5 },
    practiceTaskCap: 10,
    maxEventsPerTask: 200,
    maxTasksPerCommit: 500,
    distractorPoolSize: 200,
    commitTimeoutMs: 15_000,
  },
  // Supabase allows access tokens to live up to a week.
  account: { deletedIdentityRetentionHours: 7 * HOURS_PER_DAY },
  review: {
    semanticWeight: 2, skillWeight: 1, skillBonusChance: 0.3, audioChance: 0.5, matchChance: 0.3, candidateMultiplier: 3,
    // Daily: how often each evidence class is picked as a due word's one task [TRIAL].
    classPickWeight: {
      [EVIDENCE_CLASS.RECOGNIZE]: 2,
      [EVIDENCE_CLASS.RECOGNIZE_CONTEXT]: 2,
      [EVIDENCE_CLASS.RECALL_ASSEMBLED]: 1.5,
      [EVIDENCE_CLASS.RECALL_PRODUCE]: 1,
    },
    // Daily with speaking on: at most this many due words also get a recording [TRIAL].
    dailySpeakingCap: 5,
  },
  newLearning: { introBatchSize: 3, selectOptionCount: 4, recallTypingWeight: 0.5, matchPairCount: 4 },
  practice: {
    // Speaking mode: recordings per session [TRIAL].
    speakingTaskCap: 10,
    // Longer words get typing instead: tiles past this count render too small on the phone.
    flyReorderMaxTiles: 8,
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
  // FSRS-6 (open-spaced-repetition defaults); desiredRetention and the bounds are [TRIAL].
  fsrs: {
    w: [
      0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
      1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
    ] as readonly number[],
    desiredRetention: 0.9,
    minIntervalHours: 12,
    maxIntervalDays: 90,
    minStability: 0.001,
    maxStability: 36_500,
    // First stability of a word passed with "I know this" instead of being taught.
    knownInitialDays: 7,
  },
  // Weight of one clean correct answer as memory evidence, by evidence class [TRIAL].
  memoryEvidence: {
    weights: {
      [EVIDENCE_CLASS.RECALL_PRODUCE]: 1,
      [EVIDENCE_CLASS.RECALL_ASSEMBLED]: 0.7,
      [EVIDENCE_CLASS.RECOGNIZE_CONTEXT]: 0.4,
      [EVIDENCE_CLASS.RECOGNIZE]: 0.3,
    },
    // A target-audio prompt is harder than text; never above the next class up.
    audioFactor: 1.2,
    // Weights assume this many choices; fewer choices are easier to guess.
    baseOptionCount: 4,
    // Fast clean recall earns Easy; thresholds scale with the answer's length.
    easy: {
      [EVIDENCE_CLASS.RECALL_PRODUCE]: { baseMs: 3_000, perUnitMs: 600 },
      [EVIDENCE_CLASS.RECALL_ASSEMBLED]: { baseMs: 2_500, perUnitMs: 500 },
    },
    maxElapsedMs: 30 * 60_000,
  },
  memory: { lightRetryAttempts: 2 },
  speech: { passAccuracy: 80, receiptTtlHours: 72, maxAudioBytes: 2 * 1024 * 1024 },
  // Speaking progress [TRIAL]: on-device fluent after this many passing sessions in a row;
  // Azure fluent at an EWMA score >= fluentScore over minScoredSessions, back to practicing below slipScore.
  speaking: { deviceFluentStreak: 2, scoreAlpha: 0.4, fluentScore: 85, slipScore: 75, minScoredSessions: 2 },
  weak: { lookbackDays: 30, minAttempts: 3 },
  // Scope completion and review load [TRIAL] until the simulation in docs/DECISIONS.md settles them.
  reviewLoad: {
    version: 'scope-review-trial-v1',
    // Above this many due words Home shows the backlog line, and an until_backlog_clear override ends at or below it.
    backlogStatusThreshold: 10,
    backlogPromptThreshold: 20,
    backlogRepromptMultiplier: 2,
    autoBalanceFloor: 2,
    // Scope is "low" when it has fewer new words than this many weeks of sessions.
    scopeLowWeeks: 1,
    // Goal hint rows from the simulation; empty turns the hint off.
    routineEstimateTable: [] as readonly { newPerSession: number; daysUntilFullReview: number }[],
  },
  // Legacy: no new challenges are generated and nothing gates Daily; the Challenge Map replaces them.
  checkpoint: { defaultSessionsPerChallenge: 7, maxSessionsPerChallenge: 7 },
  journey: { defaultHistorySegments: 2, maxHistorySegments: 10, defaultFutureSegments: 1, maxFutureSegments: 3 },
  // Match Madness [TRIAL]: recognition practice only, never SRS or speaking progress. Bump `version` when any value changes.
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
  // Ranking & Tier v1.2 [TRIAL]: none of these is approved for launch. Bump a version when its values change.
  lp: {
    version: 'lp_effort_trial_v1',
    newMeaningLP: 5,
    dueReviewLP: 4,
    extraPracticeLP: 1,
    maxNewCustomMeaningsPerUtcDay: 5,
    minDueAwardGapHours: 20,
    maxDueAwardsPerMeaningRolling7d: 3,
    dueAwardWindowDays: 7,
    maxExtraPracticeLPPerUtcDay: 10,
    minQualifiedDayLP: 5,
  },
  tier: {
    // Tier depends on lifetime LP only. Active days are still counted (and sent) but gate nothing:
    // minActiveDays 0 everywhere. The daily `raiseTiers` lifts learners the old day rule held back.
    version: 'tier_lifetime_lp_v2',
    levels: [
      { level: 1, key: TIER_KEY.FIRST_STEPS, minLifetimeLP: 40, minActiveDays: 0 },
      { level: 2, key: TIER_KEY.IN_MOTION, minLifetimeLP: 180, minActiveDays: 0 },
      { level: 3, key: TIER_KEY.BUILDING_UP, minLifetimeLP: 600, minActiveDays: 0 },
      { level: 4, key: TIER_KEY.STEADY_EFFORT, minLifetimeLP: 1_500, minActiveDays: 0 },
      { level: 5, key: TIER_KEY.COMMITTED, minLifetimeLP: 4_000, minActiveDays: 0 },
      { level: 6, key: TIER_KEY.DEDICATED, minLifetimeLP: 9_000, minActiveDays: 0 },
      { level: 7, key: TIER_KEY.LASTING_MARK, minLifetimeLP: 20_000, minActiveDays: 0 },
    ],
  },
  ranking: {
    version: 'ranking_v1',
    topLimit: 100,
    aroundRadius: 5,
    // Exact rank only inside this many; the count that proves it scans at most this many rows.
    exactRankLimit: 1_000,
    historyWeeks: 8,
    histogram: { fineStep: 10, fineUntil: 2_000, coarseStep: 100 },
    weekCloseDelayMinutes: 10,
    usernameChangeDays: 30,
    reportsPerUtcDay: 10,
  },
  // Admin bulk TTS: ElevenLabs allows 2 requests at once on the free plan (more on paid ones).
  audio: { maxBatchSize: 50, defaultBatchSize: 20, ttsConcurrency: 2, maxRefreshBatch: 200 },
  customWords: { maxRoadmapWords: 500, dailyLookups: 30, maxTextLength: 64, maxContextLength: 200, maxMeaningsPerWord: 8, maxSensesPerDraft: 3 },
} as const;
