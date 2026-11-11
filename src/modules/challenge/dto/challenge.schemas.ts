import { z } from 'zod';
import { CHALLENGE_ENDED_REASON, CHALLENGE_EVENT_TYPE } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

const { challenge } = POLICY;
const elapsed = z.number().int().min(0).max(challenge.timeLimitMs);

export const commitRunSchema = z.object({
  events: z.array(z.object({
    seq: z.number().int().min(1),
    type: z.literal(CHALLENGE_EVENT_TYPE.MATCH),
    elapsedMs: elapsed,
    wordTileId: z.uuid(),
    meaningTileId: z.uuid(),
  }).strict()).max(challenge.maxMatchEvents),
  endedReason: z.enum(Object.values(CHALLENGE_ENDED_REASON)),
  endedElapsedMs: elapsed,
}).strict();
export type CommitRunBody = z.infer<typeof commitRunSchema>;

export const levelParamsSchema = z.object({
  chapterNo: z.coerce.number().int().min(1),
  levelNo: z.coerce.number().int().min(1).max(challenge.levels.length),
});
export type LevelParams = z.infer<typeof levelParamsSchema>;
