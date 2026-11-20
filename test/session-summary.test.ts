import { asc, eq } from 'drizzle-orm';
import { TEMPLATE, VALIDITY } from '../src/common/constants/domain';
import { POLICY } from '../src/config/policy';
import { learningSessions, userSpeakingProgress, words as wordsTable } from '../src/db/schema';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, correctEvents, tasksOf, wrongEvents } from './support/driver';

const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));
type Task = { id: string; template: string; options?: unknown; tiles?: unknown; prompt?: { type: string } };
type Item = { meaningId: string; wordId: string; lemma: string; gloss: string; nextReviewAt: string; learnedAt?: string; struggledAt?: string };
const graded = (t: Task) => Boolean(t.options || t.tiles || t.template === TEMPLATE.TYPING);
const fail = (t: Task) => (graded(t) ? wrongEvents(t) : undefined);
const ids = (items: Item[]) => items.map((i) => i.meaningId);

describe('commit summary for the results screen', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put', path: string) => h.http()[method](path).set('Authorization', `Bearer ${auth}`);
  async function onboard(n: number) {
    const seeded = await h.seed('topic-a', words(n));
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
  }
  const plan = async (extra: object = {}, mode = 'daily') =>
    (await api('post', '/v1/sessions/plan').send({ mode, capabilities: CAPS, ...extra }).expect(200)).body;
  const commit = (p: { sessionId: string }, body: object) => api('post', `/v1/sessions/${p.sessionId}/commit`).send(body);
  const goal = (n: number) => api('put', '/v1/me/settings').send({ dailyNewWordGoal: n }).expect(200);
  const result = async (sessionId: string) => (await h.first(learningSessions, eq(learningSessions.id, sessionId))).result as { summary?: object };
  async function learn(n: number) {
    await goal(n);
    const p = await plan();
    return (await commit(p, answers(p)).expect(200)).body;
  }

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    h.planner.setRng(Math.random);
    auth = await h.token('summary-user');
  });

  describe('daily', () => {
    it('C63 a first session: new words grouped, review empty but present, replayed byte for byte', async () => {
      await onboard(6);
      await goal(2);
      const p = await plan();
      const body = answers(p);
      const first = await commit(p, body).expect(200);
      const { summary } = first.body;
      expect(summary.review).toEqual({ total: 0, groups: { solid: [], shaky: [], relearn: [] } });
      expect(summary.newWords.total).toBe(2);
      expect(summary.newWords.groups).toMatchObject({ retried: [], revealed: [], known: [] });
      expect(summary.newWords.groups.smooth).toHaveLength(2);
      const lemmas = (await h.db.select({ lemma: wordsTable.lemma }).from(wordsTable)).map((w) => w.lemma);
      for (const item of summary.newWords.groups.smooth as Item[]) {
        expect(lemmas).toContain(item.lemma);
        expect(item.gloss).toMatch(/^nghĩa \d+$/);
        expect(item.wordId).toEqual(expect.any(String));
        expect(new Date(item.nextReviewAt).getTime()).toBeGreaterThan(h.clock.now().getTime());
      }
      expect(summary).toMatchObject({ practice: null, speaking: null, skillChanges: null, needPractice: null, countedAsReview: null });
      // The legacy counts stay for one release.
      expect(summary).toMatchObject({ newWordGoalSlots: 2, knownMeanings: 0, practiceTasks: expect.any(Number) });

      const retried = await commit(p, body).expect(200);
      expect(retried.text).toBe(first.text);
      const status = (await api('get', `/v1/sessions/${p.sessionId}/commit-status`).expect(200)).body;
      expect(status.response).toEqual(first.body);
      expect((await result(p.sessionId)).summary).toEqual({ reviewTotal: 0, reviewSolid: 0, newTotal: 2, newSmooth: 2 });
    });

    it('C64 a review: unaided recall is solid, a failed recall is relearn, with the learned date', async () => {
      await onboard(6);
      const learned = await learn(2);
      const [keep, miss] = learned.summary.newWords.groups.smooth as Item[];
      h.clock.advance(24 * 5);
      const p = await plan({ reviewOnly: true });
      const tasksFor = new Map((tasksOf(p) as Task[]).map((t) => [t.id, t]));
      const missTasks = new Set((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).plan!.tasks
        .filter((t) => t.targets.some((g) => g.meaningId === miss.meaningId)).map((t) => t.id));
      const body = answers(p, { override: (t) => (missTasks.has(t.id) && graded(tasksFor.get(t.id)!) ? wrongEvents(t) : undefined) });
      const { summary } = (await commit(p, body).expect(200)).body;

      expect(summary.review.total).toBe(2);
      expect(ids(summary.review.groups.relearn)).toEqual([miss.meaningId]);
      expect(summary.review.groups.relearn[0]).toMatchObject({ cause: expect.stringMatching(/^(out_of_tries|wrong_choice)$/) });
      // A random plan may review the kept word by recognition only, or prime it: shaky, never relearn.
      const kept = [...summary.review.groups.solid, ...summary.review.groups.shaky] as Item[];
      expect(kept).toEqual([expect.objectContaining({ meaningId: keep.meaningId, lemma: keep.lemma, gloss: keep.gloss, learnedAt: expect.any(String) })]);
      // Review only: the new-word block is empty, never null.
      expect(summary.newWords).toEqual({ total: 0, groups: { smooth: [], retried: [], revealed: [], known: [] } });
      expect((await result(p.sessionId)).summary).toEqual({ reviewTotal: 2, reviewSolid: summary.review.groups.solid.length, newTotal: 0, newSmooth: 0 });
    });

    it('C65 mistakes while learning: revealed with the skill where it went wrong', async () => {
      await onboard(6);
      await goal(1);
      const p = await plan();
      const { summary } = (await commit(p, answers(p, { override: fail })).expect(200)).body;
      expect(summary.newWords.total).toBe(1);
      const [revealed] = summary.newWords.groups.revealed;
      expect(summary.newWords.groups.revealed).toHaveLength(1);
      expect(revealed.cause).toMatch(/^(out_of_tries|wrong_choice)$/);
      // A text recognition trains no form skill, so it may name none.
      if (revealed.struggledAt) expect(revealed.struggledAt).toMatch(/^(spelling|listening|speaking)$/);
    });

    it('C66 a recording the learner could not do keeps the word smooth', async () => {
      await onboard(6);
      await api('put', '/v1/me/settings').send({ dailySpeaking: true }).expect(200);
      await goal(1);
      const p = await plan();
      expect((tasksOf(p) as Task[]).some((t) => t.template === TEMPLATE.RECORDING)).toBe(true);
      // The driver answers recordings without a receipt as `unavailable`.
      const { summary } = (await commit(p, answers(p)).expect(200)).body;
      expect(summary.newWords.groups.smooth).toHaveLength(1);
      // A new word's recording never feeds speaking progress.
      expect(summary.speaking).toBeNull();
    });

    describe('"I know this"', () => {
      type Learn = { id: string; knownCheckTaskId: string; skippableTaskIds: string[] };
      const learnSteps = (p: { steps: { type: string }[] }) => p.steps.filter((s) => s.type === 'learn') as unknown as Learn[];

      it('C67 a passed check and a word marked known are known, outside the total', async () => {
        await onboard(6);
        await goal(2);
        const p = await plan({ knownCheck: true });
        const [checked, declared] = learnSteps(p);
        const dropped = new Set([...checked.skippableTaskIds, declared.knownCheckTaskId, ...declared.skippableTaskIds]);
        const body = {
          learnStepsCompleted: [],
          knownLearnSteps: [declared.id],
          taskResults: (tasksOf(p) as Task[]).filter((t) => !dropped.has(t.id))
            .map((t) => ({ taskId: t.id, events: correctEvents(t), ...(t.prompt?.type === 'audio' && { deliveryMode: 'audio' }) })),
        };
        const { summary } = (await commit(p, body).expect(200)).body;
        expect(summary.newWords.total).toBe(0);
        expect(summary.newWords.groups.known).toHaveLength(2);
      });

      it('C68 a failed check sorts the word by its other tasks', async () => {
        await onboard(6);
        await goal(1);
        const p = await plan({ knownCheck: true });
        const [step] = learnSteps(p);
        const body = answers(p, { override: (t) => (t.id === step.knownCheckTaskId ? wrongEvents(t) : undefined) });
        const { summary } = (await commit(p, body).expect(200)).body;
        expect(summary.newWords.groups.known).toEqual([]);
        expect(summary.newWords.groups.smooth).toHaveLength(1);
      });
    });
  });

  describe('random and weak practice', () => {
    async function practiced(mode: string, override?: (t: Task) => object[] | undefined, extra: object = {}) {
      const p = await plan(extra, mode);
      const response = await commit(p, answers(p, { override })).expect(200);
      return { p, response };
    }

    it('C69 random practice: answers grouped, no daily blocks, replayed whole', async () => {
      await onboard(6);
      await learn(3);
      h.clock.advance(24 * 3);
      const { p, response } = await practiced('random_practice');
      const { summary } = response.body;
      expect(summary).toMatchObject({ review: null, newWords: null, skillChanges: null });
      expect(summary.practice.groups.missed).toEqual([]);
      expect(summary.practice.total).toBeGreaterThan(0);
      const [first] = [...summary.practice.groups.clean, ...summary.practice.groups.helped];
      expect(first).toEqual({ meaningId: expect.any(String), wordId: expect.any(String), lemma: expect.any(String), gloss: expect.any(String), skill: first.skill });
      expect([null, 'spelling', 'listening', 'speaking']).toContain(first.skill);
      expect(summary.needPractice).toEqual({ before: 0, after: 0 });
      // Every word is due after three days: words answered cleanly count as their review.
      const practised = new Set((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).plan!.tasks
        .flatMap((t) => t.targets.flatMap((g) => g.meaningId ?? [])));
      expect(summary.countedAsReview.length).toBeGreaterThan(0);
      for (const id of ids(summary.countedAsReview)) expect(practised).toContain(id);

      const retried = await commit(p, answers(p)).expect(200);
      expect(retried.text).toBe(response.text);
      expect((await api('get', `/v1/sessions/${p.sessionId}/commit-status`).expect(200)).body.response).toEqual(response.body);
      expect((await result(p.sessionId)).summary).toEqual({
        practiceTotal: summary.practice.total, practiceClean: summary.practice.groups.clean.length, needPracticeAfter: 0,
      });
    });

    it('C70 practice on words not yet due is not counted as review', async () => {
      await onboard(6);
      await learn(3);
      h.clock.advance(1);
      const { response } = await practiced('random_practice');
      expect(response.body.summary.countedAsReview).toEqual([]);
    });

    it('C71 a word turns weak after enough recent misses, the latest one a miss', async () => {
      await onboard(6);
      await learn(1);
      // No bonus task or match: each session asks the word once.
      h.planner.setRng(() => 0.99);
      const counts = [];
      for (let i = 0; i < POLICY.weak.minAttempts; i += 1) {
        h.clock.advance(30);
        const { summary } = (await practiced('random_practice', fail)).response.body;
        expect(summary.practice.groups.missed).toHaveLength(1);
        counts.push(summary.needPractice);
      }
      expect(counts.at(-1)).toEqual({ before: 0, after: 1 });
      expect(counts.slice(0, -1).every((c) => c.after === 0)).toBe(true);
    });

    it('C72 weak: practises exactly the needPractice words, and a clean answer clears them at once', async () => {
      await onboard(6);
      await learn(2);
      h.planner.setRng(() => 0.99);
      for (let i = 0; i < POLICY.weak.minAttempts; i += 1) {
        h.clock.advance(30);
        await practiced('random_practice', fail);
      }
      const stats = (await api('get', '/v1/me/words/stats').expect(200)).body;
      expect(stats.needPracticeWords).toBe(2);

      h.clock.advance(1);
      const p = await plan({}, 'weak_words_practice');
      const weakMeanings = new Set((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).plan!.tasks
        .flatMap((t) => t.targets.flatMap((g) => g.meaningId ?? [])));
      expect(weakMeanings.size).toBe(stats.needPracticeWords);
      const { summary } = (await commit(p, answers(p)).expect(200)).body;
      // No waiting period: FSRS already spaces the reviews.
      expect(summary.needPractice).toEqual({ before: 2, after: 0 });
      expect((await api('get', '/v1/me/words/stats').expect(200)).body.needPracticeWords).toBe(0);
    });
  });

  describe('speaking', () => {
    type Recording = Task & { evaluation: { acceptedResponses: string[] } };
    const recordings = (p: { steps: { type: string }[] }) => (tasksOf(p) as Recording[]).filter((t) => t.template === TEMPLATE.RECORDING);
    const said = (text: string) => (t: Task) => (t.template === TEMPLATE.RECORDING ? [{ seq: 1, action: 'transcribed', transcript: text }] : undefined);
    const right = (t: Task) => (t.template === TEMPLATE.RECORDING ? said((t as Recording).evaluation.acceptedResponses[0])(t) : undefined);
    const progressRows = () => h.db.select().from(userSpeakingProgress);

    it('C74 speaking mode: two passing sessions make a word fluent, a miss slips it back', async () => {
      await onboard(4);
      await learn(1);
      const first = await plan({}, 'speaking_practice');
      expect(recordings(first)).toHaveLength(1);
      expect(recordings(first)[0]).toMatchObject({ meaningCue: expect.any(Object) });
      const one = (await commit(first, answers(first, { override: right })).expect(200)).body.summary;
      expect(one).toMatchObject({ practice: null, review: null, speaking: { total: 1, passed: 1, becameFluent: [], slipped: [] } });
      expect(await progressRows()).toEqual([expect.objectContaining({ status: 'practicing', deviceSessions: 1, deviceStreak: 1, lastPassed: true })]);
      expect((await result(first.sessionId)).summary).toEqual({ speakingTotal: 1, speakingPassed: 1 });

      h.clock.advance(24);
      const second = await plan({}, 'speaking_practice');
      const two = (await commit(second, answers(second, { override: right })).expect(200)).body.summary;
      expect(two.speaking.becameFluent).toEqual([expect.objectContaining({ status: 'fluent', score: null, lemma: expect.any(String) })]);

      h.clock.advance(24);
      const third = await plan({}, 'speaking_practice');
      const three = (await commit(third, answers(third, { override: said('zzz') })).expect(200)).body.summary;
      expect(three.speaking).toMatchObject({ total: 1, passed: 0, becameFluent: [], slipped: [expect.objectContaining({ status: 'practicing' })] });
      expect(await progressRows()).toEqual([expect.objectContaining({ status: 'practicing', deviceStreak: 0, fluentAt: null, deviceSessions: 3 })]);
    });

    it('C75 Azure: the first valid receipt is scored, not the one the learner kept', async () => {
      await onboard(4);
      await learn(1);
      const p = await plan({}, 'speaking_practice');
      const [task] = recordings(p);
      const assess = async (accuracyScore: number) => {
        h.speech.next = { validity: VALIDITY.VALID, accuracyScore, meta: {} };
        return (await api('post', `/v1/sessions/${p.sessionId}/recording-assess`).field('taskId', task.id)
          .attach('audio', Buffer.from('RIFF'), { filename: 'a.wav', contentType: 'audio/wav' }).expect(200)).body.assessmentReceiptId;
      };
      await assess(60);
      h.clock.advance(0.01);
      const kept = await assess(95);
      const { summary } = (await commit(p, answers(p, { receipts: new Map([[task.id, kept]]) })).expect(200)).body;
      expect(summary.speaking).toMatchObject({ total: 1, passed: 0 });
      expect(await progressRows()).toEqual([expect.objectContaining({ scoredSessions: 1, scoreAvg: 60, lastScore: 60, bestScore: 60, lastPassed: false })]);
    });

    it('C76 Daily with speaking on updates the table for due words only', async () => {
      await onboard(6);
      await api('put', '/v1/me/settings').send({ dailySpeaking: true }).expect(200);
      const learned = await learn(1);
      expect(learned.summary.speaking).toBeNull();
      expect(await progressRows()).toEqual([]);

      h.clock.advance(24 * 5);
      const p = await plan({ reviewOnly: true });
      expect(recordings(p)).toHaveLength(1);
      const { summary } = (await commit(p, answers(p, { override: right })).expect(200)).body;
      expect(summary.speaking).toMatchObject({ total: 1, passed: 1 });
      expect(await progressRows()).toHaveLength(1);
      expect((await result(p.sessionId)).summary).toMatchObject({ speakingTotal: 1, speakingPassed: 1 });
    });

    it('C77 speaking mode puts missed words first and needs a microphone', async () => {
      await onboard(6);
      await learn(3);
      const first = await plan({}, 'speaking_practice');
      const [missed] = recordings(first);
      await commit(first, answers(first, { override: (t) => (t.id === missed.id ? said('zzz')(t) : right(t)) })).expect(200);
      h.clock.advance(1);
      const next = await plan({}, 'speaking_practice');
      expect(recordings(next)[0].evaluation.acceptedResponses).toEqual(missed.evaluation.acceptedResponses);
      expect(await plan({ capabilities: { ...CAPS, microphone: false } }, 'speaking_practice')).toEqual({ sessionId: null, mode: 'speaking_practice', steps: [] });
    });
  });

  it('C73 the word ids belong to the labelled words', async () => {
    await onboard(4);
    const { summary } = await learn(2);
    const all = await h.db.select({ id: wordsTable.id, lemma: wordsTable.lemma }).from(wordsTable).orderBy(asc(wordsTable.id));
    for (const item of summary.newWords.groups.smooth as Item[]) {
      expect(all.find((w) => w.id === item.wordId)?.lemma).toBe(item.lemma);
    }
  });
});
