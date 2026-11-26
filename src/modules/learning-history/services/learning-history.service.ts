import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { HistoryPeriod } from '../../../common/constants/domain';
import { HistoryRow, JourneyTopicFilter, LearningHistoryRepository } from '../repositories/learning-history.repository';

/** The learning journey: history only, built from committed sessions. See docs/FRONTEND_FLOW.md §17. */
export function learningHistoryView(row: HistoryRow, period: HistoryPeriod, now: Date) {
  const days = row.days.map((d) => (d.date > row.today
    ? { date: d.date, completed: null, completedSessions: null, newWords: null }
    : { date: d.date, completed: d.sessions > 0, completedSessions: d.sessions, newWords: d.newWords }));
  const past = days.filter((d) => d.completed !== null);
  return {
    asOf: now.toISOString(),
    timezone: row.timeZone,
    historyAvailableFrom: row.firstDay,
    historyComplete: true,
    week: {
      startDate: row.weekStart,
      endDateExclusive: row.weekEnd,
      newWords: past.reduce((sum, d) => sum + d.newWords!, 0),
      completedSessions: past.reduce((sum, d) => sum + d.completedSessions!, 0),
      activeDays: past.filter((d) => d.completed).length,
      weeklySessionGoal: row.weeklySessionGoal,
      /** The week's newest words (at most three), for Home's line under the count. */
      recentWords: row.recentWords,
      days,
    },
    period: {
      kind: period,
      startDate: row.periodStart,
      endDateExclusive: row.periodEnd,
      bucketGranularity: row.bucket,
      wordsAtStart: row.wordsAtStart,
      wordsAtEnd: row.wordsAtEnd,
      newWords: row.wordsAtEnd - row.wordsAtStart,
      activeDays: row.activeDays,
      completedSessions: row.completedSessions,
      reviewedMeanings: row.reviewedMeanings,
      points: row.points,
      /** The period's new words by the Topic each was first learned in; counts add up to `newWords`. */
      newWordsByTopic: row.newWordsByTopic,
    },
  };
}

@Injectable()
export class LearningHistoryService {
  constructor(private readonly repository: LearningHistoryRepository, private readonly clock: Clock) {}

  async history(userId: string, period: HistoryPeriod) {
    const now = this.clock.now();
    return learningHistoryView(await this.repository.history(userId, period, now), period, now);
  }

  words(userId: string, period: HistoryPeriod, limit: number, offset: number, topic: JourneyTopicFilter) {
    return this.repository.words(userId, period, this.clock.now(), limit, offset, topic);
  }
}
