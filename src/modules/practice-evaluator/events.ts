import { z } from 'zod';
import { DELIVERY_MODE, EVENT_ACTION } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';

const base = { seq: z.number().int().positive() };
const id = z.number().int().nonnegative();

export const eventSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...base,
    action: z.literal(EVENT_ACTION.submit),
    optionId: id.optional(),
    value: z.string().max(200).optional(),
    tileIds: z.array(id).max(64).optional(),
    graphemeIndex: id.optional(),
    replacement: z.string().max(32).optional(),
  }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.pair), leftId: id, rightId: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.tapTile), tileId: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.removeTile), tileId: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.moveTile), tileId: id, toIndex: id }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.hint) }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.reveal) }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.assessed), assessmentReceiptId: z.uuid() }),
  z.strictObject({ ...base, action: z.literal(EVENT_ACTION.unavailable), reason: z.string().max(64) }),
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
