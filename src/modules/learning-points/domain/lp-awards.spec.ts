import { describe, expect, it } from 'vitest';
import { ContentProvenance, LpAwardType, OUTCOME, Outcome, SESSION_MODE, SessionMode, TASK_PHASE, TaskPhase } from '../../../common/constants/domain';
import { addHours } from '../../../common/constants/time';
import type { EvaluatedTask, TargetRow } from '../../session-commit/domain/commit-evaluator';
import { LpAwardInput, lpAwards, PriorAward } from './lp-awards';

const NOW = new Date('2026-11-12T10:00:00Z');
const ISSUED = addHours(NOW, -1);
const DUE = addHours(NOW, -5);
const LATER = addHours(NOW, 48);

interface TaskSpec { id: string; phase: TaskPhase; meanings: string[]; attempts?: number; outcome?: Outcome }

function session(specs: TaskSpec[]) {
  const evaluated = specs.map((s): EvaluatedTask => ({
    task: { id: s.id, phase: s.phase } as EvaluatedTask['task'],
    rawEvents: [],
    deliveryMode: 'none',
    targets: s.meanings.map((_, ordinal) => ({
      ordinal, outcome: s.outcome ?? OUTCOME.CORRECT, firstAttemptCorrect: true, attemptCount: s.attempts ?? 1, hintCount: 0,
    })),
  }));
  const targets = specs.flatMap((s) => s.meanings.map((meaningId, ordinal): TargetRow => ({ taskId: s.id, ordinal, meaningId, pronunciationId: null })));
  return { evaluated, targets };
}

function input(mode: SessionMode, specs: TaskSpec[], extra: Partial<LpAwardInput> = {}): LpAwardInput {
  return {
    mode, now: NOW, issuedAt: ISSUED, ...session(specs), newMeaningIds: [], known: new Set(), progress: new Map(), prior: [], provenance: new Map(), ...extra,
  };
}

const prior = (type: LpAwardType, meaningId: string, awardedAt: Date, points: number, provenance: ContentProvenance = 'catalog'): PriorAward =>
  ({ type, meaningId, awardedAt, day: awardedAt.toISOString().slice(0, 10), points, provenance });
