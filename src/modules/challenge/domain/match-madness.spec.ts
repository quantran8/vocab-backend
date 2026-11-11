import { describe, expect, it } from 'vitest';
import { POLICY } from '../../../config/policy';
import { Board, buildPlan, buildQueue, columnOrder, hashHex, LevelRule, MatchEvent, replay, RunPlan, SlotContent, starsFor } from './match-madness';

const rules = POLICY.challenge;
const [L1, L2, L3]: readonly LevelRule[] = rules.levels;
const content = (n: number, prefix = 'm'): SlotContent[] =>
  Array.from({ length: n }, (_, i) => ({ meaningId: `${prefix}${String(i).padStart(2, '0')}`, lemma: `w${prefix}${i}`, gloss: `g${prefix}${i}` }));

function plan(level: LevelRule, core = content(12), review: SlotContent[] = [], seed = 'seed-1'): RunPlan {
  let n = 0;
  const queue = buildQueue({ seed, level, rules, core, review })!;
  return buildPlan({ seed, explanationLocale: 'vi-VN', level, rules, queue, newId: () => `id-${String(n++).padStart(3, '0')}` });
}

/** Plays the board in on-screen order; `wrongAt` inserts a wrong pair before those correct-match counts. */
function play(p: RunPlan, opts: { stepMs?: number; wrongAt?: number[]; stopAfter?: number } = {}) {
  const board = new Board(p, rules.minMatchesBetweenRepeats);
  const events: MatchEvent[] = [];
  const add = (wordTileId: string, meaningTileId: string) =>
    events.push({ seq: events.length + 1, type: 'match', elapsedMs: (events.length + 1) * (opts.stepMs ?? 1000), wordTileId, meaningTileId });
  const seen: string[][] = [];
  while (!board.done && board.correctCount < (opts.stopAfter ?? Infinity)) {
    const { words } = board.order();
    seen.push(board.active.map((a) => a.meaningId));
    const pair = board.active.find((a) => a.wordTileId === words[0])!;
    if (opts.wrongAt?.includes(board.correctCount) && board.active.length > 1) {
      const other = board.active.find((a) => a !== pair)!;
      add(pair.wordTileId, other.meaningTileId);
      board.match(pair.wordTileId, other.meaningTileId);
      opts.wrongAt = opts.wrongAt.filter((n) => n !== board.correctCount);
    }
    add(pair.wordTileId, pair.meaningTileId);
    board.match(pair.wordTileId, pair.meaningTileId);
  }
  return { events, seen };
}

describe('buildQueue', () => {
  it.each([[L1, 8], [L2, 12]])('level %# uses distinct core Meanings only', (level, target) => {
    const queue = buildQueue({ seed: 's', level, rules, core: content(12), review: content(3, 'r') })!;
    expect(queue).toHaveLength(target);
    expect(new Set(queue.map((q) => q.meaningId)).size).toBe(target);
    expect(queue.every((q) => q.meaningId.startsWith('m'))).toBe(true);
  });

  it('level 3 is 16 occurrences: 12 core + 3 review + 1 repeat, never adjacent, at most twice', () => {
    const queue = buildQueue({ seed: 's', level: L3, rules, core: content(12), review: content(3, 'r') })!;
    expect(queue).toHaveLength(16);
    const counts = new Map<string, number[]>();
    queue.forEach((q, i) => counts.set(q.meaningId, [...(counts.get(q.meaningId) ?? []), i]));
    expect(counts.size).toBe(15);
    for (const positions of counts.values()) {
      expect(positions.length).toBeLessThanOrEqual(2);
      if (positions.length === 2) expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(L3.visiblePairs + rules.minMatchesBetweenRepeats);
    }
  });

  it('level 3 without review repeats 4 core Meanings, spaced apart', () => {
    const queue = buildQueue({ seed: 's', level: L3, rules, core: content(12), review: [] })!;
    expect(queue).toHaveLength(16);
    const firsts = new Map<string, number>();
    queue.forEach((q, i) => {
      if (firsts.has(q.meaningId)) expect(i - firsts.get(q.meaningId)!).toBeGreaterThanOrEqual(L3.visiblePairs + rules.minMatchesBetweenRepeats);
      else firsts.set(q.meaningId, i);
    });
    expect(firsts.size).toBe(12);
  });

  it('is deterministic per seed and differs across seeds', () => {
    const ids = (seed: string) => buildQueue({ seed, level: L2, rules, core: content(12), review: [] })!.map((q) => q.meaningId);
    expect(ids('a')).toEqual(ids('a'));
    expect(ids('a')).not.toEqual(ids('b'));
  });

  it('refuses a level the content cannot fill', () => {
    expect(buildQueue({ seed: 's', level: L1, rules, core: content(7), review: [] })).toBeNull();
    expect(buildQueue({ seed: 's', level: L3, rules, core: content(11), review: content(3, 'r') })).toBeNull();
  });
});

