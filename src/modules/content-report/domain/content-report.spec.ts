import { CONTENT_REPORT_REASON, CONTENT_REPORT_SOURCE, CONTENT_REPORT_STATUS } from '../../../common/constants/domain';
import { canTransition, reasonProblem, reportTarget } from './content-report';

const { LEARN_CARD, PRACTICE_TASK, WORD_DETAIL } = CONTENT_REPORT_SOURCE;
const R = CONTENT_REPORT_REASON;
const S = CONTENT_REPORT_STATUS;

describe('content report rules', () => {
  it('keeps task-only reasons on practice tasks and asks for what each reason needs', () => {
    expect(reasonProblem(WORD_DETAIL, R.INCORRECT_QUESTION, { hasAttempt: false })).not.toBeNull();
    expect(reasonProblem(LEARN_CARD, R.ANSWER_SHOULD_BE_ACCEPTED, { hasAttempt: true })).not.toBeNull();
    expect(reasonProblem(PRACTICE_TASK, R.ANSWER_SHOULD_BE_ACCEPTED, { hasAttempt: false })).not.toBeNull();
    expect(reasonProblem(PRACTICE_TASK, R.ANSWER_SHOULD_BE_ACCEPTED, { hasAttempt: true })).toBeNull();
    expect(reasonProblem(WORD_DETAIL, R.OTHER, { hasAttempt: false })).not.toBeNull();
    expect(reasonProblem(WORD_DETAIL, R.OTHER, { note: 'x', hasAttempt: false })).toBeNull();
    expect(reasonProblem(LEARN_CARD, R.AUDIO_ISSUE, { hasAttempt: false })).toBeNull();
  });

  it('only reopens a closed report', () => {
    expect(canTransition(S.PENDING, S.RESOLVED)).toBe(true);
    expect(canTransition(S.RESOLVED, S.DISMISSED)).toBe(false);
    expect(canTransition(S.DISMISSED, S.PENDING)).toBe(true);
    expect(canTransition(S.UNDER_REVIEW, S.UNDER_REVIEW)).toBe(false);
  });

  it('keys a learn card and a word detail of one revision alike, and a new revision apart', () => {
    const card = reportTarget([{ meaningId: 'm1', publicationId: 'p1' }]);
    expect(card.targetKey).toBe('meaning:m1@p1');
    expect(reportTarget([{ meaningId: 'm1', publicationId: 'p2' }]).targetKey).not.toBe(card.targetKey);
  });

  it('keys a curated task by its item and a generated one by template and sorted Meanings', () => {
    expect(reportTarget([{ meaningId: 'm1', publicationId: 'p1' }], { template: 'select', variant: null, curatedItemId: 'i1' }))
      .toEqual({ targetKey: 'item:i1', contentVersion: 'i1' });
    const a = reportTarget([{ meaningId: 'm2', publicationId: 'p2' }, { meaningId: 'm1', publicationId: 'p1' }], { template: 'match', variant: null, curatedItemId: null });
    expect(a.targetKey).toBe('task:match/-:m1,m2@p1,p2');
  });
});
