import {
  CHECKPOINT_STATE,
  CheckpointState,
  JOURNEY_NODE_STATE,
  JOURNEY_NODE_TYPE,
  JOURNEY_SEGMENT_STATUS,
  JourneyNodeState,
  JourneyNodeType,
  JourneySegmentStatus,
} from '../../../common/constants/domain';

/**
 * A Journey segment is one checkpoint challenge: its learning sessions, then the challenge as its review.
 * A segment with a challenge has as many sessions as the challenge took; the current and future ones
 * take the learner's weekly goal, which can change between segments.
 */
export type JourneyChallenge = { id: string; sequence: number; state: CheckpointState; completedSessionId: string | null };
/** A committed Daily session that learned new Meanings, in learned order; `sequence` is null until a challenge takes it. */
export type JourneySession = { sessionId: string; sequence: number | null };
export type ReviewResult = { reviewedCount: number; unaidedRecalledCount: number; needsReviewCount: number };

export type JourneyNode = {
  id: string;
  segmentNo: number;
  type: JourneyNodeType;
  ordinal: number;
  state: JourneyNodeState;
  sessionId?: string;
  reviewId?: string;
  result?: ReviewResult;
};
export type JourneySegment = { segmentNo: number; status: JourneySegmentStatus; completedLearningCount: number; nodes: JourneyNode[] };

export const learningNodeId = (segmentNo: number, slot: number) => `segment:${segmentNo}:learning:${slot}`;
export const reviewNodeId = (segmentNo: number) => `segment:${segmentNo}:review`;

/** The segment the learner is on: the oldest challenge still waiting, else the one after the last challenge. */
export function currentSegmentNo(challenges: JourneyChallenge[]) {
  const waiting = challenges.find((c) => c.state === CHECKPOINT_STATE.AVAILABLE);
  if (waiting) return waiting.sequence;
  return lastSequence(challenges) + 1;
}

const lastSequence = (challenges: JourneyChallenge[]) => challenges.reduce((max, c) => Math.max(max, c.sequence), 0);

export type JourneyWindow = { lo: number; hi: number; current: number };

/**
 * Segments to render, newest first. The first page is the future previews, the current segment and `history`
 * segments below it; `before` pages through older history only.
 */
export function journeyWindow(challenges: JourneyChallenge[], opts: { history: number; future: number; before?: number }): JourneyWindow {
  const current = currentSegmentNo(challenges);
  if (opts.before !== undefined) {
    const hi = Math.min(opts.before - 1, current - 1);
    return { lo: Math.max(1, hi - opts.history + 1), hi, current };
  }
  // The segment after the last challenge always shows: it holds any sessions learned since.
  const hi = Math.max(current + opts.future, lastSequence(challenges) + 1);
  return { lo: Math.max(1, current - opts.history), hi, current };
}

export function buildJourney(input: {
  window: JourneyWindow;
  /** The learner's weekly goal: the size of segments without a challenge yet. */
  weeklyGoal: number;
  /** For an old challenge whose sessions can't be told apart. */
  fallbackSize: number;
  challenges: JourneyChallenge[];
  sessions: JourneySession[];
  results: Map<string, ReviewResult>;
}) {
  const { window, weeklyGoal, fallbackSize, challenges, sessions, results } = input;
  const { lo, hi, current } = window;
  const pendingNo = lastSequence(challenges) + 1;
  const bySequence = new Map(challenges.map((c) => [c.sequence, c]));
  const sessionsOf = Map.groupBy(sessions, (s) => s.sequence ?? pendingNo);

  const sizeOf = (segmentNo: number) => {
    const sessionsHere = sessionsOf.get(segmentNo) ?? [];
    // A challenge exists only once its segment's learning is done, so all its slots are complete.
    return bySequence.has(segmentNo) ? sessionsHere.length || fallbackSize : Math.max(weeklyGoal, sessionsHere.length);
  };

  const segment = (segmentNo: number): JourneySegment => {
    const challenge = bySequence.get(segmentNo);
    const sessionsHere = sessionsOf.get(segmentNo) ?? [];
    const size = sizeOf(segmentNo);
    const learned = sessionsHere.slice(0, size);
    const done = challenge ? size : learned.length;
    const isCurrent = segmentNo === current;

    const nodes: JourneyNode[] = Array.from({ length: size }, (_, i) => {
      const slot = i + 1;
      const state = slot <= done
        ? JOURNEY_NODE_STATE.COMPLETED
        : isCurrent && !challenge && slot === done + 1 ? JOURNEY_NODE_STATE.CURRENT : JOURNEY_NODE_STATE.LOCKED;
      const sessionId = learned[i]?.sessionId;
      return { id: learningNodeId(segmentNo, slot), segmentNo, type: JOURNEY_NODE_TYPE.LEARNING, ordinal: slot, state, ...(sessionId && { sessionId }) };
    });

    const completed = challenge?.state === CHECKPOINT_STATE.COMPLETED;
    const result = completed ? results.get(challenge.id) : undefined;
    nodes.push({
      id: reviewNodeId(segmentNo),
      segmentNo,
      type: JOURNEY_NODE_TYPE.REVIEW,
      ordinal: size + 1,
      state: completed ? JOURNEY_NODE_STATE.COMPLETED : challenge && isCurrent ? JOURNEY_NODE_STATE.CURRENT : JOURNEY_NODE_STATE.LOCKED,
      ...(challenge && { reviewId: challenge.id }),
      ...(result && { result }),
    });

    const status = completed ? JOURNEY_SEGMENT_STATUS.COMPLETED : isCurrent ? JOURNEY_SEGMENT_STATUS.ACTIVE : JOURNEY_SEGMENT_STATUS.PREVIEW;
    return { segmentNo, status, completedLearningCount: done, nodes };
  };

  const segments = hi >= lo ? Array.from({ length: hi - lo + 1 }, (_, i) => segment(hi - i)) : [];
  const currentSegment = segments.find((s) => s.segmentNo === current) ?? segment(current);
  const focus = currentSegment.nodes.find((n) => n.state === JOURNEY_NODE_STATE.CURRENT) ?? currentSegment.nodes[currentSegment.nodes.length - 1];
  const oldest = segments.length > 0 ? segments[segments.length - 1].segmentNo : lo;

  return {
    currentSegmentNo: current,
    focusNodeId: focus.id,
    completedReviewCount: challenges.filter((c) => c.state === CHECKPOINT_STATE.COMPLETED).length,
    segments,
    hasMoreHistory: oldest > 1,
    nextHistoryCursor: oldest > 1 ? oldest : null,
  };
}

/** Recall results of one review session: only an unaided recall counts as remembered. */
export function reviewResult(reviewedCount: number, unaidedRecalledCount: number): ReviewResult {
  return { reviewedCount, unaidedRecalledCount, needsReviewCount: reviewedCount - unaidedRecalledCount };
}
