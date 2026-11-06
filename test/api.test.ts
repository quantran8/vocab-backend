import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { EVIDENCE_REASON, MEMORY_SIGNAL, SKILL, TEMPLATE, VALIDITY } from '../src/common/constants/domain';
import { ApiError } from '../src/common/http/api-error';
import { POLICY } from '../src/config/policy';
import {
  appUsers, learningSessions, meaningLocalizations, meaningPublications, memoryObservations, practiceItems,
  skillEvidence, speechAssessmentReceipts, topicMeanings, topics, userMeaningProgress, userSettings, words as wordsTable,
} from '../src/db/schema';
import { AdminService } from '../src/modules/admin/services/admin.service';
import { PublicationService } from '../src/modules/admin/services/publication.service';
import { MaintenanceService } from '../src/modules/maintenance/services/maintenance.service';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, correctEvents, learnIds, tasksOf, wrongEvents } from './support/driver';

const USER = 'user-1';
const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));

describe('Vocab Flow API', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put', path: string, token = auth) =>
    h.http()[method](path).set('Authorization', `Bearer ${token}`);

  async function onboard(slugWords = words(6), level = 'B1', token = auth) {
    const seeded = await h.seed('topic-a', slugWords);
    await api('put', '/v1/me/levels', token).send({ proficiencyLevel: level }).expect(200);
    await api('put', '/v1/me/scope', token).send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    return seeded;
  }
  const plan = async (mode = 'daily', token = auth, capabilities = CAPS) =>
    (await api('post', '/v1/sessions/plan', token).send({ mode, capabilities }).expect(200)).body;
  const commit = (p: { sessionId: string }, body: object, token = auth) =>
    api('post', `/v1/sessions/${p.sessionId}/commit`, token).send(body);
  const goal = (n: number) => api('put', '/v1/me/settings').send({ dailyNewWordGoal: n }).expect(200);

  async function learnOne(n = 1) {
    await goal(n);
    const p = await plan();
    await commit(p, answers(p)).expect(200);
    return p;
  }
  const storedPlan = async (sessionId: string) => (await h.first(learningSessions, eq(learningSessions.id, sessionId))).plan!;
  const firstRecallSteps = async (sessionId: string) => {
    const { tasks, learnSteps } = await storedPlan(sessionId);
    return learnSteps.map(({ firstRecallTaskId }) => ({ firstRecallTaskId, template: tasks.find((t) => t.id === firstRecallTaskId)!.template }));
  };
  const progressRows = () => h.db.select().from(userMeaningProgress);

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    h.planner.setRng(Math.random);
    auth = await h.token(USER);
  });

  describe('http', () => {
    const MISSING_ID = '01a18d69-b8c8-7699-b121-735a85b63537';
    const MIB = 1024 * 1024;

    it('echoes the request id in the header and the error envelope', async () => {
      const res = await h.http().get('/v1/me').expect(401);
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
    });

    it('uses the error envelope for unknown routes', async () => {
      const res = await h.http().get('/v1/nope').expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
    });

    it('rejects malformed JSON as a validation failure', async () => {
      const res = await api('put', '/v1/me/settings').set('Content-Type', 'application/json').send('{oops').expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unsupported content type as a validation failure', async () => {
      const res = await api('put', '/v1/me/settings').set('Content-Type', 'text/plain').send('hi').expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('caps JSON bodies at 1 MiB', async () => {
      // In-process: over a socket Fastify answers from content-length and may close while the client still writes.
      const res = await h.app.inject({
        method: 'PUT', url: '/v1/me/settings', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ padding: 'x'.repeat(MIB) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('caps audio uploads with the policy limit', async () => {
      const res = await api('post', `/v1/sessions/${MISSING_ID}/recording-assess`)
        .field('taskId', MISSING_ID)
        .attach('audio', Buffer.alloc(3 * MIB), { filename: 'a.wav', contentType: 'audio/wav' })
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('accepts an empty body sent as JSON on bodyless routes', async () => {
      const admin = await h.token('admin-1', 'admin');
      const res = await api('post', `/admin/meanings/${MISSING_ID}/recall?locale=vi-VN`, admin).set('Content-Type', 'application/json');
      expect(res.status).not.toBe(400);
    });

    it('ignores a trailing slash', async () => {
      await api('get', '/v1/me/').expect(200);
    });
  });

  describe('auth', () => {
    it('rejects missing and forged tokens with the error envelope', async () => {
      const res = await h.http().get('/v1/me').expect(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHORIZED', retryable: false, requestId: expect.any(String) });
      await h.http().get('/v1/me').set('Authorization', 'Bearer nope').expect(401);
    });

    it('provisions user + settings once, across concurrent first requests', async () => {
      await Promise.all(Array.from({ length: 5 }, () => api('get', '/v1/me').expect(200)));
      expect(await h.count(appUsers)).toBe(1);
      expect(await h.count(userSettings)).toBe(1);
    });

    it('issues UUID v7 ids', async () => {
      const { body } = await api('get', '/v1/me').expect(200);
      expect(body.id[14]).toBe('7');
    });

    it('admin routes need app_metadata role', async () => {
      const route = '/admin/words';
      await api('post', route).send({}).expect(403);
      await api('post', route, await h.token('ed', 'editor')).send({}).expect(400);
    });
  });

  describe('identity', () => {
    it('C38 C39 levels only touch app_user', async () => {
      await api('put', '/v1/me/levels').send({ proficiencyLevel: 'A2' }).expect(200);
      const me = (await api('get', '/v1/me')).body;
      expect(me).toMatchObject({ proficiencyLevel: 'A2' });
      expect(me).not.toHaveProperty('learningLevel');
      await api('put', '/v1/me/levels').send({ proficiencyLevel: 'A2', learningLevel: 'B1' }).expect(400);
      expect(await h.count(userMeaningProgress)).toBe(0);
    });

    it('rejects topics outside the Collection', async () => {
      const a = await h.seed('topic-a', words(1));
      const b = await h.seed('topic-b', words(1, 1));
      await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: [b.topicId] }).expect(400);
    });

    it('rejects unsupported locales and bad time zones', async () => {
      await api('put', '/v1/me/settings').send({ explanationLocale: 'xx-XX' }).expect(400);
      await api('put', '/v1/me/settings').send({ timeZone: 'Mars/Base' }).expect(400);
    });
  });

  describe('publication', () => {
    const editor = () => h.token('ed', 'editor');
    const draft = (examples: object[] = [{ sourceText: 'Use it now.', targetLocator: { start: 4, end: 6 } }]) => ({
      lemma: 'probe',
      types: [{
        partOfSpeech: 'verb',
        pronunciations: [{ accentLocale: 'en-US', ipa: '/proʊb/' }],
        meanings: [{ cefrLevel: 'B1', examples }],
      }],
    });

    it('C05 rejects publishing without a localized example translation', async () => {
      const token = await editor();
      const { body } = await api('post', '/admin/words', token).send(draft()).expect(201);
      const meaningId = body.types[0].meanings[0].id;
      await api('put', `/admin/meanings/${meaningId}/locales/vi-VN`, token)
        .send({ meaningText: 'dò', definitionText: 'dò xét', editorialState: 'approved' }).expect(200);
      const res = await api('post', `/admin/meanings/${meaningId}/publish?locale=vi-VN`, token).expect(422);
      expect(res.body.code).toBe('PUBLICATION_INVALID');
    });

    it('C06 C28 a new draft leaves the published snapshot and issued tasks untouched', async () => {
      const seeded = await onboard(words(4));
      await goal(1);
      const issued = await plan();
      const service = h.app.get(AdminService);
      await service.putMeaningLocale(seeded.meaningIds[0], 'vi-VN', { meaningText: 'đã sửa', definitionText: 'x', editorialState: 'draft', exampleTranslations: [] });
      const next = await plan();
      expect(JSON.stringify(next.steps)).not.toContain('đã sửa');
      await commit(issued, answers(issued)).expect(200);
    });

    it('recalled publications leave the resolver; publish restores a new revision', async () => {
      const seeded = await onboard(words(4));
      const publications = h.app.get(PublicationService);
      await publications.recall(seeded.meaningIds[0], 'vi-VN');
      expect(JSON.stringify((await plan()).steps)).not.toContain('nghĩa 0"');
      await h.db
        .update(meaningLocalizations)
        .set({ meaningText: 'nghĩa mới' })
        .where(and(eq(meaningLocalizations.meaningId, seeded.meaningIds[0]), eq(meaningLocalizations.locale, 'vi-VN')));
      const { revision } = await publications.publish(seeded.meaningIds[0], 'vi-VN');
      expect(revision).toBe(2);
    });

    it('snapshots are immutable at the database', async () => {
      await h.seed('topic-a', words(1));
      await expect(h.db.update(meaningPublications).set({ revision: 9 })).rejects.toThrow();
    });

    it('publishing an item without supersedes never retires other items', async () => {
      const seeded = await h.seed('topic-a', words(1));
      const admin = h.app.get(AdminService);
      const create = async () => {
        const { id } = await admin.createItem({
          template: TEMPLATE.TYPING, variant: 'meaning_recall',
          sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { acceptedResponses: ['x'] },
          targets: [{ meaningId: seeded.meaningIds[0] }],
        });
        await admin.putItemLocale(id, 'vi-VN', { localizedContent: {}, editorialState: 'approved' });
        await admin.publishItem(id);
        return id;
      };
      await create();
      await create();
      expect(await h.count(practiceItems, eq(practiceItems.status, 'published'))).toBe(2);
    });

    it('C52 rejects a dual target across different Words', async () => {
      const seeded = await h.seed('topic-a', words(2));
      await expect(h.app.get(AdminService).createItem({
        template: TEMPLATE.SELECT, variant: 'gloss',
        sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { correctOptionId: 1 },
        targets: [{ meaningId: seeded.meaningIds[0], pronunciationId: seeded.pronunciationIds[1] }],
      })).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('daily plan', () => {
    it('C09 C42 task payload exposes no internal ids and is self-contained', async () => {
      await onboard();
      const p = await plan();
      expect(p.steps.length).toBeGreaterThan(0);
      for (const task of tasksOf(p)) {
        expect(Object.keys(task)).not.toEqual(expect.arrayContaining(['wordId']));
        expect(JSON.stringify(task)).not.toMatch(/meaningId|pronunciationId|typeId|intent|referenceText/);
        expect(task.id[14]).toBe('7');
        if (task.template !== 'cloze_select') expect(task.prompt.type).toMatch(/text|audio/);
      }
    });

    it('C29 C30 C34 every new Meaning has all groups; persisted first recall is typing or flyReorder', async () => {
      await onboard(words(6));
      await goal(3);
      const p = await plan();
      expect(learnIds(p)).toHaveLength(3);
      const steps = await firstRecallSteps(p.sessionId);
      for (const step of steps) expect([TEMPLATE.TYPING, TEMPLATE.FLY_REORDER]).toContain(step.template);
      const templates = tasksOf(p).map((t) => t.template);
      expect(templates.filter((t) => t === TEMPLATE.RECORDING)).toHaveLength(3);
      expect(templates.filter((t) => t === TEMPLATE.SELECT)).toHaveLength(9);
    });

    it('audioPlayback=false never issues audio', async () => {
      await onboard();
      const p = await plan('daily', auth, { audioPlayback: false, microphone: true });
      expect(tasksOf(p).every((t) => t.prompt?.type !== 'audio')).toBe(true);
    });

    const learnSteps = (p: { steps: { type: string }[] }) => JSON.stringify(p.steps.filter((s) => s.type === 'learn'));

    it('tells the learn card its part of speech', async () => {
      await onboard();
      const card = (await plan()).steps.find((s: { type: string }) => s.type === 'learn').card;
      expect(card.partOfSpeech).toBe('verb');
    });

    it('prefers new Meanings at or above the level', async () => {
      await onboard([...words(4), seedWord(9, { cefrLevel: 'A1', meaningText: 'mức thấp' })], 'B1');
      await goal(4);
      expect(learnSteps(await plan())).not.toContain('mức thấp');
    });

    it('falls back to easier Meanings instead of an empty plan', async () => {
      await onboard([0, 1, 2, 3].map((i) => seedWord(i, { cefrLevel: 'A1', meaningText: `mức thấp ${i}` })), 'B1');
      expect(learnSteps(await plan())).toContain('mức thấp');
    });

    it('returns an empty plan instead of an empty session', async () => {
      await api('get', '/v1/me').expect(200);
      expect(await plan()).toEqual({ sessionId: null, mode: 'daily', steps: [] });
      expect(await h.count(learningSessions)).toBe(0);
    });

    it('snapshots cannot be rewritten after issue', async () => {
      await onboard(words(4));
      await goal(1);
      await plan();
      await expect(h.db.update(learningSessions).set({ plan: { tasks: [], learnSteps: [] } })).rejects.toThrow();
    });
  });

  describe('commit', () => {
    it('C11 abandoning leaves no authoritative learning', async () => {
      await onboard();
      await plan();
      expect(await progressRows()).toEqual([]);
      expect(await h.count(memoryObservations)).toBe(0);
      expect(await h.count(skillEvidence)).toBe(0);
    });

    it('C10 rejects a partial batch with no partial progress', async () => {
      await onboard();
      const p = await plan();
      const body = answers(p);
      body.taskResults.pop();
      const res = await commit(p, body).expect(422);
      expect(res.body.code).toBe('INVALID_SUBMISSION');
      expect(await progressRows()).toEqual([]);
    });

    it('rejects one invalid task as a whole batch', async () => {
      await onboard();
      const p = await plan();
      await commit(p, answers(p, { override: (t) => (t.template === TEMPLATE.TYPING ? [{ seq: 1, action: 'submit' }] : undefined) })).expect(422);
      expect((await h.first(learningSessions)).result).toBeNull();
    });

    it('C27 server re-evaluates independently and rejects client-asserted fields', async () => {
      await onboard();
      const p = await plan();
      const body = answers(p);
      (body.taskResults[0].events[0] as Record<string, unknown>).correct = true;
      await commit(p, body).expect(422);
    });

    it('C12 retry with the same payload returns the stored response without double counting', async () => {
      await onboard();
      const p = await plan();
      const body = answers(p);
      const first = await commit(p, body).expect(200);
      const reordered = { taskResults: body.taskResults, learnStepsCompleted: body.learnStepsCompleted };
      const second = await commit(p, reordered).expect(200);
      // jsonb normalizes key order, so the stored response is compared by value, not by bytes.
      expect(second.body).toEqual(first.body);
      expect(await h.count(memoryObservations)).toBe(learnIds(p).length);
      expect((await progressRows()).every((r) => r.version === 1)).toBe(true);
    });

    it('C13 retry with a different payload conflicts', async () => {
      await onboard();
      const p = await plan();
      await commit(p, answers(p)).expect(200);
      const res = await commit(p, answers(p, { deliveryMode: 'fallback' })).expect(409);
      expect(res.body.code).toBe('SESSION_PAYLOAD_CONFLICT');
    });

    it('C12 concurrent identical commits produce one result', async () => {
      await onboard();
      const p = await plan();
      const body = answers(p);
      const results = await Promise.all(Array.from({ length: 4 }, () => commit(p, body)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.body.committedAt)).size).toBe(1);
      expect(await h.count(memoryObservations)).toBe(learnIds(p).length);
    });

    it('C14 two concurrent plans for the same Meaning: first commit wins, no second learnedAt', async () => {
      await onboard(words(4));
      await goal(1);
      const [a, b] = [await plan(), await plan()];
      const results = await Promise.all([commit(a, answers(a)), commit(b, answers(b))]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('SESSION_STALE');
      expect(await h.count(userMeaningProgress)).toBe(1);
    });

    it('403 for another user, 404 unknown, 410 expired', async () => {
      await onboard();
      const p = await plan();
      const other = await h.token('intruder');
      expect((await commit(p, answers(p), other).expect(403)).body.code).toBe('SESSION_NOT_OWNED');
      await api('get', `/v1/sessions/${p.sessionId}/commit-status`, other).expect(403);
      await commit({ sessionId: '0190b0a0-0000-7000-8000-000000000001' }, answers(p)).expect(404);
      h.clock.advance(73);
      expect((await commit(p, answers(p)).expect(410)).body.code).toBe('SESSION_EXPIRED');
    });

    it('commit-status reconciles a lost ACK', async () => {
      await onboard();
      const p = await plan();
      expect((await api('get', `/v1/sessions/${p.sessionId}/commit-status`)).body.status).toBe('issued');
      const { body } = await commit(p, answers(p)).expect(200);
      const status = (await api('get', `/v1/sessions/${p.sessionId}/commit-status`)).body;
      expect(status).toMatchObject({ status: 'committed', response: body });
    });

    it('C31 C32 C20 Recording unavailable or invalid still allows learning, with no Speaking failure', async () => {
      await onboard(words(4));
      await learnOne();
      expect(await h.count(userMeaningProgress)).toBe(1);
      const speaking = await h.count(skillEvidence, eq(skillEvidence.skill, SKILL.SPEAKING));
      expect(speaking).toBe(0);
    });

    it('C15 first recall wrong still learns, with the failed schedule', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const isRecall = (t: { template: string }) => t.template === TEMPLATE.TYPING || t.template === TEMPLATE.FLY_REORDER;
      await commit(p, answers(p, { override: (t) => (isRecall(t) ? wrongEvents(t) : undefined) })).expect(200);
      const [row] = await progressRows();
      expect(Number(row.intervalHours)).toBe(12);
      expect((await h.first(memoryObservations)).signal).toBe(MEMORY_SIGNAL.FAILED_RECALL);
    });

    it('C49 flyReorder as first recall validates and learns once at Finish', async () => {
      await onboard(words(4));
      await goal(1);
      const issue = async () => {
        const p = await plan();
        const [step] = await firstRecallSteps(p.sessionId);
        return { p, step };
      };
      let { p, step } = await issue();
      // The slot is 50/50; replanning is allowed and keeps the test on the real RNG.
      for (let i = 0; i < 30 && step.template !== TEMPLATE.FLY_REORDER; i += 1) ({ p, step } = await issue());
      expect(step.template).toBe(TEMPLATE.FLY_REORDER);
      await commit(p, answers(p)).expect(200);
      expect(await h.count(userMeaningProgress)).toBe(1);
      expect((await h.first(memoryObservations)).sourceTaskIds).toContain(step.firstRecallTaskId);
    });

    it('C33 C40 five opportunities produce one observation, learned once at Finish', async () => {
      await onboard(words(4));
      await learnOne();
      expect(await h.count(memoryObservations)).toBe(1);
      const [row] = await progressRows();
      expect(row.version).toBe(1);
      expect(row.learnedAt).toEqual(h.clock.current);
    });

    it('receipts cannot be replayed from another task or forged', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const bogus = '0190b0a0-0000-7000-8000-000000000002';
      const body = answers(p, { override: (t) => (t.template === TEMPLATE.RECORDING ? [{ seq: 1, action: 'assessed', assessmentReceiptId: bogus }] : undefined) });
      await commit(p, body).expect(422);
    });
  });

  describe('speech', () => {
    const assess = (sessionId: string, taskId: string) =>
      api('post', `/v1/sessions/${sessionId}/recording-assess`)
        .field('taskId', taskId)
        .attach('audio', Buffer.from('RIFF'), { filename: 'a.wav', contentType: 'audio/wav' });
    const recordings = (p: object) => tasksOf(p).filter((t) => t.template === TEMPLATE.RECORDING);

    it('C31 assessed receipts become evidence only at Finish and are consumed', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const [task] = recordings(p);
      const { body } = await assess(p.sessionId, task.id).expect(200);
      expect(body).toMatchObject({ validity: 'valid', passed: true });
      expect(await h.count(skillEvidence)).toBe(0);
      const receipts = new Map([[task.id, body.assessmentReceiptId]]);
      await commit(p, answers(p, { receipts })).expect(200);
      const evidence = await h.first(skillEvidence, eq(skillEvidence.skill, SKILL.SPEAKING));
      expect(evidence).toMatchObject({ passed: true, reasons: [EVIDENCE_REASON.NEW_PRACTICE], assessmentReceiptId: body.assessmentReceiptId });
      expect((await h.first(speechAssessmentReceipts)).consumedAt).not.toBeNull();
    });

    it('C20 invalid audio is not a failure', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const [task] = recordings(p);
      h.speech.next = { validity: VALIDITY.INVALID, accuracyScore: null, meta: {} };
      const { body } = await assess(p.sessionId, task.id).expect(200);
      expect(body).toMatchObject({ validity: 'invalid', passed: null });
      await commit(p, answers(p, { receipts: new Map([[task.id, body.assessmentReceiptId]]) })).expect(200);
      expect(await h.first(skillEvidence, eq(skillEvidence.skill, SKILL.SPEAKING))).toMatchObject({ validity: 'invalid', passed: null });
    });

    it('C61 provider outage is retryable 503, not a result', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      h.speech.next = new ApiError('SPEECH_PROVIDER_UNAVAILABLE');
      const res = await assess(p.sessionId, recordings(p)[0].id).expect(503);
      expect(res.body).toMatchObject({ code: 'SPEECH_PROVIDER_UNAVAILABLE', retryable: true });
      expect(await h.count(speechAssessmentReceipts)).toBe(0);
    });

    it('stops assessing once maxRetries is used, before calling the provider', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const [task] = recordings(p);
      const allowed = 1 + POLICY.practice.maxRetries[TEMPLATE.RECORDING];
      expect(task.maxRetries).toBe(POLICY.practice.maxRetries[TEMPLATE.RECORDING]);
      h.speech.next = { validity: VALIDITY.VALID, accuracyScore: 40, meta: {} };
      for (let i = 0; i < allowed; i += 1) await assess(p.sessionId, task.id).expect(200);
      // A provider call would surface as 503 here.
      h.speech.next = new ApiError('SPEECH_PROVIDER_UNAVAILABLE');
      const res = await assess(p.sessionId, task.id).expect(422);
      expect(res.body).toMatchObject({ code: 'INVALID_SUBMISSION' });
      expect(await h.count(speechAssessmentReceipts)).toBe(allowed);
    });

    it('transcribed takes are scored at Finish as Speaking evidence with no receipt', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const [task] = recordings(p);
      const [reference] = task.evaluation.acceptedResponses;
      const takes = [{ seq: 1, action: 'transcribed', transcript: 'zzz' }, { seq: 2, action: 'transcribed', transcript: reference }];
      await commit(p, answers(p, { override: (t) => (t.id === task.id ? takes : undefined) })).expect(200);
      const evidence = await h.first(skillEvidence, eq(skillEvidence.skill, SKILL.SPEAKING));
      expect(evidence).toMatchObject({ passed: true, reasons: [EVIDENCE_REASON.NEW_PRACTICE], assessmentReceiptId: null });
      expect(await h.count(speechAssessmentReceipts)).toBe(0);
    });

    it('rejects non-recording tasks and foreign sessions', async () => {
      await onboard(words(4));
      await goal(1);
      const p = await plan();
      const typingish = tasksOf(p).find((t) => t.template !== TEMPLATE.RECORDING);
      await assess(p.sessionId, typingish.id).expect(422);
    });
  });

  describe('review and SRS', () => {
    it('C01 C41 a Meaning in two Topics shares one progress row', async () => {
      const seeded = await onboard(words(4));
      const [other] = await h.db
        .insert(topics)
        .values({ collectionId: seeded.collectionId, slug: 'second', title: 'second', status: 'published' })
        .returning({ id: topics.id });
      await h.db.insert(topicMeanings).values({ topicId: other.id, meaningId: seeded.meaningIds[0], curatedRank: 1 });
      await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId, other.id] }).expect(200);
      await goal(4);
      const p = await plan();
      await commit(p, answers(p)).expect(200);
      const ids = (await progressRows()).map((r) => r.meaningId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('C02 C03 only the focused Meaning learns; a new Meaning of a learned Word takes its own goal slot', async () => {
      const seeded = await onboard(words(4));
      const admin = h.app.get(AdminService);
      const example = { sourceText: 'Use bank here.', targetLocator: { start: 4, end: 8 } };
      const created = await admin.createWord({
        language: 'en', lemma: 'bank',
        types: [{
          partOfSpeech: 'noun',
          pronunciations: [{ accentLocale: 'en-US', ipa: '/bæŋk/' }],
          meanings: [{ cefrLevel: 'B1', examples: [example] }, { cefrLevel: 'B1', examples: [example] }],
        }],
      });
      const [first, second] = created.types[0].meanings;
      for (const [index, meaning] of [first, second].entries()) {
        await admin.putMeaningLocale(meaning.id, 'vi-VN', {
          meaningText: `ngân hàng ${index}`, definitionText: 'x', editorialState: 'approved',
          exampleTranslations: [{ exampleId: meaning.examples[0].id, translationText: 'dịch' }],
        });
        await h.app.get(PublicationService).publish(meaning.id, 'vi-VN');
      }
      await h.db.insert(topicMeanings).values([first, second].map((m, i) => ({ topicId: seeded.topicId, meaningId: m.id, curatedRank: 100 + i })));
      await h.db.delete(topicMeanings).where(inArray(topicMeanings.meaningId, seeded.meaningIds.slice(1)));

      await goal(2);
      const today = await plan();
      expect(learnIds(today)).toHaveLength(2);
      await commit(today, answers(today)).expect(200);
      const learned = (await progressRows()).map((r) => r.meaningId);
      expect(learned).toContain(first.id);
      expect(learned).not.toContain(second.id);

      h.clock.advance(24);
      const tomorrow = await plan();
      await commit(tomorrow, answers(tomorrow)).expect(200);
      expect((await progressRows()).map((r) => r.meaningId)).toContain(second.id);
    });

    it('the most popular Meaning of a Word is learned first, ahead of CEFR fit and curated rank', async () => {
      const seeded = await onboard(words(4), 'B1');
      const admin = h.app.get(AdminService);
      const example = { sourceText: 'Use bank here.', targetLocator: { start: 4, end: 8 } };
      const created = await admin.createWord({
        language: 'en', lemma: 'bank',
        types: [{
          partOfSpeech: 'noun',
          pronunciations: [{ accentLocale: 'en-US', ipa: '/bæŋk/' }],
          meanings: [{ cefrLevel: 'B1', popularity: 20, examples: [example] }, { cefrLevel: 'A1', popularity: 90, examples: [example] }],
        }],
      });
      const [rare, common] = created.types[0].meanings;
      for (const meaning of [rare, common]) {
        await admin.putMeaningLocale(meaning.id, 'vi-VN', {
          meaningText: `ngân hàng ${meaning.id}`, definitionText: 'x', editorialState: 'approved',
          exampleTranslations: [{ exampleId: meaning.examples[0].id, translationText: 'dịch' }],
        });
        await h.app.get(PublicationService).publish(meaning.id, 'vi-VN');
      }
      await h.db.insert(topicMeanings).values([rare, common].map((m, i) => ({ topicId: seeded.topicId, meaningId: m.id, curatedRank: 100 + i })));
      await h.db.delete(topicMeanings).where(inArray(topicMeanings.meaningId, seeded.meaningIds));

      await goal(2);
      const p = await plan();
      await commit(p, answers(p)).expect(200);
      const learned = (await progressRows()).map((r) => r.meaningId);
      expect(learned).toEqual([common.id]);
    });

    it('a completed session never blocks the next: each daily plan offers a fresh goal of new Meanings', async () => {
      await onboard(words(4));
      await learnOne();
      expect(learnIds(await plan())).toHaveLength(1);
    });

    it('C04 due Meaning outside active Topics is not selected', async () => {
      await onboard(words(4));
      await learnOne();
      const other = await h.seed('topic-b', words(1, 10));
      await api('put', '/v1/me/scope').send({ collectionId: other.collectionId, topicIds: [other.topicId] }).expect(200);
      h.clock.advance(100);
      const p = await plan();
      expect(p.steps.filter((s: { phase?: string }) => s.phase === 'due_review')).toEqual([]);
    });

    it('due review reschedules a Meaning; C35 skill-only review leaves it due', async () => {
      await onboard(words(4));
      await learnOne();
      await goal(1);
      h.clock.advance(48);
      const home = (await api('get', '/v1/me/learn-home').expect(200)).body;
      expect(home).toMatchObject({ dueCount: 1, learnedTotal: 1 });

      h.planner.setRng(() => 0.9);
      const p = await plan();
      const due = p.steps.filter((s: { phase?: string }) => s.phase === 'due_review');
      expect(due.length).toBeGreaterThan(0);
      const before = (await progressRows())[0];
      await commit(p, answers(p)).expect(200);
      const after = await h.first(userMeaningProgress, and(eq(userMeaningProgress.userId, before.userId), eq(userMeaningProgress.meaningId, before.meaningId)));
      expect(after.version).toBe(2);
      expect(after.nextReviewAt.getTime()).toBeGreaterThan(h.clock.current.getTime());
    });

    it('C24 non-Daily success does not extend the schedule', async () => {
      await onboard(words(4));
      await learnOne();
      const [before] = await progressRows();
      h.clock.advance(100);
      const p = await plan('random_practice');
      await commit(p, answers(p)).expect(200);
      const [after] = await progressRows();
      expect(after.nextReviewAt).toEqual(before.nextReviewAt);
      expect(after.lastReviewedAt?.getTime()).toBeGreaterThanOrEqual(before.lastReviewedAt!.getTime());
    });

    it('C36 C37 contextual items reach only learners at or above the rated level', async () => {
      const seeded = await onboard(words(5), 'A1');
      await learnOne();
      const admin = h.app.get(AdminService);
      const content = (text: string) => ({
        promptVariants: { text: { text } },
        options: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }],
      });
      const publish = async (text: string, contextCefrLevel?: 'B2') => {
        const { id } = await admin.createItem({
          template: TEMPLATE.SELECT, variant: 'meaning_clash', contextCefrLevel,
          sourceContent: content(text), sourceEvaluation: { correctOptionId: 1 },
          targets: [{ meaningId: seeded.meaningIds[0] }],
        });
        await admin.putItemLocale(id, 'vi-VN', { localizedContent: {}, editorialState: 'approved' });
        await admin.publishItem(id);
      };
      await publish('rated context', 'B2');
      await publish('unrated context');

      const issuedText = async () => {
        const plans = [];
        for (let i = 0; i < 25; i += 1) plans.push(await plan('random_practice'));
        return JSON.stringify(plans.map((p) => tasksOf(p).map((t) => t.prompt)));
      };
      const lowLevel = await issuedText();
      expect(lowLevel).not.toContain('rated context');

      await h.db.update(appUsers).set({ proficiencyLevel: 'C1' });
      const highLevel = await issuedText();
      expect(highLevel).toContain('"rated context"');
      expect(highLevel).not.toContain('unrated context');
    });

    it('weak practice picks Meanings with recent failures only', async () => {
      await onboard(words(4));
      await goal(1);
      const failAnswers = (t: { template: string; options?: unknown }) =>
        (t.options || t.template === TEMPLATE.TYPING || t.template === TEMPLATE.FLY_REORDER ? wrongEvents(t) : undefined);
      const p = await plan();
      await commit(p, answers(p, { override: failAnswers })).expect(200);
      expect((await plan('weak_words_practice')).steps).toEqual([]);
      for (let i = 0; i < 2; i += 1) {
        const practice = await plan('random_practice');
        await commit(practice, answers(practice, { override: failAnswers })).expect(200);
      }
      const weak = await plan('weak_words_practice');
      expect(tasksOf(weak).length).toBeGreaterThan(0);
      h.clock.advance(31 * 24);
      expect((await plan('weak_words_practice')).steps).toEqual([]);
    });

    it('C22 C21 C51 skills verify across sessions and a later failure revokes', async () => {
      await onboard(words(4));
      const wordIds = (await h.db.select({ id: wordsTable.id }).from(wordsTable).orderBy(asc(wordsTable.id))).map((w) => w.id);
      await learnOne();
      h.planner.setRng(() => 0.99);
      const reviewAndGet = async () => {
        h.clock.advance(30);
        const p = await plan('random_practice');
        await commit(p, answers(p)).expect(200);
        return (await api('get', `/v1/words/${wordIds[0]}`).expect(200)).body;
      };
      const statuses = (word: { meanings: { skills: Record<string, { status: string } | undefined> }[] }) =>
        Object.values(word.meanings[0].skills).map((s) => s?.status);

      await reviewAndGet();
      const word = await reviewAndGet();
      expect(statuses(word)).toContain('verified');
      expect(word.fullyVerified).toBe(false);

      h.clock.advance(30);
      const failing = await plan('random_practice');
      await commit(failing, answers(failing, { override: (t) => (t.options || t.tiles || t.template === TEMPLATE.TYPING ? wrongEvents(t) : undefined) })).expect(200);
      const revoked = (await api('get', `/v1/words/${wordIds[0]}`).expect(200)).body;
      expect(statuses(revoked)).not.toContain('verified');
      expect(revoked.needsPractice).toBe(true);
      expect((await api('get', '/v1/me/words/stats').expect(200)).body).toEqual({ learnedWords: 1, needPracticeWords: 1 });
    });

    describe('memory grading after verified', () => {
      type Task = { template: string; options?: unknown; tiles?: unknown };
      const graded = (t: Task) => Boolean(t.options || t.tiles || t.template === TEMPLATE.TYPING);
      const statuses = (word: { meanings: { skills: Record<string, { status: string } | undefined> }[] }) =>
        Object.values(word.meanings[0].skills).map((s) => s?.status);

      const issues = (word: { meanings: { skills: Record<string, { issue: string | null } | undefined> }[] }) =>
        Object.values(word.meanings[0].skills).flatMap((s) => (s?.issue ? [s.issue] : []));

      async function verifiedWord() {
        await onboard(words(4));
        const wordId = (await h.db.select({ id: wordsTable.id }).from(wordsTable).orderBy(asc(wordsTable.id)))[0].id;
        await learnOne();
        h.planner.setRng(() => 0.99);
        const review = async (override?: (t: Task) => object[] | undefined) => {
          h.clock.advance(30);
          const p = await plan('random_practice');
          await commit(p, answers(p, { override })).expect(200);
          return (await api('get', `/v1/words/${wordId}`).expect(200)).body;
        };
        await review();
        const word = await review();
        expect(statuses(word)).toContain('verified');
        expect(word.needsPractice).toBe(false);
        return review;
      }

      it('show answer revokes verified and flags the word', async () => {
        const review = await verifiedWord();
        const word = await review((t) => (graded(t) ? [{ seq: 1, action: 'reveal' }] : undefined));
        expect(statuses(word)).not.toContain('verified');
        expect(word.needsPractice).toBe(true);
        expect(issues(word)).toContain('failed');
        expect((await api('get', '/v1/me/words/stats').expect(200)).body).toEqual({ learnedWords: 1, needPracticeWords: 1 });
      });

      it('a hint before a correct answer keeps verified, and only a later unaided answer clears the flag', async () => {
        const review = await verifiedWord();
        const hinted = (t: Task) => (graded(t)
          ? [{ seq: 1, action: 'hint' }, ...correctEvents(t).map((e) => ({ ...e, seq: e.seq + 1 }))]
          : undefined);
        const word = await review(hinted);
        expect(statuses(word)).toContain('verified');
        expect(issues(word)).toContain('assisted');
        expect(issues(word)).not.toContain('failed');
        expect(word.needsPractice).toBe(true);
        expect((await api('get', '/v1/me/words/stats').expect(200)).body).toEqual({ learnedWords: 1, needPracticeWords: 1 });

        h.clock.advance(1);
        const soon = await plan('random_practice');
        await commit(soon, answers(soon)).expect(200);
        expect((await api('get', '/v1/me/words/stats').expect(200)).body.needPracticeWords).toBe(1);

        const recovered = await review();
        expect(issues(recovered)).toEqual([]);
        expect((await api('get', '/v1/me/words/stats').expect(200)).body.needPracticeWords).toBe(0);
      });

      it('mistakes while learning a new word do not flag it', async () => {
        await onboard(words(4));
        await goal(1);
        const wordId = (await h.db.select({ id: wordsTable.id }).from(wordsTable).orderBy(asc(wordsTable.id)))[0].id;
        const p = await plan();
        await commit(p, answers(p, { override: (t) => (graded(t) ? wrongEvents(t) : undefined) })).expect(200);
        const word = (await api('get', `/v1/words/${wordId}`).expect(200)).body;
        expect(word.needsPractice).toBe(false);
        expect(issues(word)).toEqual([]);
        expect((await api('get', '/v1/me/words/stats').expect(200)).body).toEqual({ learnedWords: 1, needPracticeWords: 0 });
      });

      it('a second-try recall stores the retried reason', async () => {
        await onboard(words(4));
        await goal(1);
        h.planner.setRng(() => 0);
        const p = await plan();
        expect(tasksOf(p).some((t) => t.template === TEMPLATE.TYPING)).toBe(true);
        const retry = (t: Task) => {
          if (t.template !== TEMPLATE.TYPING) return undefined;
          const wrong = wrongEvents(t);
          return [...wrong, ...correctEvents(t).map((e, i) => ({ ...e, seq: wrong.length + i + 1 }))];
        };
        await commit(p, answers(p, { override: retry })).expect(200);
        const rows = await h.db.select({ reasons: skillEvidence.reasons }).from(skillEvidence);
        expect(rows.some((r) => r.reasons.includes(EVIDENCE_REASON.RETRIED))).toBe(true);
        expect((await h.first(memoryObservations)).signal).toBe(MEMORY_SIGNAL.ASSISTED_RECALL);
      });

      it('Weak practices only the skill with the issue, and a clean pass there clears it', async () => {
        const review = await verifiedWord();
        const word = await review((t) => (graded(t) ? wrongEvents(t) : undefined));
        const flagged = Object.entries(word.meanings[0].skills as Record<string, { issue: string | null }>)
          .filter(([, s]) => s?.issue).map(([skill]) => skill);
        expect(flagged.length).toBeGreaterThan(0);

        h.clock.advance(30);
        const p = await plan('weak_words_practice');
        await commit(p, answers(p)).expect(200);
        const rows = await h.db.select({ skill: skillEvidence.skill, reasons: skillEvidence.reasons })
          .from(skillEvidence).where(eq(skillEvidence.sessionId, p.sessionId));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(flagged).toContain(row.skill);
          expect(row.reasons).toEqual([]);
        }
        const wordId = word.wordId;
        const after = (await api('get', `/v1/words/${wordId}`).expect(200)).body;
        for (const skill of new Set(rows.map((r) => r.skill))) expect(after.meanings[0].skills[skill].issue).toBeNull();
      });

      it('Weak rotates instead of repeating the same failing words', async () => {
        await onboard(words(14));
        await learnOne(12);
        // Keeps shuffle stable, so two rounds of 10 cover all 12 Meanings.
        h.planner.setRng(() => 0.99);
        const fail = (t: Task) => (graded(t) ? wrongEvents(t) : undefined);
        for (let i = 0; i < 2; i += 1) {
          h.clock.advance(1);
          const practice = await plan('random_practice');
          await commit(practice, answers(practice, { override: fail })).expect(200);
        }
        const weakSession = async () => {
          h.clock.advance(1);
          const p = await plan('weak_words_practice');
          await commit(p, answers(p, { override: fail })).expect(200);
          const rows = await h.db.select({ id: memoryObservations.meaningId }).from(memoryObservations).where(eq(memoryObservations.sessionId, p.sessionId));
          return rows.map((r) => r.id);
        };
        const first = await weakSession();
        const second = await weakSession();
        expect(first).toHaveLength(POLICY.session.practiceTaskCap);
        expect(second.some((id) => !first.includes(id))).toBe(true);
      });
    });

    it('pages and searches the library without skill states', async () => {
      await onboard(words(4).map((word, i) => ({ ...word, meaningText: `Đường đi ấm áp ${i}` })));
      await goal(3);
      const p = await plan();
      await commit(p, answers(p)).expect(200);

      const first = (await api('get', '/v1/me/words?limit=2').expect(200)).body.words;
      const second = (await api('get', '/v1/me/words?limit=2&offset=2').expect(200)).body.words;
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(1);
      expect(new Set([...first, ...second].map((w: { wordId: string }) => w.wordId)).size).toBe(3);
      expect(first[0].meanings[0].meaningId).toEqual(expect.any(String));
      expect(first[0].meanings[0].skills).toBeUndefined();
      expect(first[0].needsPractice).toBeUndefined();
      expect((await api('get', '/v1/me/words/stats').expect(200)).body).toEqual({ learnedWords: 3, needPracticeWords: 0 });

      const search = async (q: string) =>
        (await api('get', `/v1/me/words?q=${encodeURIComponent(q)}`).expect(200)).body.words as { wordId: string }[];
      const target = first[0];
      expect((await search(target.lemma.toUpperCase())).map((w) => w.wordId)).toEqual([target.wordId]);
      expect(await search('%')).toEqual([]);
      expect(await search('no such word')).toEqual([]);

      const suffix = target.meanings[0].meaning.text.at(-1);
      expect((await search(`duong di am ap ${suffix}`)).map((w) => w.wordId)).toEqual([target.wordId]);
      expect((await search(`ĐƯỜNG ĐI ẤM ÁP ${suffix}`)).map((w) => w.wordId)).toEqual([target.wordId]);
    });
  });

  describe('checkpoint', () => {
    const SESSIONS = POLICY.checkpoint.sessionsPerChallenge;
    const challenges = async () => (await api('get', '/v1/me/checkpoint-challenges').expect(200)).body.challenges;
    const learnSessions = async (n: number) => { for (let i = 0; i < n; i += 1) await learnOne(); };

    it('C25 creates no challenge before enough learning sessions, however much time passes', async () => {
      await onboard(words(SESSIONS + 1));
      await learnSessions(SESSIONS - 1);
      h.clock.advance(24 * 30);
      expect(await challenges()).toEqual([]);
    });

    it('learn-home counts sessions towards the next challenge and restarts after unlock', async () => {
      const progress = async () => {
        const { checkpointSessionsDone, checkpointSessionsRequired } = (await api('get', '/v1/me/learn-home').expect(200)).body;
        return [checkpointSessionsDone, checkpointSessionsRequired];
      };
      await onboard(words(SESSIONS + 2));
      expect(await progress()).toEqual([0, SESSIONS]);
      await learnSessions(SESSIONS - 1);
      expect(await progress()).toEqual([SESSIONS - 1, SESSIONS]);
      await learnSessions(1);
      expect(await progress()).toEqual([0, SESSIONS]);
      await learnSessions(1);
      expect(await progress()).toEqual([1, SESSIONS]);
    });

    it('C26 unlocks after N sessions on one day and completes once', async () => {
      await onboard(words(SESSIONS * 2 + 1));
      await learnSessions(SESSIONS);

      const [challenge, ...rest] = await challenges();
      expect(rest).toEqual([]);
      expect(challenge).toMatchObject({ sequence: 1, meaningCount: SESSIONS });
      expect((await api('get', '/v1/me/learn-home').expect(200)).body.checkpointAvailable).toBe(1);

      const p = await plan('checkpoint_challenge');
      expect(tasksOf(p).length).toBeGreaterThan(0);
      for (const task of tasksOf(p).filter((t) => t.template !== TEMPLATE.RECORDING)) {
        expect([TEMPLATE.TYPING, TEMPLATE.FLY_REORDER, TEMPLATE.SELECT, TEMPLATE.CLOZE_SELECT, TEMPLATE.SURGERY]).toContain(task.template);
      }
      await commit(p, answers(p)).expect(200);
      expect(await challenges()).toEqual([]);
      await api('post', '/v1/sessions/plan').send({ mode: 'checkpoint_challenge', capabilities: CAPS }).expect(404);

      // Meanings already in a challenge do not count towards the next one.
      await learnSessions(SESSIONS - 1);
      expect(await challenges()).toEqual([]);
      await learnSessions(1);
      expect((await challenges())[0]).toMatchObject({ sequence: 2, meaningCount: SESSIONS });
    });
  });

  describe('timestamps', () => {
    it('stores true instants: the query builder and raw SQL agree', async () => {
      await onboard(words(4));
      await learnOne();
      const { rows: [row] } = await h.db.execute<{ iso: string }>(sql`
        SELECT to_char(learned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso FROM user_meaning_progress`);
      expect(row.iso).toBe('2026-11-02T03:00:00Z');
      expect((await progressRows())[0].learnedAt.toISOString()).toBe('2026-11-02T03:00:00.000Z');
    });
  });

  describe('maintenance', () => {
    it('expires sessions, purges snapshots after retention, keeps committed history', async () => {
      await onboard(words(4));
      await goal(1);
      const stale = await plan();
      const kept = await plan();
      await commit(kept, answers(kept)).expect(200);

      const service = h.app.get(MaintenanceService);
      h.clock.advance(73);
      expect(await service.cleanup()).toBe(1);
      expect((await h.first(learningSessions, eq(learningSessions.id, stale.sessionId))).status).toBe('expired');

      h.clock.advance(24 * 31);
      await service.cleanup();
      const session = (id: string) => h.first(learningSessions, eq(learningSessions.id, id));
      expect((await session(stale.sessionId)).plan).toBeNull();
      const committed = await session(kept.sessionId);
      expect(committed).toMatchObject({ plan: null, rawEvents: null, status: 'committed' });
      expect(committed.result).toMatchObject({ tasks: expect.any(Array) });
      await commit(kept, answers(kept)).expect(200);
    });
  });

  describe('performance: query count does not grow with data (no N+1)', () => {
    const measure = async (meanings: number) => {
      await h.reset();
      auth = await h.token(USER);
      await onboard(words(meanings + 3));
      await goal(meanings);
      const planned = await h.countQueries(() => plan());
      const body = answers(planned.result);
      const committed = await h.countQueries(() => commit(planned.result, body).expect(200));
      const home = await h.countQueries(() => api('get', '/v1/me/learn-home').expect(200));
      const list = await h.countQueries(() => api('get', '/v1/me/words').expect(200));
      return { plan: planned.queries, commit: committed.queries, home: home.queries, words: list.queries };
    };

    it('plan, commit, learn-home and me/words stay constant from 1 to 20 Meanings', async () => {
      const small = await measure(1);
      const large = await measure(20);
      if (process.env.PRINT_QUERY_COUNTS) console.error('QUERY_COUNTS', JSON.stringify({ small, large }));
      expect(large).toEqual(small);
      for (const count of Object.values(small)) expect(count).toBeGreaterThan(0);
      expect(small.commit).toBeLessThan(8);
    }, 120_000);
  });
});
