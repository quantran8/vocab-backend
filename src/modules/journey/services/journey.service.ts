import { Injectable } from '@nestjs/common';
import { CHECKPOINT_STATE } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { buildJourney, journeyWindow, reviewResult } from '../domain/journey';
import { JourneyRepository } from '../repositories/journey.repository';

@Injectable()
export class JourneyService {
  constructor(private readonly repository: JourneyRepository) {}

  // Two round trips whatever the history size: challenges, then sessions, review counts and the goal together.
  async journey(userId: string, opts: { history: number; future: number; before?: number }) {
    const challenges = await this.repository.challenges(userId);
    const window = journeyWindow(challenges, opts);
    const reviewed = challenges.filter((c) =>
      c.state === CHECKPOINT_STATE.COMPLETED && c.completedSessionId && c.sequence >= window.lo && c.sequence <= window.hi);
    const [sessions, counts, state] = await Promise.all([
      this.repository.sessions(userId, window),
      this.repository.reviewCounts(reviewed.map((c) => c.completedSessionId!)),
      this.repository.goalState(userId),
    ]);
    const bySession = new Map(counts.map((c) => [c.sessionId, reviewResult(c.reviewed, c.unaided)]));
    const results = new Map(reviewed.flatMap((c) => {
      const result = bySession.get(c.completedSessionId!);
      return result ? [[c.id, result] as const] : [];
    }));
    const fallbackSize = POLICY.checkpoint.defaultSessionsPerChallenge;
    return {
      ...buildJourney({ window, weeklyGoal: state?.goal ?? fallbackSize, fallbackSize, challenges, sessions, results }),
      newWordsBlockedReason: state?.newWordsBlockedReason ?? null,
    };
  }
}
