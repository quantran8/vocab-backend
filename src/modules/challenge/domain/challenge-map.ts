import {
  CHALLENGE_CHAPTER_STATE, CHALLENGE_LEVEL_STATE, CHALLENGE_NEXT_CHAPTER_STATE, ChallengeLevelState,
} from '../../../common/constants/domain';
import { LevelRule, MAX_STARS } from './match-madness';

export interface LevelBest { levelNo: number; bestStars: number; bestScore: number }
export interface ChapterSummary {
  id: string;
  chapterNo: number;
  explanationLocale: string;
  coreMeaningCount: number;
  reviewMeaningCount: number;
  levels: LevelBest[];
}

/** Sequential: a level opens once the one before it has a star. */
export function levelStates(levelCount: number, bests: LevelBest[]) {
  const byNo = new Map(bests.map((b) => [b.levelNo, b]));
  let open = true;
  return Array.from({ length: levelCount }, (_, i) => {
    const best = byNo.get(i + 1);
    const cleared = (best?.bestStars ?? 0) > 0;
    const state: ChallengeLevelState = cleared ? CHALLENGE_LEVEL_STATE.CLEARED : open ? CHALLENGE_LEVEL_STATE.AVAILABLE : CHALLENGE_LEVEL_STATE.LOCKED;
    if (!cleared) open = false;
    return { levelNo: i + 1, state, bestStars: best?.bestStars ?? 0, bestScore: best?.bestScore ?? 0 };
  });
}

export const isChapterCleared = (levelCount: number, bests: LevelBest[]) =>
  bests.some((b) => b.levelNo === levelCount && b.bestStars > 0);

export function buildMap(input: {
  levels: readonly LevelRule[];
  timeLimitMs: number;
  chapters: ChapterSummary[];
  /** False when the earliest uncleared chapter cannot fill its levels any more. */
  activePlayable: boolean;
  eligibleNewCount: number;
  requiredNewCount: number;
}) {
  const levelCount = input.levels.length;
  let currentNode: { chapterNo: number; levelNo: number } | null = null;
  const chapters = input.chapters.map((c) => {
    const levels = levelStates(levelCount, c.levels).map((l, i) => ({
      ...l, goalMatches: input.levels[i].targetMatches, visiblePairs: input.levels[i].visiblePairs,
      timeLimitMs: input.timeLimitMs, starCriteria: input.levels[i].stars,
    }));
    const completed = isChapterCleared(levelCount, c.levels);
    const available = levels.find((l) => l.state === CHALLENGE_LEVEL_STATE.AVAILABLE);
    if (!completed && available && input.activePlayable) currentNode = { chapterNo: c.chapterNo, levelNo: available.levelNo };
    return {
      id: c.id,
      chapterNo: c.chapterNo,
      state: completed ? CHALLENGE_CHAPTER_STATE.COMPLETED
        : input.activePlayable ? CHALLENGE_CHAPTER_STATE.ACTIVE : CHALLENGE_CHAPTER_STATE.CONTENT_UNAVAILABLE,
      titleKey: `challenge.chapter.${c.chapterNo}`,
      explanationLocale: c.explanationLocale,
      coreMeaningCount: c.coreMeaningCount,
      reviewMeaningCount: c.reviewMeaningCount,
      starsEarned: levels.reduce((sum, l) => sum + l.bestStars, 0),
      maxStars: levelCount * MAX_STARS,
      levels,
    };
  });

  const last = chapters.at(-1);
  const blocked = last !== undefined && last.state !== CHALLENGE_CHAPTER_STATE.COMPLETED;
  const ready = input.eligibleNewCount >= input.requiredNewCount;
  const nextChapterNo = (last?.chapterNo ?? 0) + 1;
  const nextChapter = {
    chapterNo: nextChapterNo,
    state: blocked ? CHALLENGE_NEXT_CHAPTER_STATE.LOCKED : ready ? CHALLENGE_NEXT_CHAPTER_STATE.READY : CHALLENGE_NEXT_CHAPTER_STATE.NEEDS_VOCABULARY,
    eligibleNewCount: input.eligibleNewCount,
    requiredNewCount: input.requiredNewCount,
  };
  if (!blocked && ready) currentNode = { chapterNo: nextChapterNo, levelNo: 1 };
  return { chapters, nextChapter, currentNode };
}
