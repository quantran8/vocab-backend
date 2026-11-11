import { describe, expect, it } from 'vitest';
import { POLICY } from '../../../config/policy';
import { buildMap, ChapterSummary, LevelBest } from './challenge-map';

const chapter = (chapterNo: number, levels: LevelBest[] = []): ChapterSummary =>
  ({ id: `c${chapterNo}`, chapterNo, explanationLocale: 'vi-VN', coreMeaningCount: 12, reviewMeaningCount: 0, levels });
const best = (levelNo: number, bestStars: number): LevelBest => ({ levelNo, bestStars, bestScore: bestStars * 100 });
const map = (chapters: ChapterSummary[], eligibleNewCount: number, activePlayable = true) =>
  buildMap({ levels: POLICY.challenge.levels, timeLimitMs: 90_000, chapters, activePlayable, eligibleNewCount, requiredNewCount: 12 });
const states = (m: ReturnType<typeof map>, i = 0) => m.chapters[i].levels.map((l) => l.state);

describe('buildMap', () => {
  it('before chapter 1: preview with progress, or ready at 12', () => {
    expect(map([], 5)).toMatchObject({ chapters: [], nextChapter: { chapterNo: 1, state: 'needs_vocabulary', eligibleNewCount: 5 }, currentNode: null });
    expect(map([], 12)).toMatchObject({ nextChapter: { chapterNo: 1, state: 'ready' }, currentNode: { chapterNo: 1, levelNo: 1 } });
  });

  it('opens levels one at a time and keeps stars', () => {
    const m = map([chapter(1, [best(1, 2)])], 30);
    expect(states(m)).toEqual(['cleared', 'available', 'locked']);
    expect(m.chapters[0]).toMatchObject({ state: 'active', starsEarned: 2, maxStars: 9 });
    expect(m.nextChapter.state).toBe('locked');
    expect(m.currentNode).toEqual({ chapterNo: 1, levelNo: 2 });
  });

  it('gives each level its goal and star rules', () => {
    expect(map([chapter(1)], 0).chapters[0].levels[1]).toMatchObject({
      levelNo: 2, goalMatches: 12, visiblePairs: 4, timeLimitMs: 90_000,
      starCriteria: { two: { maxElapsedMs: 80_000, maxMistakes: 3 }, three: { maxElapsedMs: 60_000, maxMistakes: 1 } },
    });
  });

  it('a 0-star attempt does not clear a level', () => {
    expect(states(map([chapter(1, [best(1, 0)])], 0))).toEqual(['available', 'locked', 'locked']);
  });

  it('a cleared chapter is completed and the next one opens with enough vocabulary', () => {
    const done = chapter(1, [best(1, 1), best(2, 1), best(3, 3)]);
    expect(map([done], 12)).toMatchObject({ chapters: [{ state: 'completed' }], nextChapter: { chapterNo: 2, state: 'ready' }, currentNode: { chapterNo: 2, levelNo: 1 } });
    expect(map([done], 11)).toMatchObject({ nextChapter: { state: 'needs_vocabulary' }, currentNode: null });
  });

  it('flags an active chapter that can no longer fill its levels', () => {
    expect(map([chapter(1)], 0, false)).toMatchObject({ chapters: [{ state: 'content_unavailable' }], currentNode: null });
  });
});
