import { Injectable } from '@nestjs/common';
import { CefrLevel } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { POLICY } from '../../../config/policy';
import { IdentityRepository } from '../../identity/repositories/identity.repository';
import { PlannerRepository } from '../../session-planner/repositories/planner.repository';
import { buildPlacementQuestions, estimateLevel } from '../domain/placement';
import { PlacementSubmit } from '../dto/placement.schemas';
import { PlacementRepository } from '../repositories/placement.repository';

const { questionsPerLevel } = POLICY.placement;

@Injectable()
export class PlacementService {
  constructor(
    private readonly repository: PlacementRepository,
    private readonly planner: PlannerRepository,
    private readonly identity: IdentityRepository,
  ) {}

  // Empty when there is too little content; the client falls back to self-select.
  async getTest(userId: string) {
    const locale = await this.repository.explanationLocale(userId);
    if (!locale) throw new ApiError('NOT_FOUND', 'Settings not found');
    const [candidates, pool] = await Promise.all([
      this.repository.candidates(locale, questionsPerLevel),
      this.planner.distractorPool(locale, POLICY.session.distractorPoolSize),
    ]);
    return { questions: buildPlacementQuestions(candidates, pool, locale, Math.random) };
  }

  // Sets the level only: no learnedAt, review history or skill evidence (spec §2.7).
  async submit(userId: string, { answers }: PlacementSubmit) {
    const keys = await this.repository.questionKeys(answers.map((a) => a.questionId));
    const byMeaning = new Map(keys.map((k) => [k.meaningId, k]));
    const scored = answers.flatMap(({ questionId, optionId }) => {
      const key = byMeaning.get(questionId);
      return key ? [{ level: key.level as CefrLevel, correct: optionId === key.wordId }] : [];
    });
    if (scored.length === 0) throw new ApiError('VALIDATION_FAILED', 'No known questions in answers');

    const proficiencyLevel = estimateLevel(scored);
    await this.identity.updateProficiency(userId, proficiencyLevel);
    return { proficiencyLevel, correctCount: scored.filter((a) => a.correct).length, totalCount: scored.length };
  }
}
