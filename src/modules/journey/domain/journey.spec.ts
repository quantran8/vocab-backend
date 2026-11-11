import { describe, expect, it } from 'vitest';
import { buildJourney, JourneyChallenge, JourneySession, journeyWindow, ReviewResult } from './journey';

const SIZE = 7;
const opts = { history: 2, future: 1 };

const sessions = (sequence: number | null, n: number, prefix = `s${sequence ?? 'p'}`): JourneySession[] =>
  Array.from({ length: n }, (_, i) => ({ sessionId: `${prefix}-${i + 1}`, sequence }));
const challenge = (sequence: number, state: 'available' | 'completed'): JourneyChallenge =>
  ({ id: `c${sequence}`, sequence, state, completedSessionId: state === 'completed' ? `r${sequence}` : null });

function journey(challenges: JourneyChallenge[], learned: JourneySession[], results = new Map<string, ReviewResult>(), o: { history: number; future: number; before?: number } = opts, goal = SIZE) {
  return buildJourney({ window: journeyWindow(challenges, o), weeklyGoal: goal, fallbackSize: SIZE, challenges, sessions: learned, results });
}
const states = (j: ReturnType<typeof journey>, segmentNo: number) =>
  j.segments.find((s) => s.segmentNo === segmentNo)!.nodes.map((n) => ({ completed: 'x', current: 'o', locked: '-' })[n.state]).join('');

describe('buildJourney', () => {
  it('new learner: segment 1 session 1 is current, everything else locked', () => {
    const j = journey([], []);
    expect(j.segments.map((s) => s.segmentNo)).toEqual([2, 1]);
    expect(states(j, 1)).toBe('o-------');
    expect(states(j, 2)).toBe('--------');
    expect(j).toMatchObject({ currentSegmentNo: 1, focusNodeId: 'segment:1:learning:1', completedReviewCount: 0, hasMoreHistory: false, nextHistoryCursor: null });
    expect(j.segments[0]).toMatchObject({ status: 'preview', completedLearningCount: 0 });
    expect(j.segments[1]).toMatchObject({ status: 'active' });
  });

  it('after 6 sessions: 6 completed, session 7 current, review locked', () => {
    const j = journey([], sessions(null, 6));
    expect(states(j, 1)).toBe('xxxxxxo-');
    const nodes = j.segments.find((s) => s.segmentNo === 1)!.nodes;
    expect(nodes.slice(0, 6).every((n) => n.state === 'completed')).toBe(true);
    expect(nodes[6]).toMatchObject({ id: 'segment:1:learning:7', state: 'current' });
    expect(nodes[7]).toMatchObject({ id: 'segment:1:review', type: 'review', ordinal: 8, state: 'locked' });
    expect(nodes[0].sessionId).toBe('sp-1');
    expect(j.focusNodeId).toBe('segment:1:learning:7');
  });

  it('after 7 sessions: review is current and the next segment stays locked', () => {
    const j = journey([challenge(1, 'available')], sessions(1, 7));
    expect(states(j, 1)).toBe('xxxxxxxo');
    const review = j.segments.find((s) => s.segmentNo === 1)!.nodes[7];
    expect(review).toMatchObject({ state: 'current', reviewId: 'c1' });
    expect(states(j, 2)).toBe('--------');
    expect(j.focusNodeId).toBe('segment:1:review');
  });

  it('after the review: it is completed with its result, segment 2 session 1 is current, segment 1 still listed', () => {
    const result = { reviewedCount: 7, unaidedRecalledCount: 2, needsReviewCount: 5 };
    const j = journey([challenge(1, 'completed')], sessions(1, 7), new Map([['c1', result]]));
    expect(j.segments.map((s) => s.segmentNo)).toEqual([3, 2, 1]);
    expect(j.segments.find((s) => s.segmentNo === 1)).toMatchObject({ status: 'completed', completedLearningCount: 7 });
    expect(j.segments.find((s) => s.segmentNo === 1)!.nodes[7]).toMatchObject({ state: 'completed', result });
    expect(states(j, 2)).toBe('o-------');
    expect(j).toMatchObject({ currentSegmentNo: 2, focusNodeId: 'segment:2:learning:1', completedReviewCount: 1 });
  });

  it('pages history below the current segment', () => {
    const challenges = [1, 2, 3, 4].map((n) => challenge(n, 'completed'));
    const learned = [1, 2, 3, 4].flatMap((n) => sessions(n, 7));
    const first = journey(challenges, learned);
    expect(first.segments.map((s) => s.segmentNo)).toEqual([6, 5, 4, 3]);
    expect(first).toMatchObject({ hasMoreHistory: true, nextHistoryCursor: 3 });

    const older = journey(challenges, learned, new Map(), { ...opts, before: 3 });
    expect(older.segments.map((s) => s.segmentNo)).toEqual([2, 1]);
    expect(older).toMatchObject({ hasMoreHistory: false, nextHistoryCursor: null, focusNodeId: 'segment:5:learning:1' });
  });

  it('keeps node ids stable as their state changes', () => {
    const before = journey([], sessions(null, 6)).segments.find((s) => s.segmentNo === 1)!.nodes.map((n) => n.id);
    const after = journey([challenge(1, 'available')], sessions(1, 7)).segments.find((s) => s.segmentNo === 1)!.nodes.map((n) => n.id);
    expect(after).toEqual(before);
  });

  it('sizes each segment: challenges by the sessions they took, the rest by the weekly goal', () => {
    // Segment 1 ran at 5 a week, segment 2 at 3 (lowered after 4 sessions, so it took all 4), now the goal is 3.
    const j = journey([challenge(1, 'completed'), challenge(2, 'completed')], [...sessions(1, 5), ...sessions(2, 4)], new Map(), opts, 3);
    expect(states(j, 1)).toBe('xxxxxx');
    expect(states(j, 2)).toBe('xxxxx');
    expect(states(j, 3)).toBe('o---');
    expect(states(j, 4)).toBe('----');
    const review = j.segments.find((s) => s.segmentNo === 3)!.nodes.at(-1)!;
    expect(review).toMatchObject({ id: 'segment:3:review', type: 'review', ordinal: 4 });
  });

  it('a raised goal lengthens the current segment', () => {
    const j = journey([], sessions(null, 3), new Map(), opts, 5);
    expect(states(j, 1)).toBe('xxxo--');
  });

  it('an old challenge with no traceable sessions falls back to the default size', () => {
    const j = journey([challenge(1, 'completed')], []);
    expect(states(j, 1)).toBe('xxxxxxxx');
  });

  it('with several waiting challenges, only the oldest review is current', () => {
    const j = journey([challenge(1, 'available'), challenge(2, 'available')], [...sessions(1, 7), ...sessions(2, 7)]);
    expect(j.currentSegmentNo).toBe(1);
    expect(j.segments.find((s) => s.segmentNo === 1)!.nodes[7].state).toBe('current');
    expect(j.segments.find((s) => s.segmentNo === 2)!.nodes[7].state).toBe('locked');
    expect(j.segments.flatMap((s) => s.nodes).filter((n) => n.state === 'current')).toHaveLength(1);
  });
});
