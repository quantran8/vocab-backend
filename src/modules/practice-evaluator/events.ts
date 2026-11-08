import { z } from 'zod';
import { DELIVERY_MODE, EVENT_ACTION } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';

const base = { seq: z.number().int().positive() };
const id = z.number().int().nonnegative();

export const eventSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...base,
    action: z.literal(EVENT_ACTION.SUBMIT),
    optionId: id.optional(),
    value: z.string().max(200).optional(),
    tileIds: z.array(id).max(64).optional(),
    graphemeIndex: id.optional(),
    replacement: z.string().max(32).optional(),
    // surgery: every fix the learner made, in place of the single graphemeIndex/replacement pair.
    edits: z.array(z.strictObject({ graphemeIndex: id, replacement: z.string().max(32) })).min(1).max(64).optional(),
  }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.PAIR), leftId: id, rightId: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.TAP_TILE), tileId: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.REMOVE_TILE), tileId: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.MOVE_TILE), tileId: id, toIndex: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.HINT) }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.REVEAL) }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.ASSESSED), assessmentReceiptId: z.uuid() }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.UNAVAILABLE), reason: z.string().max(64) }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.TRANSCRIBED), transcript: z.string().max(200) }),
]);
export type TaskEvent = z.infer<typeof eventSchema>;

export const commitBodySchema = z.strictObject({
  learnStepsCompleted: z.array(z.uuid()).max(POLICY.session.maxTasksPerCommit),
  taskResults: z
    .array(
      z.strictObject({
        taskId: z.uuid(),
        events: z.array(eventSchema).min(1).max(POLICY.session.maxEventsPerTask),
        deliveryMode: z.enum(Object.values(DELIVERY_MODE)).optional(),
      }),
    )
    .max(POLICY.session.maxTasksPerCommit),
});
export type CommitBody = z.infer<typeof commitBodySchema>;
