import { SPEAKING_CHANGE, SPEAKING_METHOD, SPEAKING_STATUS } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { applySpeaking, SpeakingResult, SpeakingState } from './speaking-progress';

const NOW = new Date('2026-11-20T12:00:00Z');
const device = (passed: boolean): SpeakingResult => ({ pronunciationId: 'p', method: SPEAKING_METHOD.DEVICE, passed });
const azure = (score: number): SpeakingResult => ({ pronunciationId: 'p', method: SPEAKING_METHOD.AZURE, passed: score >= 80, score });

/** Applies one result per session, a day apart. */
function sessions(results: SpeakingResult[], start: SpeakingState | null = null) {
  let state = start;
  const changes = results.map((result, i) => {
    const { next, change } = applySpeaking(state, result, addHours(NOW, 24 * i));
    state = next;
    return change;
  });
  return { state: state!, changes };
}

describe('applySpeaking on-device', () => {
  it('a first pass is practicing; a second passing session in a row is fluent', () => {
    const first = applySpeaking(null, device(true), NOW);
    expect(first.next).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, deviceSessions: 1, deviceStreak: 1, lastPassed: true, fluentAt: null });
    expect(first.change).toBeNull();
    const { state, changes } = sessions([device(true), device(true)]);
    expect(state).toMatchObject({ status: SPEAKING_STATUS.FLUENT, deviceStreak: 2, fluentAt: addHours(NOW, 24) });
    expect(changes).toEqual([null, SPEAKING_CHANGE.BECAME_FLUENT]);
  });

  it('a miss resets the streak and slips a fluent word back', () => {
    const { state, changes } = sessions([device(true), device(true), device(true), device(false)]);
    expect(state).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, deviceStreak: 0, deviceSessions: 4, fluentAt: null, lastPassed: false });
    expect(changes).toEqual([null, SPEAKING_CHANGE.BECAME_FLUENT, null, SPEAKING_CHANGE.SLIPPED]);
    expect(sessions([device(true), device(false), device(true)]).state).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, deviceStreak: 1 });
  });

  it('keeps the first fluent date while the word stays fluent', () => {
    const { state } = sessions([device(true), device(true), device(true)]);
    expect(state.fluentAt).toEqual(addHours(NOW, 24));
  });
});

describe('applySpeaking with Azure scores', () => {
  it('averages with an EWMA and needs two scored sessions to be fluent', () => {
    const one = sessions([azure(95)]).state;
    expect(one).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, scoredSessions: 1, scoreAvg: 95, lastScore: 95, bestScore: 95 });
    const two = sessions([azure(95), azure(85)]);
    // 95 + 0.4 × (85 − 95) = 91
    expect(two.state).toMatchObject({ status: SPEAKING_STATUS.FLUENT, scoreAvg: 91, lastScore: 85, bestScore: 95 });
    expect(two.changes).toEqual([null, SPEAKING_CHANGE.BECAME_FLUENT]);
  });

  it('holds the status between the slip and fluent thresholds', () => {
    // 90, then 90 + 0.4 × (70 − 90) = 82: still fluent; then 82 + 0.4 × (60 − 82) = 73.2: below 75, practicing.
    const { state, changes } = sessions([azure(90), azure(90), azure(70), azure(60)]);
    expect(changes).toEqual([null, SPEAKING_CHANGE.BECAME_FLUENT, null, SPEAKING_CHANGE.SLIPPED]);
    expect(state).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, scoreAvg: 73.2, bestScore: 90 });
    // Climbing back: 73.2 → 79.92 stays practicing until the average reaches 85.
    expect(sessions([azure(90)], state).state).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, scoreAvg: 79.92 });
  });
});

describe('applySpeaking across methods', () => {
  it('the current session\'s method decides; the other track is kept', () => {
    const { state, changes } = sessions([azure(95), azure(95), device(false)]);
    expect(changes).toEqual([null, SPEAKING_CHANGE.BECAME_FLUENT, SPEAKING_CHANGE.SLIPPED]);
    expect(state).toMatchObject({ status: SPEAKING_STATUS.PRACTICING, scoredSessions: 2, scoreAvg: 95, deviceSessions: 1, deviceStreak: 0 });
    // A high Azure average makes it fluent again on the next scored session, whatever the device streak.
    expect(sessions([azure(95)], state).state.status).toBe(SPEAKING_STATUS.FLUENT);
  });
});
