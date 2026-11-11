import { createHash } from 'node:crypto';
import {
  CHALLENGE_ENDED_REASON, CHALLENGE_OUTCOME, ChallengeEndedReason, ChallengeOutcome, TILE_SIDE, TileSide,
} from '../../../common/constants/domain';

export const MAX_STARS = 3;

export interface StarTier { maxElapsedMs: number; maxMistakes: number }
export interface LevelRule {
  levelNo: number;
  targetMatches: number;
  visiblePairs: number;
  coreCount: number;
  useReview: boolean;
  stars: { two: StarTier; three: StarTier };
}
export interface ScoreRule { match: number; streakStep: number; maxStreakSteps: number; mistake: number; perSecondLeft: number }
export interface EngineRules {
  timeLimitMs: number;
  maxOccurrencesPerMeaning: number;
  minMatchesBetweenRepeats: number;
  score: ScoreRule;
}

export interface SlotContent { meaningId: string; lemma: string; gloss: string }
export interface PlanPair { pairId: string; wordTileId: string; meaningTileId: string; meaningId: string; word: string; meaning: string }
export interface RunPlan {
  boardSeed: string;
  explanationLocale: string;
  goalMatches: number;
  visiblePairs: number;
  timeLimitMs: number;
  starCriteria: LevelRule['stars'];
  /** Frozen at issue; plans issued before it existed fall back to the policy. */
  score?: ScoreRule;
  /** Reveal queue, exactly goalMatches occurrences. */
  pairs: PlanPair[];
}

export interface MatchEvent { seq: number; type: string; elapsedMs: number; wordTileId: string; meaningTileId: string }
export interface RunResult {
  outcome: ChallengeOutcome;
  starsThisRun: number;
  correctMatches: number;
  mistakes: number;
  longestCombo: number;
  elapsedMs: number;
  score: number;
}

export const hashHex = (...parts: (string | number)[]) => createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');

/** Deterministic shuffle: sort by SHA-256 of seed, label and key; ties by key. */
export function seededOrder<T>(seed: string, label: string, items: readonly T[], key: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, k: key(item), h: hashHex(seed, label, key(item)) }))
    .sort((a, b) => (a.h === b.h ? (a.k < b.k ? -1 : 1) : a.h < b.h ? -1 : 1))
    .map((x) => x.item);
}

/**
 * The reveal queue for one run, or null when the content cannot fill the level.
 * Repeats go to the back half two slots apart, so the same Meaning is never adjacent; Board enforces the hard spacing.
 */
export function buildQueue(input: { seed: string; level: LevelRule; rules: EngineRules; core: SlotContent[]; review: SlotContent[] }) {
  const { seed, level, rules } = input;
  if (input.core.length < level.coreCount) return null;
  const core = seededOrder(seed, 'core', input.core, (c) => c.meaningId).slice(0, level.coreCount);
  const distinct = seededOrder(seed, 'queue', level.useReview ? [...core, ...input.review] : core, (c) => c.meaningId);
  const target = level.targetMatches;
  if (distinct.length >= target) return distinct.slice(0, target);

  const repeats = target - distinct.length;
  if (repeats > distinct.length * (rules.maxOccurrencesPerMeaning - 1)) return null;
  const copies = Array.from({ length: repeats }, (_, k) => distinct[k % distinct.length]);
  const stride = target - 2 * repeats >= level.visiblePairs + rules.minMatchesBetweenRepeats ? 2 : 1;
  const slots = new Map(copies.map((c, k) => [target - stride * (repeats - k), c]));
  const queue: SlotContent[] = [];
  let next = 0;
  for (let i = 0; i < target; i += 1) queue.push(slots.get(i) ?? distinct[next++]);
  return queue;
}

export function buildPlan(input: {
  seed: string; explanationLocale: string; level: LevelRule; rules: EngineRules; queue: SlotContent[]; newId: () => string;
}): RunPlan {
  const { seed, level, rules, queue } = input;
  return {
    boardSeed: seed,
    explanationLocale: input.explanationLocale,
    goalMatches: level.targetMatches,
    visiblePairs: level.visiblePairs,
    timeLimitMs: rules.timeLimitMs,
    starCriteria: level.stars,
    score: rules.score,
    pairs: queue.map((c) => ({
      pairId: input.newId(), wordTileId: input.newId(), meaningTileId: input.newId(), meaningId: c.meaningId, word: c.lemma, meaning: c.gloss,
    })),
  };
}

/** Canonical column order, shared with the iOS client: sort by SHA-256(seed|correctCount|side|tileId). */
export function columnOrder(seed: string, correctCount: number, side: TileSide, tileIds: readonly string[]) {
  return tileIds
    .map((id) => ({ id, h: hashHex(seed, correctCount, side, id) }))
    .sort((a, b) => (a.h === b.h ? (a.id < b.id ? -1 : 1) : a.h < b.h ? -1 : 1))
    .map((x) => x.id);
}

/**
 * Board state shared by client and server replay. After each correct match the next queued pair whose Meaning is
 * neither on the board nor matched in the last `minMatchesBetweenRepeats` matches is shown; if none qualifies and
 * the board is empty, the first queued pair is shown anyway.
 */
export class Board {
  readonly active: PlanPair[] = [];
  private readonly pending: PlanPair[];
  private readonly matchedAt = new Map<string, number>();
  correctCount = 0;

