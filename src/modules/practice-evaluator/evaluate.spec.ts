import { EVENT_ACTION, OUTCOME, TEMPLATE, VALIDITY } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { EvaluateInput, evaluateTask } from './evaluate';
import { TaskEvent } from './events';
import { normalizeAnswer, splitGraphemes } from './normalizer';

const events = (...items: object[]) => items.map((e, i) => ({ seq: i + 1, ...e })) as TaskEvent[];
const run = (input: Partial<EvaluateInput>) =>
  evaluateTask({ template: TEMPLATE.select, body: {}, key: {}, targetOrdinals: [0], events: [], ...input }).targets;

const SELECT = {
  body: { options: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] },
  key: { correctOptionId: 1 },
};
const TILES = {
  template: TEMPLATE.flyReorder,
  body: { tiles: [{ id: 1, text: 'n' }, { id: 2, text: 'o' }, { id: 3, text: 'o' }, { id: 4, text: 'n' }] },
  key: { acceptedResponses: ['noon'] },
};
const tap = (tileId: number) => ({ action: EVENT_ACTION.tapTile, tileId });

describe('normalizer', () => {
  it('normalizes NFC, case and whitespace', () => {
    expect(normalizeAnswer('  Café   Au ')).toBe('café au');
  });
  it('splits grapheme clusters rather than code units', () => {
    expect(splitGraphemes('éa👍🏽')).toEqual(['é', 'a', '👍🏽']);
  });
});

describe('evaluators', () => {
  it('C15 first wrong then correct is not a clean success', () => {
    const [t] = run({
      template: TEMPLATE.typing, key: { acceptedResponses: ['clarify'] },
      events: events({ action: 'submit', value: 'clarfy' }, { action: 'submit', value: 'Clarify ' }),
    });
    expect(t).toMatchObject({ outcome: OUTCOME.correctedAfterRetry, firstAttemptCorrect: false, attemptCount: 2 });
  });

  it('C16 records hints before the first correct answer', () => {
    const [t] = run({
      template: TEMPLATE.typing, key: { acceptedResponses: ['clarify'] },
      events: events({ action: 'hint' }, { action: 'submit', value: 'clarify' }),
    });
    expect(t).toMatchObject({ outcome: OUTCOME.correct, hintCount: 1 });
  });

  it('select shares one evaluator keyed on correctOptionId', () => {
    expect(run({ ...SELECT, events: events({ action: 'submit', optionId: 1 }) })[0].outcome).toBe(OUTCOME.correct);
    expect(run({ ...SELECT, events: events({ action: 'submit', optionId: 2 }) })[0].outcome).toBe(OUTCOME.incorrect);
  });

  it('rejects unknown options, stale seq and events after success', () => {
    const invalid = (e: TaskEvent[]) => expect(() => run({ ...SELECT, events: e })).toThrow(ApiError);
    invalid(events({ action: 'submit', optionId: 9 }));
    invalid([{ seq: 2, action: 'hint' }, { seq: 2, action: 'submit', optionId: 1 }] as TaskEvent[]);
    invalid(events({ action: 'submit', optionId: 1 }, { action: 'submit', optionId: 1 }));
    invalid(events({ action: 'hint' }));
  });

  it('C18 keeps per-pair failure', () => {
    const targets = run({
      template: TEMPLATE.match,
      body: { pairs: { left: [{ id: 1, text: 'x' }, { id: 2, text: 'y' }], right: [{ id: 3, text: 'p' }, { id: 4, text: 'q' }] } },
      key: { correctPairs: [{ leftId: 1, rightId: 4 }, { leftId: 2, rightId: 3 }], pairTargets: { 1: 0, 2: 1 } },
      events: events(
        { action: 'pair', leftId: 1, rightId: 3 },
        { action: 'pair', leftId: 1, rightId: 4 },
        { action: 'pair', leftId: 2, rightId: 3 },
      ),
    });
    expect(targets.map((t) => t.outcome)).toEqual([OUTCOME.correctedAfterRetry, OUTCOME.correct]);
  });

  it('C48 C60 replays repeated letters by tile id, with undo and reorder', () => {
    const [t] = run({
      ...TILES,
      events: events(
        tap(1), tap(2), { action: 'removeTile', tileId: 2 }, tap(3), tap(2), tap(4),
        { action: 'moveTile', tileId: 4, toIndex: 3 },
        { action: 'submit', tileIds: [1, 3, 2, 4] },
      ),
    });
    expect(t.outcome).toBe(OUTCOME.correct);
  });

  it('C48 rejects reusing a tile or a submit that disagrees with replay', () => {
    expect(() => run({ ...TILES, events: events(tap(1), tap(1)) })).toThrow(ApiError);
    expect(() => run({ ...TILES, events: events(tap(1), { action: 'submit', tileIds: [2] }) })).toThrow(ApiError);
  });

  it('accepts the spec sample wrong first attempt', () => {
    const [t] = run({
      ...TILES,
      events: events(tap(2), tap(3), { action: 'moveTile', tileId: 3, toIndex: 0 }, { action: 'removeTile', tileId: 3 }, { action: 'submit', tileIds: [2] }),
    });
    expect(t).toMatchObject({ outcome: OUTCOME.incorrect, firstAttemptCorrect: false });
  });

  it('surgery compares grapheme index and replacement', () => {
    const input = { template: TEMPLATE.surgery, key: { wrongGraphemeIndex: 4, replacement: '' } };
    expect(run({ ...input, events: events({ action: 'submit', graphemeIndex: 4 }) })[0].outcome).toBe(OUTCOME.correct);
    expect(run({ ...input, events: events({ action: 'submit', graphemeIndex: 3 }) })[0].outcome).toBe(OUTCOME.incorrect);
  });

  it('C20 C32 recording terminal outcomes', () => {
    const id = '0190b0a0-0000-7000-8000-000000000001';
    const base = { template: TEMPLATE.recording };
    const receipts = (validity: string, passed: boolean | null) => new Map([[id, { id, validity, passed }]]);
    const assessed = events({ action: 'assessed', assessmentReceiptId: id });
    expect(run({ ...base, events: assessed, receipts: receipts(VALIDITY.valid, true) })[0].outcome).toBe(OUTCOME.assessedPassed);
    expect(run({ ...base, events: assessed, receipts: receipts(VALIDITY.valid, false) })[0].outcome).toBe(OUTCOME.assessedFailed);
    expect(run({ ...base, events: assessed, receipts: receipts(VALIDITY.invalid, null) })[0].outcome).toBe(OUTCOME.invalid);
    expect(run({ ...base, events: events({ action: 'unavailable', reason: 'microphoneDenied' }) })[0].outcome).toBe(OUTCOME.unavailable);
    expect(() => run({ ...base, events: assessed })).toThrow(ApiError);
  });
});
