import { MEMORY_SIGNAL, MemorySignal } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
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
  signal === MEMORY_SIGNAL.unaidedRecall && isPrimed ? MEMORY_SIGNAL.assistedRecall : signal;

const earlier = (a: Date, b: Date) => (a < b ? a : b);

export function initialState(observation: Observation | undefined, at: Date): SrsState {
  const signal = observation ? effectiveSignal(observation) : MEMORY_SIGNAL.failedRecall;
  const intervalHours =
    signal === MEMORY_SIGNAL.unaidedRecall
      ? SRS.initialUnaidedHours
      : signal === MEMORY_SIGNAL.assistedRecall
        ? SRS.initialAssistedHours
        : SRS.initialFailedHours;
  return {
    learnedAt: at,
    lastReviewedAt: at,
    nextReviewAt: addHours(at, intervalHours),
    intervalHours,
    unaidedStreak: signal === MEMORY_SIGNAL.unaidedRecall ? 1 : 0,
    lapseCount: 0,
    recognitionGraceUsed: false,
  };
}

export function applyDailyDue(state: SrsState, observation: Observation, at: Date): SrsState {
  const reviewed = { ...state, lastReviewedAt: at };
  switch (effectiveSignal(observation)) {
    case MEMORY_SIGNAL.unaidedRecall: {
      const factor = Math.min(SRS.maxGrowth, SRS.baseGrowth + SRS.streakBonus * state.unaidedStreak);
      const intervalHours = Math.min(SRS.maxIntervalHours, Math.max(SRS.minIntervalHours, state.intervalHours * factor));
      return {
        ...reviewed,
        intervalHours,
        nextReviewAt: addHours(at, intervalHours),
        unaidedStreak: state.unaidedStreak + 1,
        recognitionGraceUsed: false,
      };
    }
    case MEMORY_SIGNAL.assistedRecall:
      return {
        ...reviewed,
        unaidedStreak: 0,
        nextReviewAt: addHours(at, Math.min(state.intervalHours, SRS.assistedFollowUpHours)),
      };
    case MEMORY_SIGNAL.failedRecall:
      return {
        ...reviewed,
        intervalHours: SRS.failedRecallIntervalHours,
        nextReviewAt: addHours(at, SRS.failedRecallIntervalHours),
        unaidedStreak: 0,
        lapseCount: state.lapseCount + 1,
      };
    case MEMORY_SIGNAL.failedRecognition:
      return { ...reviewed, nextReviewAt: earlier(state.nextReviewAt, addHours(at, SRS.failedRecognitionDelayHours)) };
    case MEMORY_SIGNAL.recognitionSuccess: {
      const isDue = state.nextReviewAt <= at;
      if (!isDue || state.recognitionGraceUsed) return reviewed;
      return { ...reviewed, nextReviewAt: addHours(at, SRS.recognitionGraceHours), recognitionGraceUsed: true };
    }
  }
}

const FAILURE_SIGNALS: MemorySignal[] = [MEMORY_SIGNAL.failedRecall, MEMORY_SIGNAL.failedRecognition];

/** Weekly/Random/Weak: success never extends the schedule; failure can only pull it closer. */
export function applyNonDaily(state: SrsState, observation: Observation, at: Date): SrsState {
  const reviewed = { ...state, lastReviewedAt: at };
  if (!FAILURE_SIGNALS.includes(observation.signal)) return reviewed;
  return { ...reviewed, nextReviewAt: earlier(state.nextReviewAt, addHours(at, SRS.failedRecognitionDelayHours)) };
}
