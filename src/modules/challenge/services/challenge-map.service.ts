import { Injectable } from '@nestjs/common';
import { CHALLENGE_ROLE, GAME_MODE } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { buildMap } from '../domain/challenge-map';
import { pickDistinct, TakenKeys, toCandidate } from '../domain/chapter-content';
import { SlotContent } from '../domain/match-madness';
import { ChallengeRepository } from '../repositories/challenge.repository';

const { challenge } = POLICY;

export const toCandidates = (rows: SlotContent[]) => rows.flatMap((r) => toCandidate(r) ?? []);
/** Meanings a new chapter could take as core: distinct by word and by gloss. */
export const eligibleCount = (rows: SlotContent[]) => pickDistinct(toCandidates(rows), Number.POSITIVE_INFINITY).length;

@Injectable()
export class ChallengeMapService {
  constructor(private readonly repository: ChallengeRepository) {}

  /** Pure read: nothing is materialised or repaired until a run is issued. */
  async map(userId: string) {
    const state = await this.repository.mapState(userId);
    const invalid = state.activeSlots.filter((s) => !s.valid && s.role === CHALLENGE_ROLE.CORE).length;
    const kept = new TakenKeys(state.activeSlots.filter((s) => s.valid));
    const repairable = invalid === 0 || pickDistinct(toCandidates(state.activeCandidates ?? state.candidates), invalid, kept).length === invalid;
    return {
      configVersion: challenge.version,
      gameMode: GAME_MODE.MATCH_MADNESS,
      ...buildMap({
        levels: challenge.levels,
        timeLimitMs: challenge.timeLimitMs,
        chapters: state.chapters,
        activePlayable: repairable,
        eligibleNewCount: eligibleCount(state.candidates),
        requiredNewCount: challenge.chapterNewMeaningCount,
      }),
      newWordsBlockedReason: state.newWordsBlockedReason,
    };
  }
}