describe('columnOrder', () => {
  // Shared with the iOS client (CryptoKit): SHA256(UTF8(seed|correctCount|side|tileId)), lowercase hex, ascending.
  const seed = '00112233445566778899aabbccddeeff';
  const ids = ['018f0000-0000-7000-8000-000000000001', '018f0000-0000-7000-8000-000000000002', '018f0000-0000-7000-8000-000000000003'];

  it('matches the shared test vectors', () => {
    expect(hashHex(seed, 0, 'word', ids[0])).toBe('a1eedcdd4a2b5f8ffd4f2133437cc340a0fcb76214ccc2dd789dbc2aac1a8158');
    expect(columnOrder(seed, 0, 'word', ids)).toEqual([ids[0], ids[2], ids[1]]);
    expect(columnOrder(seed, 0, 'meaning', ids)).toEqual([ids[1], ids[0], ids[2]]);
    expect(columnOrder(seed, 1, 'word', ids)).toEqual([ids[0], ids[1], ids[2]]);
    expect(columnOrder(seed, 1, 'meaning', ids)).toEqual([ids[0], ids[2], ids[1]]);
  });
});

describe('Board', () => {
  it('shows visiblePairs at a time and refills after each correct match only', () => {
    const p = plan(L2);
    const board = new Board(p, rules.minMatchesBetweenRepeats);
    expect(board.active).toHaveLength(4);
    const [a, b] = board.active;
    expect(board.match(a.wordTileId, b.meaningTileId)).toBe(false);
    expect(board.active).toHaveLength(4);
    expect(board.match(a.wordTileId, a.meaningTileId)).toBe(true);
    expect(board.active).toHaveLength(4);
    expect(board.active).not.toContain(a);
    expect(board.match(a.wordTileId, a.meaningTileId)).toBeNull();
  });

  it('never shows one Meaning twice at once, and waits 3 matches before a repeat', () => {
    const p = plan(L3, content(12), []);
    const { seen } = play(p);
    for (const ids of seen) expect(new Set(ids).size).toBe(ids.length);
    const board = new Board(p, rules.minMatchesBetweenRepeats);
    const matchedAt = new Map<string, number>();
    while (!board.done) {
      for (const a of board.active) {
        const last = matchedAt.get(a.meaningId);
        if (last !== undefined) expect(board.correctCount - last).toBeGreaterThanOrEqual(rules.minMatchesBetweenRepeats);
      }
      const pair = board.active[0];
      board.match(pair.wordTileId, pair.meaningTileId);
      matchedAt.set(pair.meaningId, board.correctCount);
    }
  });
});

describe('starsFor', () => {
  it.each([
    [L1, 60_000, 0, 3], [L1, 60_001, 0, 2], [L1, 80_000, 2, 2], [L1, 80_000, 3, 1], [L1, 90_000, 0, 1],
    [L2, 60_000, 1, 3], [L2, 60_000, 2, 2], [L3, 65_000, 1, 3], [L3, 65_001, 1, 2], [L3, 80_001, 0, 1],
  ])('level %#: %i ms, %i mistakes → %i stars', (level, ms, mistakes, stars) => {
    expect(starsFor(level.stars, ms, mistakes)).toBe(stars);
  });
});