const due = (...ids: string[]) => new Map(ids.map((id) => [id, { nextReviewAt: DUE }]));
const notDue = (...ids: string[]) => new Map(ids.map((id) => [id, { nextReviewAt: LATER }]));
const total = (awards: { points: number }[]) => awards.reduce((sum, a) => sum + a.points, 0);
const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('LP awards (lp_effort_trial_v1)', () => {
  it('gives +5 per new Meaning whatever the task count or accuracy', () => {
    const awards = lpAwards(input(SESSION_MODE.DAILY, [
      { id: 't1', phase: TASK_PHASE.NEW_PRACTICE, meanings: ['a', 'b'], outcome: OUTCOME.INCORRECT },
      { id: 't2', phase: TASK_PHASE.NEW_PRACTICE, meanings: ['a', 'c'] },
      { id: 't3', phase: TASK_PHASE.NEW_PRACTICE, meanings: ['a'] },
    ], { newMeaningIds: ['a', 'b', 'c'] }));
    expect(total(awards)).toBe(15);
    expect(awards.map((a) => a.awardKey)).toEqual(['new:a', 'new:b', 'new:c']);
  });

  it('adds 5 new, 8 due and nothing for non-due daily review to 57; extras come from practice modes', () => {
    const newIds = ids(5, 'n');
    const dueIds = ids(8, 'd');
    const awards = lpAwards(input(SESSION_MODE.DAILY, [
      { id: 'new', phase: TASK_PHASE.NEW_PRACTICE, meanings: newIds },
      { id: 'due', phase: TASK_PHASE.DUE_REVIEW, meanings: [...dueIds, 'x'] },
    ], { newMeaningIds: newIds, progress: new Map([...due(...dueIds), ...notDue('x')]) }));
    expect(total(awards)).toBe(5 * 5 + 8 * 4);
    const practice = lpAwards(input(SESSION_MODE.RANDOM_PRACTICE, [
      { id: 'p', phase: TASK_PHASE.RANDOM_PRACTICE, meanings: ids(4, 'e') },
    ], { progress: notDue(...ids(4, 'e')) }));
    expect(total(awards) + total(practice)).toBe(61);
  });

  it('gives nothing for a passed known check, and +5 once a failed check is taught', () => {
    const tasks: TaskSpec[] = [
      { id: 'k', phase: TASK_PHASE.KNOWN_CHECK, meanings: ['a', 'b'] },
      { id: 't', phase: TASK_PHASE.NEW_PRACTICE, meanings: ['b'] },
    ];
    const awards = lpAwards(input(SESSION_MODE.DAILY, tasks, { newMeaningIds: ['a', 'b'], known: new Set(['a']) }));
    expect(awards.map((a) => a.awardKey)).toEqual(['new:b']);
  });

  it('ignores reveal-only and unavailable tasks', () => {
    const awards = lpAwards(input(SESSION_MODE.DAILY, [
      { id: 'r', phase: TASK_PHASE.DUE_REVIEW, meanings: ['a'], attempts: 0, outcome: OUTCOME.REVEALED },
      { id: 'u', phase: TASK_PHASE.DUE_REVIEW, meanings: ['b'], attempts: 1, outcome: OUTCOME.UNAVAILABLE },
      { id: 'w', phase: TASK_PHASE.DUE_REVIEW, meanings: ['c'], attempts: 1, outcome: OUTCOME.REVEALED },
    ], { progress: due('a', 'b', 'c') }));
    expect(awards.map((a) => a.meaningId)).toEqual(['c']);
  });

  it('caps new custom Meanings at 5 a UTC day, counting earlier awards', () => {
    const custom = ids(8, 'c');
    const provenance = new Map(custom.map((id) => [id, 'custom_owned' as const]));
    const run = (earlier: PriorAward[]) => lpAwards(input(SESSION_MODE.DAILY, [
      { id: 't', phase: TASK_PHASE.NEW_PRACTICE, meanings: [...custom, 'cat'] },
    ], { newMeaningIds: [...custom, 'cat'], provenance, prior: earlier }));
    expect(total(run([]))).toBe(5 * 5 + 5);
    const twoToday = [prior('new_meaning_completed', 'old1', NOW, 5, 'custom_owned'), prior('new_meaning_completed', 'old2', NOW, 5, 'custom_owned')];
    expect(run(twoToday).filter((a) => a.provenance === 'custom_owned')).toHaveLength(3);
    const yesterday = [prior('new_meaning_completed', 'old', addHours(NOW, -24), 5, 'custom_owned')];
    expect(run(yesterday).filter((a) => a.provenance === 'custom_owned')).toHaveLength(5);
  });

  it('never awards a second new LP for the same Meaning', () => {
    const earlier = [prior('new_meaning_completed', 'a', addHours(NOW, -24 * 30), 5)];
    expect(lpAwards(input(SESSION_MODE.DAILY, [{ id: 't', phase: TASK_PHASE.NEW_PRACTICE, meanings: ['a'] }],
      { newMeaningIds: ['a'], prior: earlier }))).toEqual([]);
  });

  it('keys a due award by its due cycle and enforces the 20 h gap and 3-in-7-days cap', () => {
    const tasks: TaskSpec[] = [{ id: 't', phase: TASK_PHASE.DUE_REVIEW, meanings: ['a'] }];
    const fresh = lpAwards(input(SESSION_MODE.DAILY, tasks, { progress: due('a') }));
    expect(fresh).toEqual([expect.objectContaining({ type: 'due_review_completed', points: 4, awardKey: `due:a:${DUE.toISOString()}` })]);

    const twelveHoursAgo = [prior('due_review_completed', 'a', addHours(NOW, -12), 4)];
    expect(lpAwards(input(SESSION_MODE.DAILY, tasks, { progress: due('a'), prior: twelveHoursAgo }))).toEqual([]);

    const threeThisWeek = [-30, -60, -100].map((h) => prior('due_review_completed', 'a', addHours(NOW, h), 4));
    expect(lpAwards(input(SESSION_MODE.DAILY, tasks, { progress: due('a'), prior: threeThisWeek }))).toEqual([]);
    expect(lpAwards(input(SESSION_MODE.DAILY, tasks, { progress: due('a'), prior: threeThisWeek.slice(1) }))).toHaveLength(1);
  });

  it('pays +4 only for a word due when planned; one that came due mid-session gets +1 in practice', () => {
    const tasks: TaskSpec[] = [{ id: 't', phase: TASK_PHASE.RANDOM_PRACTICE, meanings: ['a', 'b'] }];
    const progress = new Map([['a', { nextReviewAt: DUE }], ['b', { nextReviewAt: addHours(ISSUED, 0.5) }]]);
    const awards = lpAwards(input(SESSION_MODE.RANDOM_PRACTICE, tasks, { progress }));
    expect(awards.map((a) => [a.meaningId, a.points])).toEqual([['a', 4], ['b', 1]]);
  });

  it('gives extra practice at most +1 per Meaning a day and 10 LP a day overall', () => {
    const many = ids(11, 'p');
    const tasks: TaskSpec[] = [
      { id: 't1', phase: TASK_PHASE.WEAK_WORDS_PRACTICE, meanings: many },
      { id: 't2', phase: TASK_PHASE.WEAK_WORDS_PRACTICE, meanings: ['p0'] },
    ];
    const awards = lpAwards(input(SESSION_MODE.WEAK_WORDS_PRACTICE, tasks, { progress: notDue(...many) }));
    expect(total(awards)).toBe(10);
    expect(new Set(awards.map((a) => a.meaningId)).size).toBe(10);

    const earlierToday = [prior('extra_practice_completed', 'p0', addHours(NOW, -2), 1), prior('extra_practice_completed', 'z', addHours(NOW, -2), 1)];
    const again = lpAwards(input(SESSION_MODE.RANDOM_PRACTICE, tasks, { progress: notDue(...many), prior: earlierToday }));
    expect(again.map((a) => a.meaningId)).not.toContain('p0');
    expect(total(again)).toBe(8);
  });

  it('gives no extra practice on the day a Meaning was learned, nor in Daily', () => {
    const learned = [prior('new_meaning_completed', 'a', addHours(NOW, -1), 5)];
    expect(lpAwards(input(SESSION_MODE.RANDOM_PRACTICE, [{ id: 't', phase: TASK_PHASE.RANDOM_PRACTICE, meanings: ['a'] }],
      { progress: notDue('a'), prior: learned }))).toEqual([]);
    expect(lpAwards(input(SESSION_MODE.DAILY, [{ id: 't', phase: TASK_PHASE.DUE_REVIEW, meanings: ['b'] }], { progress: notDue('b') }))).toEqual([]);
  });

  it('allows due then extra on the same day from separate sessions', () => {
    const dueEarlier = [prior('due_review_completed', 'a', addHours(NOW, -3), 4)];
    const awards = lpAwards(input(SESSION_MODE.CHECKPOINT_CHALLENGE, [{ id: 't', phase: TASK_PHASE.CHECKPOINT_CHALLENGE, meanings: ['a'] }],
      { progress: notDue('a'), prior: dueEarlier }));
    expect(awards).toEqual([expect.objectContaining({ type: 'extra_practice_completed', awardKey: 'extra:a:2026-11-12' })]);
  });
});
