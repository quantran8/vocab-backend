import { eq, inArray, sql } from 'drizzle-orm';
import { VALIDITY } from '../src/common/constants/domain';
import { addHours } from '../src/common/constants/time';
import {
  appUsers, checkpointChallengeMeanings, checkpointChallenges, deletedIdentities, exampleLocalizations, learningSessions,
  lexicalDrafts, meaningExamples, meaningLocalizations, meaningPublications, meanings, memoryObservations, speechAssessmentReceipts,
  skillEvidence, topics, userMeaningProgress, userSettings, words,
} from '../src/db/schema';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers } from './support/driver';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SUBJECT = 'user-1';
const OTHER_SUBJECT = 'user-2';
const curated = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));

describe('account deletion', () => {
  let h: Harness;
  let auth: string;
  let other: string;
  let userId: string;

  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, token = auth) =>
    h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const lookup = async (text: string, token: string, context?: string): Promise<Json> =>
    (await api('post', '/v1/custom-words/lookup', token).send({ text, context }).expect(200)).body;
  const addWord = async (text: string, token: string, context?: string): Promise<Json> => {
    const { draftId } = await lookup(text, token, context);
    return (await api('post', '/v1/custom-words', token).send({ draftId }).expect(201)).body;
  };

  async function learn(token: string) {
    await api('put', '/v1/me/settings', token).send({ dailyNewWordGoal: 2 }).expect(200);
    const plan = (await api('post', '/v1/sessions/plan', token).send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
    await api('post', `/v1/sessions/${plan.sessionId}/commit`, token).send(answers(plan)).expect(200);
    return plan.sessionId as string;
  }

  // Every kind of row a learner can own, including private content that blocks the delete if handled out of order.
  async function buildAccount() {
    const seeded = await h.seed('topic-a', curated(6));
    for (const token of [auth, other]) {
      await api('put', '/v1/me/levels', token).send({ proficiencyLevel: 'B1' }).expect(200);
      await api('put', '/v1/me/scope', token).send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    }
    const shared = await addWord('sharedword', auth);
    const { meaningId: privateId } = await addWord(seedWord(0).lemma, auth, 'a financial institution');
    await api('put', `/v1/custom-words/${privateId}/override`).send({ meaningText: 'my own gloss' }).expect(200);
    // In another locale the private meaning gets a draft pointing back at it, and a second publication.
    await api('put', '/v1/me/settings').send({ explanationLocale: 'en-US' }).expect(200);
    await lookup(seedWord(0).lemma, auth);
    await h.customWords.translateNextPending();
    await h.customWords.translateNextPending();
    await api('put', '/v1/me/settings').send({ explanationLocale: 'vi-VN' }).expect(200);

    const sessionId = await learn(auth);
    await h.db.insert(speechAssessmentReceipts).values({
      sessionId, taskId: sessionId, validity: VALIDITY.VALID, passed: true, accuracyScore: 90, assessedAt: h.clock.now(), expiresAt: addHours(h.clock.now(), 1),
    });
    const [challenge] = await h.db.insert(checkpointChallenges).values({ userId, sequence: 1 }).returning({ id: checkpointChallenges.id });
    await h.db.insert(checkpointChallengeMeanings).values({ challengeId: challenge.id, meaningId: privateId });
    await learn(other);
    return { privateId: privateId as string, sharedId: shared.meaningId as string, sessionId };
  }

  // Found from the catalog, so a future table holding user rows can't be forgotten here.
  async function rowsReferencing(id: string) {
    const { rows: columns } = await h.db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'uuid' AND column_name LIKE '%user_id'`);
    const { rows } = await h.db.execute<{ n: number }>(sql.raw(
      columns.map((c) => `SELECT count(*)::int AS n FROM "${c.table_name}" WHERE "${c.column_name}" = '${id}'`).join(' UNION ALL '),
    ));
    return rows.reduce((sum, r) => sum + r.n, 0);
  }

  beforeAll(async () => { h = await createHarness(); });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    auth = await h.token(SUBJECT);
    other = await h.token(OTHER_SUBJECT);
    userId = (await api('get', '/v1/me').expect(200)).body.id;
    await api('get', '/v1/me', other).expect(200);
  });

  it('removes every row of the account and its identity', async () => {
    const { sessionId } = await buildAccount();
    expect(await rowsReferencing(userId)).toBeGreaterThan(0);

    const { body } = await api('delete', '/v1/me').expect(200);

    expect(body).toEqual({ deleted: true });
    expect(h.authAdmin.deleted).toEqual([SUBJECT]);
    expect(await rowsReferencing(userId)).toBe(0);
    expect(await h.count(appUsers, eq(appUsers.id, userId))).toBe(0);
    expect(await h.count(learningSessions, eq(learningSessions.id, sessionId))).toBe(0);
    expect(await h.count(speechAssessmentReceipts, eq(speechAssessmentReceipts.sessionId, sessionId))).toBe(0);
    expect(await h.count(checkpointChallenges)).toBe(0);
    expect(await h.count(topics, eq(topics.slug, userId))).toBe(0);
  });

  it('removes private meanings with everything hanging off them', async () => {
    const { privateId } = await buildAccount();
    const examples = (await h.db.select({ id: meaningExamples.id }).from(meaningExamples).where(eq(meaningExamples.meaningId, privateId))).map((e) => e.id);
    expect(examples.length).toBeGreaterThan(0);
    expect(await h.count(lexicalDrafts, eq(lexicalDrafts.meaningId, privateId))).toBeGreaterThan(0);

    await api('delete', '/v1/me').expect(200);

    expect(await h.count(meanings, eq(meanings.id, privateId))).toBe(0);
    expect(await h.count(meaningExamples, eq(meaningExamples.meaningId, privateId))).toBe(0);
    expect(await h.count(exampleLocalizations, inArray(exampleLocalizations.exampleId, examples))).toBe(0);
    expect(await h.count(meaningLocalizations, eq(meaningLocalizations.meaningId, privateId))).toBe(0);
    expect(await h.count(meaningPublications, eq(meaningPublications.meaningId, privateId))).toBe(0);
    expect(await h.count(lexicalDrafts, eq(lexicalDrafts.meaningId, privateId))).toBe(0);
    expect(await h.count(lexicalDrafts, sql`${lexicalDrafts.contextKey} LIKE ${`%${userId}%`}`)).toBe(0);
  });

  it('leaves other learners and the shared pool alone', async () => {
    const { sharedId } = await buildAccount();
    const otherId = (await api('get', '/v1/me', other).expect(200)).body.id as string;
    const before = {
      sessions: await h.count(learningSessions, eq(learningSessions.userId, otherId)),
      progress: await h.count(userMeaningProgress, eq(userMeaningProgress.userId, otherId)),
      observations: await h.count(memoryObservations, eq(memoryObservations.userId, otherId)),
      evidence: await h.count(skillEvidence, eq(skillEvidence.userId, otherId)),
    };
    const wordCount = await h.count(words);

    await api('delete', '/v1/me').expect(200);

    expect({
      sessions: await h.count(learningSessions, eq(learningSessions.userId, otherId)),
      progress: await h.count(userMeaningProgress, eq(userMeaningProgress.userId, otherId)),
      observations: await h.count(memoryObservations, eq(memoryObservations.userId, otherId)),
      evidence: await h.count(skillEvidence, eq(skillEvidence.userId, otherId)),
    }).toEqual(before);
    expect(before.sessions).toBeGreaterThan(0);
    expect(await h.count(words)).toBe(wordCount);
    expect(await h.first(meanings, eq(meanings.id, sharedId))).toMatchObject({ createdByUserId: null, ownerUserId: null });
    await api('get', '/v1/me', other).expect(200);
    expect(h.authAdmin.deleted).toEqual([SUBJECT]);
  });

  it('a token that is still valid cannot bring the account back', async () => {
    await api('delete', '/v1/me').expect(200);

    const { body } = await api('get', '/v1/me').expect(401);

    expect(body.code).toBe('UNAUTHORIZED');
    expect(await h.count(appUsers, eq(appUsers.identitySubject, SUBJECT))).toBe(0);
    expect(await h.count(userSettings, eq(userSettings.userId, userId))).toBe(0);
  });

  it.each([[500], [401]])('keeps everything when the auth provider answers %i, so the client can retry', async (status) => {
    await buildAccount();
    const before = await rowsReferencing(userId);
    h.authAdmin.deleteStatus = status;

    const { body } = await api('delete', '/v1/me').expect(503);

    expect(body).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE', retryable: true });
    expect(await rowsReferencing(userId)).toBe(before);
    expect(await h.count(deletedIdentities)).toBe(0);

    h.authAdmin.deleteStatus = 200;
    await api('delete', '/v1/me').expect(200);
    expect(await rowsReferencing(userId)).toBe(0);
  });

  it('finishes when the identity is already gone', async () => {
    h.authAdmin.deleteStatus = 404;
    await api('delete', '/v1/me').expect(200);
    expect(await h.count(appUsers, eq(appUsers.id, userId))).toBe(0);
  });

  it('forgets the deleted identity once its tokens have expired', async () => {
    await api('delete', '/v1/me').expect(200);
    expect(await h.count(deletedIdentities)).toBe(1);

    h.clock.advance(7 * 24 - 1);
    await h.app.get(MaintenanceService).cleanup();
    expect(await h.count(deletedIdentities)).toBe(1);

    h.clock.advance(1);
    await h.app.get(MaintenanceService).cleanup();
    expect(await h.count(deletedIdentities)).toBe(0);
  });

  it('requires a signed-in user', async () => {
    await h.http().delete('/v1/me').expect(401);
    expect(h.authAdmin.deleted).toEqual([]);
  });
});