describe('replay', () => {
  it('scores the spec example: 12 matches, 1 mistake after 8, 68.6 s → 1685', () => {
    const p = plan(L2);
    const { events } = play(p, { wrongAt: [8] });
    const last = events.at(-1)!;
    const timed = events.map((e) => (e === last ? { ...e, elapsedMs: 68_600 } : e));
    const out = replay(p, rules, { events: timed, endedReason: 'goal_reached', endedElapsedMs: 68_600 });
    expect(out).toEqual({ ok: true, result: { outcome: 'cleared', starsThisRun: 2, correctMatches: 12, mistakes: 1, longestCombo: 8, elapsedMs: 68_600, score: 1685 } });
  });

  it('a clean fast clear gets 3 stars', () => {
    const p = plan(L1);
    const { events } = play(p);
    const out = replay(p, rules, { events, endedReason: 'goal_reached', endedElapsedMs: events.at(-1)!.elapsedMs });
    expect(out.ok && out.result).toMatchObject({ outcome: 'cleared', starsThisRun: 3, mistakes: 0, longestCombo: 8 });
  });

  it('time_up and quit give 0 stars', () => {
    const p = plan(L1);
    const { events } = play(p, { stopAfter: 3 });
    expect(replay(p, rules, { events, endedReason: 'time_up', endedElapsedMs: 90_000 })).toMatchObject({ ok: true, result: { outcome: 'failed', starsThisRun: 0, correctMatches: 3 } });
    expect(replay(p, rules, { events, endedReason: 'quit', endedElapsedMs: 5_000 })).toMatchObject({ ok: true, result: { outcome: 'quit', starsThisRun: 0 } });
    expect(replay(p, rules, { events: [], endedReason: 'quit', endedElapsedMs: 0 })).toMatchObject({ ok: true, result: { score: 0 } });
  });

  it('scores with the plan frozen at issue, not the current policy', () => {
    const p = plan(L1);
    const { events } = play(p);
    const ended = { events, endedReason: 'goal_reached' as const, endedElapsedMs: events.at(-1)!.elapsedMs };
    const now = { ...rules, score: { ...rules.score, match: 0, streakStep: 0, perSecondLeft: 0 } };
    expect(replay(p, now, ended)).toEqual(replay(p, rules, ended));
    expect(replay({ ...p, score: undefined }, now, ended)).toMatchObject({ ok: true, result: { score: 0 } });
  });

  it('clamps a negative score to 0', () => {
    const p = plan(L1);
    const [a, b] = new Board(p, rules.minMatchesBetweenRepeats).active;
    const events = [1, 2, 3].map((seq) => ({ seq, type: 'match', elapsedMs: seq * 100, wordTileId: a.wordTileId, meaningTileId: b.meaningTileId }));
    expect(replay(p, rules, { events, endedReason: 'quit', endedElapsedMs: 300 })).toMatchObject({ ok: true, result: { score: 0, mistakes: 3 } });
  });

  it.each<[string, (e: MatchEvent[]) => MatchEvent[], string, number | null]>([
    ['a gap in seq', (e) => e.map((x, i) => (i === 1 ? { ...x, seq: 5 } : x)), 'quit', 50_000],
    ['elapsed going back', (e) => e.map((x, i) => (i === 1 ? { ...x, elapsedMs: 1 } : x)), 'quit', 50_000],
    ['a tile not on the board', (e) => e.map((x, i) => (i === 0 ? { ...x, wordTileId: 'nope' } : x)), 'quit', 50_000],
    ['a match after the deadline', (e) => e.map((x, i) => (i === 0 ? { ...x, elapsedMs: 90_001 } : x)), 'quit', 50_000],
    ['goal_reached without the goal', (e) => e.slice(0, 3), 'goal_reached', 3_000],
    ['quit after the goal', (e) => e, 'quit', null],
    ['time_up before the limit', (e) => e.slice(0, 3), 'time_up', 80_000],
    ['ending before the last match', (e) => e.slice(0, 3), 'quit', 100],
    ['quit exactly at the deadline', (e) => e.slice(0, 3), 'quit', 90_000],
    ['an event after the goal', (e) => [...e, { ...e[0], seq: e.length + 1, elapsedMs: 89_000 }], 'goal_reached', 89_000],
  ])('rejects %s', (_, edit, endedReason, ended) => {
    const p = plan(L1);
    const events = edit(play(p).events);
    const out = replay(p, rules, { events, endedReason: endedReason as 'quit', endedElapsedMs: ended ?? events.at(-1)!.elapsedMs });
    expect(out.ok).toBe(false);
  });

  it('accepts the goal exactly at 90 000 ms', () => {
    const p = plan(L1);
    const { events } = play(p, { stepMs: 11_250 });
    expect(events.at(-1)!.elapsedMs).toBe(90_000);
    expect(replay(p, rules, { events, endedReason: 'goal_reached', endedElapsedMs: 90_000 })).toMatchObject({ ok: true, result: { starsThisRun: 1 } });
  });
});
