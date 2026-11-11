import { MEMORY_SIGNAL, MemorySignal } from '../../common/constants/domain';
import { addHours, MS_PER_HOUR } from '../../common/constants/time';
import { POLICY } from '../../config/policy';

const SRS = POLICY.srs;

export interface SrsState {
  learnedAt: Date;
  lastReviewedAt: Date | null;
  nextReviewAt: Date;
  intervalHours: number;
  unaidedStreak: number;
  lapseCount: number;
  recognitionGraceUsed: boolean;
}

export interface Observation {
  signal: MemorySignal;
  isPrimed: boolean;
}

// A primed "unaided" answer earns no strong credit (C17).
const effectiveSignal = ({ signal, isPrimed }: Observation) =>
  signal === MEMORY_SIGNAL.UNAIDED_RECALL && isPrimed ? MEMORY_SIGNAL.ASSISTED_RECALL : signal;

const earlier = (a: Date, b: Date) => (a < b ? a : b);

const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / MS_PER_HOUR;

// Recalling a word unaided after a longer gap than planned shows it holds that long, so growth starts from the real gap.
const recalledGapHours = (state: SrsState, at: Date) =>
  Math.max(state.intervalHours, hoursBetween(state.lastReviewedAt ?? state.learnedAt, at));

const weakenedInterval = (hours: number) => Math.max(SRS.failedRecallIntervalHours, hours * SRS.weakenedIntervalFactor);

export function initialState(observation: Observation | undefined, at: Date): SrsState {
  const signal = observation ? effectiveSignal(observation) : MEMORY_SIGNAL.FAILED_RECALL;
  const intervalHours =
    signal === MEMORY_SIGNAL.UNAIDED_RECALL
      ? SRS.initialUnaidedHours
      : signal === MEMORY_SIGNAL.ASSISTED_RECALL
        ? SRS.initialAssistedHours
        : SRS.initialFailedHours;
  return {
    learnedAt: at,
    lastReviewedAt: at,
    nextReviewAt: addHours(at, intervalHours),
    intervalHours,
    unaidedStreak: signal === MEMORY_SIGNAL.UNAIDED_RECALL ? 1 : 0,
    lapseCount: 0,
    recognitionGraceUsed: false,
  };
}

/** A word the learner recalled unaided before being taught starts further out. */
export function initialKnownState(at: Date): SrsState {
  const intervalHours = POLICY.newLearning.knownInitialHours;
  return {
    learnedAt: at,
    lastReviewedAt: at,
    nextReviewAt: addHours(at, intervalHours),
    intervalHours,
    unaidedStreak: 1,
    lapseCount: 0,
    recognitionGraceUsed: false,
  };
}

export function applyDailyDue(state: SrsState, observation: Observation, at: Date): SrsState {
  const reviewed = { ...state, lastReviewedAt: at };
  switch (effectiveSignal(observation)) {
    case MEMORY_SIGNAL.UNAIDED_RECALL: {
      const factor = Math.min(SRS.maxGrowth, SRS.baseGrowth + SRS.streakBonus * state.unaidedStreak);
      const intervalHours = Math.min(SRS.maxIntervalHours, Math.max(SRS.minIntervalHours, recalledGapHours(state, at) * factor));
      return {
        ...reviewed,
        intervalHours,
        nextReviewAt: addHours(at, intervalHours),
        unaidedStreak: state.unaidedStreak + 1,
        recognitionGraceUsed: false,
      };
    }
    case MEMORY_SIGNAL.ASSISTED_RECALL: {
      const intervalHours = weakenedInterval(state.intervalHours);
      return {
        ...reviewed,
        intervalHours,
        unaidedStreak: 0,
        nextReviewAt: addHours(at, Math.min(intervalHours, SRS.assistedFollowUpHours)),
      };
    }
    case MEMORY_SIGNAL.FAILED_RECALL:
    case MEMORY_SIGNAL.FAILED_RECOGNITION:
      return {
        ...reviewed,
        intervalHours: SRS.failedRecallIntervalHours,
        nextReviewAt: addHours(at, SRS.failedRecallIntervalHours),
        unaidedStreak: 0,
        lapseCount: state.lapseCount + 1,
      };
    case MEMORY_SIGNAL.RECOGNITION_SUCCESS: {
      const isDue = state.nextReviewAt <= at;
      if (!isDue || state.recognitionGraceUsed) return reviewed;
      return { ...reviewed, nextReviewAt: addHours(at, SRS.recognitionGraceHours), recognitionGraceUsed: true };
    }
  }
}

const FAILURE_SIGNALS: MemorySignal[] = [MEMORY_SIGNAL.FAILED_RECALL, MEMORY_SIGNAL.FAILED_RECOGNITION];

/**
 * Checkpoint/Random/Weak: weak answers only pull the schedule closer. Success extends it only for a word already due:
 * an unaided recall then counts as its due review, so practice spends review debt without stretching words not yet due.
 */
export function applyNonDaily(state: SrsState, observation: Observation, at: Date): SrsState {
  if (effectiveSignal(observation) === MEMORY_SIGNAL.UNAIDED_RECALL && state.nextReviewAt <= at) return applyDailyDue(state, observation, at);
  const reviewed = { ...state, lastReviewedAt: at };
  if (observation.signal === MEMORY_SIGNAL.ASSISTED_RECALL) {
    return { ...reviewed, nextReviewAt: earlier(state.nextReviewAt, addHours(at, SRS.assistedFollowUpHours)) };
  }
  if (!FAILURE_SIGNALS.includes(observation.signal)) return reviewed;
  return {
    ...reviewed,
    intervalHours: weakenedInterval(state.intervalHours),
    unaidedStreak: 0,
    nextReviewAt: earlier(state.nextReviewAt, addHours(at, SRS.failedRecognitionDelayHours)),
  };
}
