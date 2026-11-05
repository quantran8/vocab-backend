import { z } from 'zod';
import { CEFR_LEVELS } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

const maxQuestions = POLICY.placement.questionsPerLevel * CEFR_LEVELS.length;

export const placementSubmitSchema = z.strictObject({
  answers: z
    .array(z.strictObject({
      questionId: z.uuid(),
      // null means "I don't know": guessing would inflate the level.
      optionId: z.uuid().nullable(),
    }))
    .min(1)
    .max(maxQuestions)
    .refine((answers) => new Set(answers.map((a) => a.questionId)).size === answers.length, 'Duplicate questionId'),
});
export type PlacementSubmit = z.infer<typeof placementSubmitSchema>;