  constructor(private readonly plan: RunPlan, private readonly minGap: number) {
    this.pending = [...plan.pairs];
    this.fill();
  }

  get done() { return this.correctCount === this.plan.goalMatches; }

  order() {
    const seed = this.plan.boardSeed;
    return {
      words: columnOrder(seed, this.correctCount, TILE_SIDE.WORD, this.active.map((p) => p.wordTileId)),
      meanings: columnOrder(seed, this.correctCount, TILE_SIDE.MEANING, this.active.map((p) => p.meaningTileId)),
    };
  }

  /** null when either tile is not on the board. */
  match(wordTileId: string, meaningTileId: string): boolean | null {
    const word = this.active.find((p) => p.wordTileId === wordTileId);
    const meaning = this.active.find((p) => p.meaningTileId === meaningTileId);
    if (!word || !meaning) return null;
    if (word !== meaning) return false;
    this.active.splice(this.active.indexOf(word), 1);
    this.correctCount += 1;
    this.matchedAt.set(word.meaningId, this.correctCount);
    this.fill();
    return true;
  }

  private fill() {
    while (this.active.length < this.plan.visiblePairs && this.pending.length > 0) {
      let index = this.pending.findIndex((p) => this.canShow(p));
      if (index < 0 && this.active.length === 0) index = 0;
      if (index < 0) return;
      this.active.push(...this.pending.splice(index, 1));
    }
  }

  private canShow(pair: PlanPair) {
    if (this.active.some((p) => p.meaningId === pair.meaningId)) return false;
    const last = this.matchedAt.get(pair.meaningId);
    return last === undefined || this.correctCount - last >= this.minGap;
  }
}

export function starsFor(stars: LevelRule['stars'], elapsedMs: number, mistakes: number) {
  const meets = (t: StarTier) => elapsedMs <= t.maxElapsedMs && mistakes <= t.maxMistakes;
  if (meets(stars.three)) return 3;
  return meets(stars.two) ? 2 : 1;
}

export type ReplayOutcome = { ok: true; result: RunResult } | { ok: false; reason: string };

/** Replays the attempts against the frozen plan; the client never reports score, stars or correctness. */
export function replay(plan: RunPlan, rules: EngineRules, input: {
  events: MatchEvent[]; endedReason: ChallengeEndedReason; endedElapsedMs: number;
}): ReplayOutcome {
  const fail = (reason: string): ReplayOutcome => ({ ok: false, reason });
  const board = new Board(plan, rules.minMatchesBetweenRepeats);
  const points = plan.score ?? rules.score;
  let mistakes = 0;
  let streak = 0;
  let longestCombo = 0;
  let score = 0;
  let lastElapsed = -1;

  for (const [i, event] of input.events.entries()) {
    if (event.seq !== i + 1) return fail(`seq ${event.seq} out of order`);
    if (event.elapsedMs <= lastElapsed) return fail(`seq ${event.seq} elapsedMs not increasing`);
    if (event.elapsedMs > plan.timeLimitMs) return fail(`seq ${event.seq} after the time limit`);
    if (board.done) return fail(`seq ${event.seq} after the goal`);
    lastElapsed = event.elapsedMs;
    const correct = board.match(event.wordTileId, event.meaningTileId);
    if (correct === null) return fail(`seq ${event.seq} uses a tile that is not on the board`);
    if (correct) {
      streak += 1;
      longestCombo = Math.max(longestCombo, streak);
      score += points.match + points.streakStep * Math.min(streak, points.maxStreakSteps);
    } else {
      mistakes += 1;
      streak = 0;
      score -= points.mistake;
    }
  }

  const ended = input.endedElapsedMs;
  if (ended < Math.max(lastElapsed, 0) || ended > plan.timeLimitMs) return fail('endedElapsedMs out of range');
  const base = { correctMatches: board.correctCount, mistakes, longestCombo, elapsedMs: ended };
  if (board.done) {
    if (input.endedReason !== CHALLENGE_ENDED_REASON.GOAL_REACHED) return fail('the goal was reached');
    if (ended !== lastElapsed) return fail('endedElapsedMs must equal the last match');
    const bonus = points.perSecondLeft * Math.floor((plan.timeLimitMs - ended) / 1000);
    return { ok: true, result: { ...base, outcome: CHALLENGE_OUTCOME.CLEARED, starsThisRun: starsFor(plan.starCriteria, ended, mistakes), score: Math.max(0, score + bonus) } };
  }
  if (input.endedReason === CHALLENGE_ENDED_REASON.GOAL_REACHED) return fail('the goal was not reached');
  if (input.endedReason === CHALLENGE_ENDED_REASON.TIME_UP && ended !== plan.timeLimitMs) return fail('time_up must end at the time limit');
  if (input.endedReason === CHALLENGE_ENDED_REASON.QUIT && ended >= plan.timeLimitMs) return fail('a quit at the deadline is time_up');
  const outcome = input.endedReason === CHALLENGE_ENDED_REASON.QUIT ? CHALLENGE_OUTCOME.QUIT : CHALLENGE_OUTCOME.FAILED;
  return { ok: true, result: { ...base, outcome, starsThisRun: 0, score: Math.max(0, score) } };
}
