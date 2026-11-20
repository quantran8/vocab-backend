import {
  SPEAKING_CHANGE, SPEAKING_METHOD, SPEAKING_STATUS, SpeakingChange, StoredSpeakingStatus,
} from '../../common/constants/domain';
import { POLICY } from '../../config/policy';

export interface SpeakingState {
  status: StoredSpeakingStatus;
  deviceSessions: number;
  deviceStreak: number;
  scoredSessions: number;
  scoreAvg: number | null;
  lastScore: number | null;
  bestScore: number | null;
  lastPassed: boolean;
  lastAssessedAt: Date;
  fluentAt: Date | null;
}

type Tracks = Pick<SpeakingState, 'deviceSessions' | 'deviceStreak' | 'scoredSessions' | 'scoreAvg' | 'lastScore' | 'bestScore'>;

/** One pronunciation's result in one session. */
export type SpeakingResult =
  | { pronunciationId: string; method: typeof SPEAKING_METHOD.DEVICE; passed: boolean }
  | { pronunciationId: string; method: typeof SPEAKING_METHOD.AZURE; passed: boolean; score: number };

const { deviceFluentStreak, scoreAlpha, fluentScore, slipScore, minScoredSessions } = POLICY.speaking;

const NO_TRACKS: Tracks = { deviceSessions: 0, deviceStreak: 0, scoredSessions: 0, scoreAvg: null, lastScore: null, bestScore: null };

// Stored as numeric(5,2): round here so the summary shows the value that is read back later.
const round2 = (n: number) => Math.round(n * 100) / 100;

function nextTracks(prev: Tracks, result: SpeakingResult): Tracks {
  if (result.method === SPEAKING_METHOD.DEVICE) {
    return { ...prev, deviceSessions: prev.deviceSessions + 1, deviceStreak: result.passed ? prev.deviceStreak + 1 : 0 };
  }
  const score = round2(result.score);
  const scoreAvg = prev.scoreAvg === null ? score : round2(prev.scoreAvg + scoreAlpha * (score - prev.scoreAvg));
  return { ...prev, scoredSessions: prev.scoredSessions + 1, scoreAvg, lastScore: score, bestScore: Math.max(prev.bestScore ?? score, score) };
}

function nextStatus(before: StoredSpeakingStatus, tracks: Tracks, result: SpeakingResult): StoredSpeakingStatus {
  if (result.method === SPEAKING_METHOD.DEVICE) {
    if (!result.passed) return SPEAKING_STATUS.PRACTICING;
    return tracks.deviceStreak >= deviceFluentStreak ? SPEAKING_STATUS.FLUENT : before;
  }
  const avg = tracks.scoreAvg!;
  if (avg >= fluentScore && tracks.scoredSessions >= minScoredSessions) return SPEAKING_STATUS.FLUENT;
  // Between the two thresholds the status holds, so a word does not flip on every 79/81.
  return avg < slipScore ? SPEAKING_STATUS.PRACTICING : before;
}

/** The current session's method decides the status; the other track stays as it was. */
export function applySpeaking(prev: SpeakingState | null, result: SpeakingResult, now: Date): { next: SpeakingState; change: SpeakingChange | null } {
  const before = prev?.status ?? SPEAKING_STATUS.PRACTICING;
  const tracks = nextTracks(prev ?? NO_TRACKS, result);
  const status = nextStatus(before, tracks, result);
  const wasFluent = before === SPEAKING_STATUS.FLUENT;
  const isFluent = status === SPEAKING_STATUS.FLUENT;
  const next: SpeakingState = {
    ...tracks,
    status,
    lastPassed: result.passed,
    lastAssessedAt: now,
    fluentAt: isFluent ? (wasFluent && prev?.fluentAt) || now : null,
  };
  const change = !wasFluent && isFluent ? SPEAKING_CHANGE.BECAME_FLUENT : wasFluent && !isFluent ? SPEAKING_CHANGE.SLIPPED : null;
  return { next, change };
}
