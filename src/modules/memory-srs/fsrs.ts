import { FSRS_GRADE, FSRS_GRADE_VALUE, FsrsGrade } from '../../common/constants/domain';
import { addHours, HOURS_PER_DAY, MS_PER_DAY } from '../../common/constants/time';
import { POLICY } from '../../config/policy';

const F = POLICY.fsrs;
const w = F.w;

export interface SrsState {
  learnedAt: Date;
  lastReviewedAt: Date | null;
  nextReviewAt: Date;
  stability: number;
  difficulty: number;
  lapseCount: number;
}

/** One session's evidence for a Meaning; `weight` (0..1] scales a success, a failure always counts in full. */
export interface ReviewOutcome {
  grade: FsrsGrade;
  weight: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clampS = (s: number) => clamp(s, F.minStability, F.maxStability);
const isSuccess = (grade: FsrsGrade) => grade === FSRS_GRADE.GOOD || grade === FSRS_GRADE.EASY;

export const DECAY = -w[20];
export const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

/** Probability of recall after `elapsedDays` at stability `s`. */
export const retrievability = (elapsedDays: number, s: number) => Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / s, DECAY);

export const intervalDays = (s: number, retention = F.desiredRetention) => (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);

const initStability = (g: number) => clampS(w[g - 1]);
const initDifficulty = (g: number) => w[4] - Math.exp((g - 1) * w[5]) + 1;

function nextDifficulty(d: number, g: number) {
  const delta = -w[6] * (g - 3);
  const next = d + (delta * (10 - d)) / 9;
  return clamp(w[7] * initDifficulty(4) + (1 - w[7]) * next, 1, 10);
}

const recallStability = (d: number, s: number, r: number, g: number) =>
  clampS(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1)));

const forgetStability = (d: number, s: number, r: number) =>
  clampS(Math.min(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), s / Math.exp(w[17] * w[18])));

function shortTermStability(s: number, g: number) {
  const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
  return clampS(s * (g >= 2 ? Math.max(sinc, 1) : sinc));
}

/** Unweighted FSRS-6 step, the reference the weighted update scales; `elapsedDays` < 1 is a same-day review. */
export function fsrsStep(state: { stability: number; difficulty: number }, elapsedDays: number, g: number) {
  const { stability: s, difficulty: d } = state;
  const r = retrievability(elapsedDays, s);
  const stability = elapsedDays < 1 ? shortTermStability(s, g) : g === 1 ? forgetStability(d, s, r) : recallStability(d, s, r, g);
  return { stability, difficulty: nextDifficulty(d, g) };
}

function schedule(at: Date, stability: number) {
  const hours = clamp(intervalDays(stability) * HOURS_PER_DAY, F.minIntervalHours, F.maxIntervalDays * HOURS_PER_DAY);
  return addHours(at, hours);
}

/** First state after the learning session; no observation means the word was never answered. */
export function initialState(outcome: ReviewOutcome | undefined, at: Date): SrsState {
  const { grade, weight } = outcome ?? { grade: FSRS_GRADE.AGAIN, weight: 1 };
  const g = FSRS_GRADE_VALUE[grade];
  // A weak success starts between Hard and its own grade.
  const t = isSuccess(grade) ? weight : 1;
  const stability = clampS(lerp(initStability(2), initStability(g), t));
  const difficulty = clamp(lerp(initDifficulty(2), initDifficulty(g), t), 1, 10);
  return { learnedAt: at, lastReviewedAt: at, nextReviewAt: schedule(at, stability), stability, difficulty, lapseCount: 0 };
}

/** A word the learner recalled unaided before being taught starts further out. */
export function knownState(at: Date): SrsState {
  const stability = F.knownInitialDays;
  return { learnedAt: at, lastReviewedAt: at, nextReviewAt: schedule(at, stability), stability, difficulty: clamp(initDifficulty(4), 1, 10), lapseCount: 0 };
}

/** Every mode reviews the same way: FSRS gives an early review little credit on its own. */
export function applyReview(state: SrsState, outcome: ReviewOutcome, at: Date): SrsState {
  const g = FSRS_GRADE_VALUE[outcome.grade];
  const elapsedDays = (at.getTime() - (state.lastReviewedAt ?? state.learnedAt).getTime()) / MS_PER_DAY;
  const full = fsrsStep(state, elapsedDays, g);
  const t = isSuccess(outcome.grade) ? clamp(outcome.weight, 0, 1) : 1;
  const stability = clampS(lerp(state.stability, full.stability, t));
  const difficulty = clamp(lerp(state.difficulty, full.difficulty, t), 1, 10);
  return {
    ...state,
    lastReviewedAt: at,
    stability,
    difficulty,
    nextReviewAt: schedule(at, stability),
    lapseCount: g === 1 ? state.lapseCount + 1 : state.lapseCount,
  };
}
