import { z } from 'zod';
import { CEFR_LEVELS } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { hasLocaleCopy } from '../../practice-resolver/locale-copy';

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const cefr = z.enum(CEFR_LEVELS);
const locale = z.string().refine(hasLocaleCopy, 'Unsupported locale');

export const levelsSchema = z.strictObject({ proficiencyLevel: cefr });

export const settingsSchema = z
  .strictObject({
    explanationLocale: locale.optional(),
    uiLocale: locale.optional(),
    timeZone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').optional(),
    dailyNewWordGoal: z.number().int().min(1).max(30).optional(),
    weeklySessionGoal: z.number().int().min(1).max(POLICY.checkpoint.maxSessionsPerChallenge).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No settings provided');

export const scopeSchema = z.strictObject({
  collectionId: z.uuid(),
  topicIds: z.array(z.uuid()).min(1).max(100),
});
