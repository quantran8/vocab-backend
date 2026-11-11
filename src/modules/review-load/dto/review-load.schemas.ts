import { z } from 'zod';
import { NEW_WORD_OVERRIDE_MODE, NEW_WORD_OVERRIDE_MODES } from '../../../common/constants/domain';

// The upper bound (below the goal) needs the stored goal, so the repository checks it.
export const overrideSchema = z
  .strictObject({
    value: z.number().int().min(1).max(29),
    mode: z.enum(NEW_WORD_OVERRIDE_MODES),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(({ mode, until }) => !until || mode === NEW_WORD_OVERRIDE_MODE.UNTIL_DATE, { path: ['until'], message: 'until requires until_date' });

export const ackSchema = z.strictObject({ backlog: z.number().int().min(0) });
