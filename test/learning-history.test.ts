import { eq, inArray } from 'drizzle-orm';
import { SESSION_MODE, SESSION_STATUS } from '../src/common/constants/domain';
import { newId } from '../src/common/ids';
import { appUsers, learningSessions, meanings, topicLocalizations, topics, userMeaningOverrides, userMeaningProgress } from '../src/db/schema';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers } from './support/driver';

const words = (n: number) => Array.from({ length: n }, (_, i) => seedWord(i));

// The harness clock starts on Monday 2026-11-02 03:00Z, 10:00 in the default Asia/Ho_Chi_Minh.
describe('learning journey history', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put', path: string) => h.http()[method](path).set('Authorization', `Bearer ${auth}`);
  const settings = (body: object) => api('put', '/v1/me/settings').send(body).expect(200);
  async function onboard(n: number) {
    const seeded = await h.seed('topic-a', words(n));
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    return seeded;
  }
  const plan = async (mode: string = SESSION_MODE.DAILY) =>
    (await api('post', '/v1/sessions/plan').send({ mode, capabilities: CAPS }).expect(200)).body;
  const commit = (p: { sessionId: string }, body: object) => api('post', `/v1/sessions/${p.sessionId}/commit`).send(body).expect(200);
  const learn = async (goal: number) => {
    await settings({ dailyNewWordGoal: goal });
    const p = await plan();
    const body = answers(p);
    await commit(p, body);
    return { p, body };
  };
  const journey = async (period?: string) =>
    (await api('get', `/v1/me/learning-journey${period ? `?period=${period}` : ''}`).expect(200)).body;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    auth = await h.token('history-user');
  });

  it('J01 a new learner gets real zeros, a full week strip and no history start', async () => {
    const body = await journey();
    expect(body).toMatchObject({ timezone: 'Asia/Ho_Chi_Minh', historyAvailableFrom: null, historyComplete: true });
    expect(body.week).toMatchObject({ startDate: '2026-11-02', endDateExclusive: '2026-11-09', newWords: 0, completedSessions: 0, activeDays: 0, weeklySessionGoal: 7 });
    expect(body.week.days).toHaveLength(7);
    expect(body.week.days[0]).toEqual({ date: '2026-11-02', completed: false, completedSessions: 0, newWords: 0 });
    expect(body.week.days[1]).toEqual({ date: '2026-11-03', completed: null, completedSessions: null, newWords: null });
    expect(body.period).toMatchObject({ kind: 'week', wordsAtStart: 0, wordsAtEnd: 0, newWords: 0, points: [{ date: '2026-11-02', cumulativeWords: 0 }] });
  });

  it('counts a Daily session, its new words and the day once; a retried commit changes nothing', async () => {
    await onboard(4);
    const { p, body } = await learn(2);
    await commit(p, body);
    const week = (await journey()).week;
    expect(week).toMatchObject({ newWords: 2, completedSessions: 1, activeDays: 1 });
    expect(week.days[0]).toEqual({ date: '2026-11-02', completed: true, completedSessions: 1, newWords: 2 });
  });

  it('J02 two Meanings of one Word count as one word', async () => {
    const seeded = await onboard(2);
    await learn(2);
    const [first] = await h.db.select({ typeId: meanings.typeId }).from(meanings).where(eq(meanings.id, seeded.meaningIds[0]));
    await h.db.update(meanings).set({ typeId: first.typeId }).where(eq(meanings.id, seeded.meaningIds[1]));
    expect((await journey()).week.newWords).toBe(1);
  });

  it('J04 J06 a review-only session adds a session and reviewed Meanings but no new word', async () => {
    await onboard(2);
    await learn(2);
    h.clock.advance(24 * 3);
    const review = await plan();
    await commit(review, answers(review));
    const extra = await plan(SESSION_MODE.RANDOM_PRACTICE);
    await commit(extra, answers(extra));
    const body = await journey();
    expect(body.week).toMatchObject({ newWords: 2, completedSessions: 3, activeDays: 2 });
    expect(body.week.days[3]).toMatchObject({ completed: true, completedSessions: 2, newWords: 0 });
    expect(body.period.reviewedMeanings).toBeGreaterThanOrEqual(2);
    expect(body.period.reviewedMeanings).toBeLessThanOrEqual(4);
  });

  it('J05 a checkpoint challenge and an uncommitted session do not count', async () => {
    await onboard(3);
    await learn(1);
    await plan();
    const [committed] = await h.db.select().from(learningSessions).where(eq(learningSessions.status, SESSION_STATUS.COMMITTED));
    await h.db.insert(learningSessions).values({ ...committed, id: newId(), mode: SESSION_MODE.CHECKPOINT_CHALLENGE });
    expect((await journey()).week.completedSessions).toBe(1);
  });

  it('J07 the learner time zone moves a session across the day and week boundary without changing totals', async () => {
    await onboard(2);
    await learn(2);
    await settings({ timeZone: 'America/Los_Angeles' });
    const body = await journey();
    expect(body.timezone).toBe('America/Los_Angeles');
    expect(body.week.startDate).toBe('2026-10-26');
    expect(body.week.days[6]).toEqual({ date: '2026-11-01', completed: true, completedSessions: 1, newWords: 2 });
    expect(body.period.wordsAtEnd).toBe(2);
  });

  it('month and all-time periods keep the start-to-end invariant and stay cumulative', async () => {
    await onboard(4);
    await learn(1);
    h.clock.advance(24 * 30);
    await learn(1);
    const month = (await journey('month')).period;
    expect(month).toMatchObject({ kind: 'month', startDate: '2026-12-01', endDateExclusive: '2027-01-01', bucketGranularity: 'day', wordsAtStart: 1 });
    expect(month.wordsAtEnd - month.wordsAtStart).toBe(month.newWords);
    expect(month.points.at(-1)).toEqual({ date: '2026-12-02', cumulativeWords: month.wordsAtEnd });

    const all = await journey('all');
    expect(all.historyAvailableFrom).toBe('2026-11-02');
    expect(all.period).toMatchObject({ startDate: '2026-11-02', bucketGranularity: 'month', wordsAtStart: 0, activeDays: 2, completedSessions: 2 });
    expect(all.period.points).toEqual([{ date: '2026-11-30', cumulativeWords: 1 }, { date: '2026-12-02', cumulativeWords: 2 }]);
  });

  it('names the week\'s newest words, at most three', async () => {
    await onboard(5);
    await learn(2);
    h.clock.advance(1);
    await learn(2);
    const { week } = await journey();
    expect(week.recentWords).toHaveLength(3);
    expect(week.recentWords[0]).toEqual({ wordId: expect.any(String), lemma: expect.stringMatching(/^word/) });
    const words = (await api('get', '/v1/me/learning-journey/words?period=week').expect(200)).body;
    expect(week.recentWords.map((w: { wordId: string }) => w.wordId)).toEqual(words.items.slice(0, 3).map((w: { wordId: string }) => w.wordId));
  });

  it('lists the period\'s new words newest first, with every meaning learned in it', async () => {
    const seeded = await onboard(3);
    await learn(2);
    h.clock.advance(24);
    await learn(1);
    const [first] = await h.db.select({ typeId: meanings.typeId }).from(meanings).where(eq(meanings.id, seeded.meaningIds[0]));
    await h.db.update(meanings).set({ typeId: first.typeId }).where(eq(meanings.id, seeded.meaningIds[1]));

    const { body } = await api('get', '/v1/me/learning-journey/words?period=week').expect(200);
    expect(body.total).toBe(2);
    expect(body.items.map((w: { learnedOn: string }) => w.learnedOn)).toEqual(['2026-11-03', '2026-11-02']);
    const merged = body.items.find((w: { wordId: string }) => w.wordId === seeded.wordIds[0]);
    expect(merged.meaningTexts).toEqual(['nghĩa 0', 'nghĩa 1']);

    const page = (await api('get', '/v1/me/learning-journey/words?period=week&limit=1&offset=1').expect(200)).body;
    expect(page).toEqual({ total: 2, items: [body.items[1]] });
    expect((await api('get', '/v1/me/learning-journey/words?period=week&offset=5').expect(200)).body).toEqual({ total: 2, items: [] });
  });

  it('shows the learner\'s own edit and keeps other periods out', async () => {
    const seeded = await onboard(2);
    await learn(1);
    const [{ id: userId }] = await h.db.select({ id: appUsers.id }).from(appUsers);
    await h.db.insert(userMeaningOverrides).values({ userId, meaningId: seeded.meaningIds[0], locale: 'vi-VN', content: { meaningText: 'của tôi' } });
    expect((await api('get', '/v1/me/learning-journey/words?period=week').expect(200)).body.items[0].meaningTexts).toEqual(['của tôi']);

    h.clock.advance(24 * 7);
    expect((await api('get', '/v1/me/learning-journey/words?period=week').expect(200)).body).toEqual({ total: 0, items: [] });
    expect((await api('get', '/v1/me/learning-journey/words?period=all').expect(200)).body.total).toBe(1);
    await api('get', '/v1/me/learning-journey/words?limit=51').expect(400);
  });

  describe('new words by topic', () => {
    type Group = { topicId: string | null; title: string | null; iosIcon: string | null; color: string | null; count: number; recentLemmas: string[]; finishedInPeriod: boolean };
    const byTopic = async (period?: string): Promise<{ newWords: number; newWordsByTopic: Group[] }> => (await journey(period)).period;
    const wordList = async (query: string) => (await api('get', `/v1/me/learning-journey/words?period=week${query}`).expect(200)).body;
    const progressOf = (meaningId: string) => eq(userMeaningProgress.meaningId, meaningId);
    const setProgress = (meaningIds: string[], values: Partial<typeof userMeaningProgress.$inferInsert>) =>
      h.db.update(userMeaningProgress).set(values).where(inArray(userMeaningProgress.meaningId, meaningIds));

    it('puts each word in one topic, names the topic in the UI locale and keeps the null group last', async () => {
      const a = await onboard(4);
      const b = await h.seed('topic-b', [seedWord(10), seedWord(11)]);
      await learn(4);
      await h.db.update(topics).set({ iosIcon: 'leaf', color: '#2F9BF4' }).where(eq(topics.id, a.topicId));
      await h.db.insert(topicLocalizations).values({ topicId: a.topicId, locale: 'vi-VN', title: 'Chủ đề A' });
      // Word 0 gets a second Meaning learned earlier via topic-b: its first learning decides the topic.
      const [first] = await h.db.select({ typeId: meanings.typeId }).from(meanings).where(eq(meanings.id, a.meaningIds[0]));
      await h.db.update(meanings).set({ typeId: first.typeId }).where(eq(meanings.id, a.meaningIds[1]));
      const [learnedAt] = await h.db.select({ at: userMeaningProgress.learnedAt }).from(userMeaningProgress).where(progressOf(a.meaningIds[0]));
      await setProgress([a.meaningIds[1]], { learnedAt: new Date(learnedAt.at.getTime() - 60_000), learnedViaTopicId: b.topicId });
      await setProgress([a.meaningIds[2]], { learnedViaTopicId: null });

      const period = await byTopic();
      expect(period.newWords).toBe(3);
      expect(period.newWordsByTopic.reduce((sum, g) => sum + g.count, 0)).toBe(period.newWords);
      expect(period.newWordsByTopic).toEqual([
        { topicId: a.topicId, title: 'Chủ đề A', iosIcon: 'leaf', color: '#2F9BF4', count: 1, recentLemmas: [seedWord(3).lemma], finishedInPeriod: true },
        { topicId: b.topicId, title: 'topic-b', iosIcon: null, color: null, count: 1, recentLemmas: [seedWord(0).lemma], finishedInPeriod: false },
        { topicId: null, title: null, iosIcon: null, color: null, count: 1, recentLemmas: [seedWord(2).lemma], finishedInPeriod: false },
      ]);
    });

    it('orders by count, names the newest three, and filters the word list by topic', async () => {
      const a = await onboard(5);
      await learn(2);
      h.clock.advance(1);
      await learn(2);
      h.clock.advance(1);
      await learn(1);
      await setProgress([a.meaningIds[0]], { learnedViaTopicId: null });

      const [group, none] = (await byTopic()).newWordsByTopic;
      expect(group).toMatchObject({ topicId: a.topicId, count: 4, finishedInPeriod: true });
      const listed = await wordList(`&topicId=${a.topicId}`);
      expect(listed.total).toBe(4);
      expect(group.recentLemmas).toEqual(listed.items.slice(0, 3).map((w: { lemma: string }) => w.lemma));
      expect(none).toMatchObject({ topicId: null, count: 1 });
      const unassigned = await wordList('&topicId=none');
      expect(unassigned.total).toBe(1);
      expect(unassigned.items.map((w: { wordId: string }) => w.wordId)).toEqual([a.wordIds[0]]);
      expect(listed.items.map((w: { wordId: string }) => w.wordId)).not.toContain(a.wordIds[0]);
      expect((await wordList('')).total).toBe(5);
      expect((await wordList(`&topicId=${a.collectionId}`)).total).toBe(0);
      await api('get', '/v1/me/learning-journey/words?topicId=abc').expect(400);
    });

    it('is not finished in the period when the topic is incomplete or its last learning was earlier', async () => {
      const a = await onboard(3);
      const b = await h.seed('topic-b', [seedWord(10), seedWord(11)]);
      await learn(2);
      expect((await byTopic()).newWordsByTopic).toEqual([expect.objectContaining({ topicId: a.topicId, count: 2, finishedInPeriod: false })]);

      // topic-b was finished a week earlier; this week's word that came via topic-b does not finish it again.
      const [row] = await h.db.select().from(userMeaningProgress).where(progressOf(a.meaningIds[0]));
      const earlier = new Date(row.learnedAt.getTime() - 7 * 24 * 3600_000);
      await h.db.insert(userMeaningProgress).values(b.meaningIds.map((meaningId) => ({ ...row, meaningId, learnedAt: earlier, learnedViaTopicId: b.topicId })));
      await setProgress([a.meaningIds[0]], { learnedViaTopicId: b.topicId });
      const groups = (await byTopic()).newWordsByTopic;
      expect(groups).toEqual([
        expect.objectContaining({ topicId: a.topicId, count: 1, finishedInPeriod: false }),
        expect.objectContaining({ topicId: b.topicId, count: 1, finishedInPeriod: false }),
      ]);
      expect((await byTopic('all')).newWordsByTopic).toEqual([
        expect.objectContaining({ topicId: b.topicId, count: 3, finishedInPeriod: true }),
        expect.objectContaining({ topicId: a.topicId, count: 1, finishedInPeriod: false }),
      ]);
    });

    it('is empty with no new words in the period', async () => {
      expect((await byTopic()).newWordsByTopic).toEqual([]);
    });
  });

  it('rejects an unknown period', async () => {
    await api('get', '/v1/me/learning-journey?period=year').expect(400);
  });
});
