import { EVENT_ACTION, OUTCOME, TEMPLATE, VALIDITY } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { EvaluateInput, evaluateTask } from './evaluate';
import { TaskEvent } from './events';
import { normalizeAnswer, splitGraphemes } from './normalizer';

const events = (...items: object[]) => items.map((e, i) => ({ seq: i + 1, ...e })) as TaskEvent[];
const run = (input: Partial<EvaluateInput>) =>
  evaluateTask({ template: TEMPLATE.SELECT, body: {}, key: {}, targetOrdinals: [0], events: [], ...input }).targets;

const SELECT = {
  body: { options: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] },
  key: { correctOptionId: 1 },
};
const TILES = {
  template: TEMPLATE.FLY_REORDER,
  body: { tiles: [{ id: 1, text: 'n' }, { id: 2, text: 'o' }, { id: 3, text: 'o' }, { id: 4, text: 'n' }] },
  key: { acceptedResponses: ['noon'] },
};
const tap = (tileId: number) => ({ action: EVENT_ACTION.TAP_TILE, tileId });

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
      template: TEMPLATE.TYPING, key: { acceptedResponses: ['clarify'] },
      events: events({ action: 'submit', value: 'clarfy' }, { action: 'submit', value: 'Clarify ' }),
    });
    expect(t).toMatchObject({ outcome: OUTCOME.CORRECTED_AFTER_RETRY, firstAttemptCorrect: false, attemptCount: 2 });
  });

  it('C16 records hints before the first correct answer', () => {
    const [t] = run({
      template: TEMPLATE.TYPING, key: { acceptedResponses: ['clarify'] },
      events: events({ action: 'hint' }, { action: 'submit', value: 'clarify' }),
    });
    expect(t).toMatchObject({ outcome: OUTCOME.CORRECT, hintCount: 1 });
  });

  it('select shares one evaluator keyed on correctOptionId', () => {
    expect(run({ ...SELECT, events: events({ action: 'submit', optionId: 1 }) })[0].outcome).toBe(OUTCOME.CORRECT);
    expect(run({ ...SELECT, events: events({ action: 'submit', optionId: 2 }) })[0].outcome).toBe(OUTCOME.INCORRECT);
  });

  it('rejects unknown options, stale seq and events after success', () => {
    const invalid = (e: TaskEvent[]) => expect(() => run({ ...SELECT, events: e })).toThrow(ApiError);
    invalid(events({ action: 'submit', optionId: 9 }));
    invalid([{ seq: 2, action: 'hint' }, { seq: 2, action: 'submit', optionId: 1 }] as TaskEvent[]);
    invalid(events({ action: 'submit', optionId: 1 }, { action: 'submit', optionId: 1 }));
    invalid(events({ action: 'hint' }));
  });

  it('rejects a submit beyond maxRetries and scores an exhausted task incorrect', () => {
    const body = { ...SELECT.body, maxRetries: 1 };
    const wrong = { action: 'submit', optionId: 2 };
    expect(run({ ...SELECT, body, events: events(wrong, wrong) })[0]).toMatchObject({ outcome: OUTCOME.INCORRECT, attemptCount: 2 });
    expect(() => run({ ...SELECT, body, events: events(wrong, wrong, { action: 'submit', optionId: 1 }) })).toThrow('Attempt limit exceeded');
    expect(run({ ...SELECT, body, events: events(wrong, { action: 'submit', optionId: 1 }) })[0].outcome).toBe(OUTCOME.CORRECTED_AFTER_RETRY);
  });

  it('zero maxRetries allows only the first attempt', () => {
    const body = { ...SELECT.body, maxRetries: 0 };
    const wrong = { action: 'submit', optionId: 2 };
    expect(() => run({ ...SELECT, body, events: events(wrong, wrong) })).toThrow('Attempt limit exceeded');
  });

  it('snapshots without maxRetries stay unlimited', () => {
    const wrong = { action: 'submit', optionId: 2 };
    expect(run({ ...SELECT, events: events(wrong, wrong, wrong) })[0].attemptCount).toBe(3);
  });

  it('a pair out of retries finishes the board as incorrect', () => {
    const match = {
      template: TEMPLATE.MATCH,
      body: { maxRetries: 1, pairs: { left: [{ id: 1, text: 'x' }, { id: 2, text: 'y' }], right: [{ id: 3, text: 'p' }, { id: 4, text: 'q' }] } },
      key: { correctPairs: [{ leftId: 1, rightId: 4 }, { leftId: 2, rightId: 3 }], pairTargets: { 1: 0, 2: 1 } },
    };
    const wrongPair = { action: 'pair', leftId: 1, rightId: 3 };
    const targets = run({ ...match, events: events(wrongPair, wrongPair, { action: 'pair', leftId: 2, rightId: 3 }) });
    expect(targets.map((t) => t.outcome)).toEqual([OUTCOME.INCORRECT, OUTCOME.CORRECT]);
    expect(() => run({ ...match, events: events(wrongPair, wrongPair, wrongPair) })).toThrow('Attempt limit exceeded');
    expect(() => run({ ...match, events: events(wrongPair, { action: 'pair', leftId: 2, rightId: 3 }) })).toThrow('Match board is incomplete');
  });

  it('C18 keeps per-pair failure', () => {
    const targets = run({
      template: TEMPLATE.MATCH,
      body: { pairs: { left: [{ id: 1, text: 'x' }, { id: 2, text: 'y' }], right: [{ id: 3, text: 'p' }, { id: 4, text: 'q' }] } },
      key: { correctPairs: [{ leftId: 1, rightId: 4 }, { leftId: 2, rightId: 3 }], pairTargets: { 1: 0, 2: 1 } },
      events: events(
        { action: 'pair', leftId: 1, rightId: 3 },
        { action: 'pair', leftId: 1, rightId: 4 },
        { action: 'pair', leftId: 2, rightId: 3 },
      ),
    });
    expect(targets.map((t) => t.outcome)).toEqual([OUTCOME.CORRECTED_AFTER_RETRY, OUTCOME.CORRECT]);
  });

  it('C48 C60 replays repeated letters by tile id, with undo and reorder', () => {
    const [t] = run({
      ...TILES,
      events: events(
        tap(1), tap(2), { action: 'remove_tile', tileId: 2 }, tap(3), tap(2), tap(4),
        { action: 'move_tile', tileId: 4, toIndex: 3 },
        { action: 'submit', tileIds: [1, 3, 2, 4] },
      ),
    });
    expect(t.outcome).toBe(OUTCOME.CORRECT);
  });

  it('C48 rejects reusing a tile or a submit that disagrees with replay', () => {
    expect(() => run({ ...TILES, events: events(tap(1), tap(1)) })).toThrow(ApiError);
    expect(() => run({ ...TILES, events: events(tap(1), { action: 'submit', tileIds: [2] }) })).toThrow(ApiError);
  });

  it('accepts the spec sample wrong first attempt', () => {
    const [t] = run({
      ...TILES,
      events: events(tap(2), tap(3), { action: 'move_tile', tileId: 3, toIndex: 0 }, { action: 'remove_tile', tileId: 3 }, { action: 'submit', tileIds: [2] }),
    });
    expect(t).toMatchObject({ outcome: OUTCOME.INCORRECT, firstAttemptCorrect: false });
  });

  it('surgery compares grapheme index and replacement', () => {
    const input = { template: TEMPLATE.SURGERY, key: { wrongGraphemeIndex: 4, replacement: '' } };
    expect(run({ ...input, events: events({ action: 'submit', graphemeIndex: 4 }) })[0].outcome).toBe(OUTCOME.CORRECT);
    expect(run({ ...input, events: events({ action: 'submit', graphemeIndex: 3 }) })[0].outcome).toBe(OUTCOME.INCORRECT);
  });

  it('C20 C32 recording terminal outcomes', () => {
    const id = '0190b0a0-0000-7000-8000-000000000001';
    const base = { template: TEMPLATE.RECORDING };
    const receipts = (validity: string, passed: boolean | null) => new Map([[id, { id, validity, passed }]]);
    const assessed = events({ action: 'assessed', assessmentReceiptId: id });
    expect(run({ ...base, events: assessed, receipts: receipts(VALIDITY.VALID, true) })[0].outcome).toBe(OUTCOME.ASSESSED_PASSED);
    expect(run({ ...base, events: assessed, receipts: receipts(VALIDITY.VALID, false) })[0].outcome).toBe(OUTCOME.ASSESSED_FAILED);
    expect(run({ ...base, events: assessed, receipts: receipts(VALIDITY.INVALID, null) })[0].outcome).toBe(OUTCOME.INVALID);
    expect(run({ ...base, events: events({ action: 'unavailable', reason: 'microphoneDenied' }) })[0].outcome).toBe(OUTCOME.UNAVAILABLE);
    expect(() => run({ ...base, events: assessed })).toThrow(ApiError);
  });
});
