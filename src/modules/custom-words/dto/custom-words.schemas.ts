import { z } from 'zod';
import { POLICY } from '../../../config/policy';

const { maxTextLength, maxContextLength, maxSensesPerDraft } = POLICY.customWords;
const TEXT_PATTERN = /^\p{L}[\p{L}\p{M}'‘’ -]*$/u;
const MAX_FIELD_LENGTH = 500;

const field = z.string().trim().min(1).max(MAX_FIELD_LENGTH);

export const lookupSchema = z.strictObject({
  text: z.string().trim().min(1).max(maxTextLength).regex(TEXT_PATTERN),
  context: z.string().trim().min(1).max(maxContextLength).optional(),
});
export type LookupRequest = z.infer<typeof lookupSchema>;

export const overrideSchema = z.strictObject({
  meaningText: field.optional(),
  definitionText: field.optional(),
  examples: z.array(z.strictObject({
    text: field,
    translation: field,
    targetLocator: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(1) }),
  })).min(1).max(maxSensesPerDraft).optional(),
}).refine((value) => Object.keys(value).length > 0, 'Nothing to change');
export type OverrideRequest = z.infer<typeof overrideSchema>;

export const addSchema = z.union([
  z.strictObject({ meaningId: z.uuid(), edits: overrideSchema.optional() }),
  z.strictObject({
    draftId: z.uuid(),
    senseIndex: z.number().int().min(0).max(maxSensesPerDraft - 1).default(0),
    edits: overrideSchema.optional(),
  }),
]);
export type AddRequest = z.infer<typeof addSchema>;
