import { CEFR_LEVELS, CefrLevel, PROMPT_TYPE, TEMPLATE, VARIANT } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { copyFor } from '../../practice-resolver/locale-copy';
import { DistractorView } from '../../practice-resolver/task.types';
import { Rng, shuffle } from '../../session-planner/domain/interleave';

export type PlacementCandidate = {
  meaningId: string;
  wordId: string;
  lemma: string;
  meaningText: string;
};

export interface PlacementAnswer {
  level: CefrLevel;
  correct: boolean;
}

const WRONG_OPTIONS = POLICY.newLearning.selectOptionCount - 1;

// Option ids are word ids, so grading needs no stored key and the payload does not reveal the answer.
function buildQuestion(candidate: PlacementCandidate, pool: DistractorView[], locale: string, rng: Rng) {
  const seen = new Set([candidate.meaningText]);
  const wrong = shuffle(pool, rng)
    .filter((d) => d.wordId !== candidate.wordId && !seen.has(d.meaningText) && seen.add(d.meaningText))
    .slice(0, WRONG_OPTIONS);
  if (wrong.length === 0) return null;
  return {
    id: candidate.meaningId,
    template: TEMPLATE.SELECT,
    variant: VARIANT.GLOSS,
    prompt: { type: PROMPT_TYPE.TEXT, text: candidate.lemma },
    question: copyFor(locale, 'select.gloss.question'),
    options: shuffle([candidate, ...wrong], rng).map(({ wordId, meaningText }) => ({ id: wordId, text: meaningText })),
  };
}

export const buildPlacementQuestions = (candidates: PlacementCandidate[], pool: DistractorView[], locale: string, rng: Rng) =>
  candidates.flatMap((candidate) => buildQuestion(candidate, pool, locale, rng) ?? []);

/** Levels with no questions are skipped, so a content gap neither blocks nor grants a level. */
export function estimateLevel(answers: PlacementAnswer[]): CefrLevel {
  let estimated: CefrLevel = CEFR_LEVELS[0];
  for (const level of CEFR_LEVELS) {
    const asked = answers.filter((a) => a.level === level);
    if (asked.length === 0) continue;
    if (asked.filter((a) => a.correct).length / asked.length < POLICY.placement.minCorrectRatio) break;
    estimated = level;
  }
  return estimated;
}
