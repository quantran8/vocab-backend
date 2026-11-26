import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CONTENT_REPORT_REASON as R, CONTENT_REPORT_SOURCE as S, CONTENT_REPORT_STATUS } from '../src/common/constants/domain';
import { newId } from '../src/common/ids';
import { POLICY } from '../src/config/policy';
import { appUsers, contentReports, learningSessions, memoryObservations, userMeaningOverrides, userMeaningProgress } from '../src/db/schema';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, learnIds, tasksOf } from './support/driver';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const words = (n: number) => Array.from({ length: n }, (_, i) => seedWord(i));

describe('content reports', () => {
  let h: Harness;
  let auth: string;

  const as = (token: string) => (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string) => as(auth)(method, path);
  const report = (body: object, token = auth) => as(token)('post', '/v1/me/content-reports').send({ clientReportId: randomUUID(), ...body });

  async function onboard(token = auth) {
    const seeded = await h.seed('topic-a', words(3));
    await as(token)('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await as(token)('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    return seeded;
  }
  const plan = async (token = auth) => {
    await as(token)('put', '/v1/me/settings').send({ dailyNewWordGoal: 2 }).expect(200);
    return (await as(token)('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
  };
  const learnContext = (p: Json) => ({ source: S.LEARN_CARD, context: { sessionId: p.sessionId, learnStepId: learnIds(p)[0] } });
  const taskContext = (p: Json, extra: object = {}) => ({ source: S.PRACTICE_TASK, context: { sessionId: p.sessionId, taskId: tasksOf(p)[0].id, ...extra } });
  const firstLearnedMeaning = async (p: Json) =>
    ((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).plan!).learnSteps[0].meaningId;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    auth = await h.token('reporter-1');
  });

  describe('submit', () => {
    it('R01 R03 stores a learn card report from the plan, independent of the session', async () => {
      await onboard();
      const p = await plan();
      const { body } = await report({ ...learnContext(p), reason: R.INCORRECT_MEANING }).expect(201);
      expect(body).toEqual({ reportId: expect.any(String), duplicate: false, status: 'received' });

      const row = await h.first(contentReports, eq(contentReports.id, body.reportId));
      const meaningId = await firstLearnedMeaning(p);
      expect(row).toMatchObject({ source: S.LEARN_CARD, meaningIds: [meaningId], explanationLocale: 'vi-VN', status: CONTENT_REPORT_STATUS.PENDING });
      expect(row.targetKey).toMatch(new RegExp(`^meaning:${meaningId}@`));
      expect((row.snapshot as Json).clientCard).toBeDefined();

      await api('post', `/v1/sessions/${p.sessionId}/commit`).send(answers(p)).expect(200);
      expect(await h.count(contentReports)).toBe(1);
    });

    it('R01 R08 a practice task report keeps the task and its answer key, and never echoes them', async () => {
      await onboard();
      const p = await plan();
      const { body } = await report({ ...taskContext(p, { attemptExcerpt: { submittedText: 'wordaa' } }), reason: R.ANSWER_SHOULD_BE_ACCEPTED }).expect(201);
      expect(Object.keys(body).sort()).toEqual(['duplicate', 'reportId', 'status']);
      const row = await h.first(contentReports, eq(contentReports.id, body.reportId));
      expect(row.snapshot).toMatchObject({ id: tasksOf(p)[0].id, serverEvaluation: expect.any(Object) });
      expect(row.attemptExcerpt).toEqual({ submittedText: 'wordaa' });
      expect(row.meaningIds.length).toBeGreaterThan(0);
    });

    it('R03 a report changes no learning state', async () => {
      await onboard();
      const p = await plan();
      await api('post', `/v1/sessions/${p.sessionId}/commit`).send(answers(p)).expect(200);
      const before = [await h.count(userMeaningProgress), await h.count(memoryObservations)];
      await report({ ...taskContext(p), reason: R.INCORRECT_QUESTION }).expect(201);
      expect([await h.count(userMeaningProgress), await h.count(memoryObservations)]).toEqual(before);
    });

    it('R04 checks each reason against its source and the note rules', async () => {
      await onboard();
      const p = await plan();
      const meaningId = await firstLearnedMeaning(p);
      const detail = { source: S.WORD_DETAIL, context: { meaningId } };
      await report({ ...detail, reason: R.INCORRECT_QUESTION }).expect(400);
      await report({ ...taskContext(p), reason: R.ANSWER_SHOULD_BE_ACCEPTED }).expect(400);
      await report({ ...detail, reason: R.OTHER }).expect(400);
      await report({ ...detail, reason: R.OTHER, note: '   ' }).expect(400);
      await report({ ...detail, reason: R.OTHER, note: 'x'.repeat(POLICY.contentReport.noteMaxChars + 1) }).expect(400);
      await report({ ...detail, reason: R.OTHER, note: '😀'.repeat(POLICY.contentReport.noteMaxChars) }).expect(201);
      await report({ ...detail, reason: 'typo' }).expect(400);
      await report({ ...learnContext(p), context: { ...learnContext(p).context, attemptExcerpt: { submittedText: 'x' } }, reason: R.OTHER, note: 'n' }).expect(400);
    });

    it('R05 a retry replays the first answer; the same id with another body conflicts', async () => {
      await onboard();
      const p = await plan();
      const body = { clientReportId: randomUUID(), ...learnContext(p), reason: R.INCORRECT_EXAMPLE };
      const first = await api('post', '/v1/me/content-reports').send(body).expect(201);
      const again = await api('post', '/v1/me/content-reports').send(body).expect(200);
      expect(again.body).toEqual(first.body);
      const conflict = await api('post', '/v1/me/content-reports').send({ ...body, reason: R.INCORRECT_DEFINITION }).expect(409);
      expect(conflict.body.code).toBe('REPORT_IDEMPOTENCY_CONFLICT');
      expect(await h.count(contentReports)).toBe(1);
    });

    it('R05 concurrent sends of one report store it once', async () => {
      await onboard();
      const p = await plan();
      const body = { clientReportId: randomUUID(), ...learnContext(p), reason: R.AUDIO_ISSUE };
      const results = await Promise.all([1, 2, 3].map(() => api('post', '/v1/me/content-reports').send(body)));
      expect(new Set(results.map((r) => r.body.reportId)).size).toBe(1);
      expect(await h.count(contentReports)).toBe(1);
    });

    it('R06 an open duplicate points at the first report; a learn card and word detail of one revision share it', async () => {
      await onboard();
      const p = await plan();
      const first = await report({ ...learnContext(p), reason: R.INCORRECT_MEANING, note: 'first' }).expect(201);
      const meaningId = await firstLearnedMeaning(p);
      const dup = await report({ source: S.WORD_DETAIL, context: { meaningId }, reason: R.INCORRECT_MEANING, note: 'second' }).expect(200);
      expect(dup.body).toEqual({ reportId: first.body.reportId, duplicate: true, status: 'received' });
      await report({ source: S.WORD_DETAIL, context: { meaningId }, reason: R.INCORRECT_DEFINITION }).expect(201);

      await h.db.update(contentReports).set({ status: CONTENT_REPORT_STATUS.DISMISSED, reviewedBy: newId(), reviewedAt: new Date(), resolutionNote: 'ok' })
        .where(eq(contentReports.id, first.body.reportId));
      await report({ source: S.WORD_DETAIL, context: { meaningId }, reason: R.INCORRECT_MEANING }).expect(201);
    });

    it('R07 refuses another learner\'s session, unknown tasks and a challenge session alike', async () => {
      await onboard();
      const p = await plan();
      const other = await h.token('reporter-2');
      const theirs = await report({ ...learnContext(p), reason: R.INCORRECT_MEANING }, other).expect(404);
      expect(theirs.body.code).toBe('REPORT_CONTEXT_UNAVAILABLE');
      await report({ source: S.PRACTICE_TASK, context: { sessionId: p.sessionId, taskId: randomUUID() }, reason: R.INCORRECT_QUESTION }).expect(404);
      await report({ source: S.WORD_DETAIL, context: { meaningId: randomUUID() }, reason: R.INCORRECT_MEANING }).expect(404);
      await h.db.update(learningSessions).set({ plan: null, status: 'expired' }).where(eq(learningSessions.id, p.sessionId));
      await report({ ...learnContext(p), reason: R.INCORRECT_MEANING }).expect(404);
      expect(await h.count(contentReports)).toBe(0);
    });

    it('refuses a report on a Meaning the reporter edited', async () => {
      await onboard();
      const p = await plan();
      const [{ id: userId }] = await h.db.select({ id: appUsers.id }).from(appUsers);
      const meaningId = await firstLearnedMeaning(p);
      await h.db.insert(userMeaningOverrides).values({ userId, meaningId, locale: 'vi-VN', content: { meaningText: 'của tôi' } });
      const res = await report({ source: S.WORD_DETAIL, context: { meaningId }, reason: R.INCORRECT_MEANING }).expect(422);
      expect(res.body.code).toBe('REPORT_TARGET_OVERRIDDEN');
      await report({ ...learnContext(p), reason: R.AUDIO_ISSUE }).expect(422);
    });

    it('caps new reports per day but not replays or duplicates', async () => {
      await onboard();
      const p = await plan();
      const first = { clientReportId: randomUUID(), ...learnContext(p), reason: R.INCORRECT_MEANING };
      await api('post', '/v1/me/content-reports').send(first).expect(201);
      const [{ reporterId, snapshot }] = await h.db.select().from(contentReports);
      await h.db.insert(contentReports).values(Array.from({ length: POLICY.contentReport.perDay - 1 }, (_, i) => ({
        reporterId, clientReportId: randomUUID(), requestSha256: '0'.repeat(64), source: S.LEARN_CARD, reason: R.INCORRECT_MEANING,
        sessionId: p.sessionId, meaningIds: [], targetKey: `filler:${i}`, explanationLocale: 'vi-VN', snapshot, createdAt: h.clock.now(),
      })));
      const limited = await report({ ...learnContext(p), reason: R.AUDIO_ISSUE }).expect(429);
      expect(limited.body.code).toBe('REPORT_LIMIT_REACHED');
      await api('post', '/v1/me/content-reports').send(first).expect(200);
      await report({ ...learnContext(p), reason: R.INCORRECT_MEANING }).expect(200);
      h.clock.advance(25);
      await report({ ...learnContext(p), reason: R.AUDIO_ISSUE }).expect(201);
    });

    it('account deletion removes the reporter\'s reports', async () => {
      await onboard();
      const p = await plan();
      await report({ ...learnContext(p), reason: R.INCORRECT_MEANING }).expect(201);
      await api('delete', '/v1/me').expect(200);
      expect(await h.count(contentReports)).toBe(0);
    });
  });

  describe('admin queue', () => {
    let admin: string;
    const adminApi = (method: 'get' | 'post', path: string) => as(admin)(method, path);
    beforeEach(async () => { admin = await h.token('admin-1', 'admin'); });

    it('R15 learners cannot reach the queue', async () => {
      await api('get', '/admin/content-reports').expect(403);
    });

    it('R06 groups distinct reporters, shows the original next to the current revision and audits every move', async () => {
      const seeded = await onboard();
      const meaningId = seeded.meaningIds[0];
      const other = await h.token('reporter-2');
      await as(other)('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
      const detail = { source: S.WORD_DETAIL, context: { meaningId }, reason: R.INCORRECT_EXAMPLE };
      const { body: mine } = await report({ ...detail, note: '<b>bad</b>' }).expect(201);
      await report(detail, other).expect(201);

      const { body: list } = await adminApi('get', '/admin/content-reports?sort=most_reported').expect(200);
      expect(list.items).toHaveLength(2);
      expect(list.items[0]).toMatchObject({ reporterCount: 2, lemma: 'wordaa', reason: R.INCORRECT_EXAMPLE });

      const { body: one } = await adminApi('get', `/admin/content-reports/${mine.reportId}`).expect(200);
      expect(one).toMatchObject({ note: '<b>bad</b>', originalSnapshot: { meaningId }, currentRevisions: [{ meaningId, revision: expect.any(Number) }], events: [] });

      const move = (status: string, note?: string) => adminApi('post', `/admin/content-reports/${mine.reportId}/status`).send({ status, note });
      await move(CONTENT_REPORT_STATUS.RESOLVED).expect(400);
      await move(CONTENT_REPORT_STATUS.UNDER_REVIEW).expect(200);
      await move(CONTENT_REPORT_STATUS.RESOLVED, 'fixed the example').expect(200);
      await move(CONTENT_REPORT_STATUS.DISMISSED, 'no').expect(400);
      await report({ ...detail, note: 'still wrong' }).expect(201);
      const reopen = await move(CONTENT_REPORT_STATUS.PENDING).expect(409);
      expect(reopen.body.code).toBe('CONTENT_LOCKED');

      const { body: after } = await adminApi('get', `/admin/content-reports/${mine.reportId}`).expect(200);
      expect(after).toMatchObject({ status: CONTENT_REPORT_STATUS.RESOLVED, resolutionNote: 'fixed the example' });
      expect(after.events.map((e: Json) => e.toStatus)).toEqual([CONTENT_REPORT_STATUS.UNDER_REVIEW, CONTENT_REPORT_STATUS.RESOLVED]);
    });
  });
});
