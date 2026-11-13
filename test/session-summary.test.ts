import { asc, eq } from 'drizzle-orm';
import { ASSESSMENT_INTENT, TEMPLATE } from '../src/common/constants/domain';
import { learningSessions, words as wordsTable } from '../src/db/schema';
import { ServerEvaluation } from '../src/modules/practice-resolver/task.types';
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
      expect(summary).toMatchObject({ practice: null, skillChanges: null, needPractice: null, countedAsReview: null });
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
      expect(summary.newWords.groups.revealed).toEqual([expect.objectContaining({
        cause: expect.stringMatching(/^(out_of_tries|wrong_choice)$/), struggledAt: expect.stringMatching(/^(reading|writing|listening|speaking)$/),
      })]);
    });

    it('C66 a recording the learner could not do keeps the word smooth', async () => {
      await onboard(6);
      await goal(1);
      const p = await plan();
      expect((tasksOf(p) as Task[]).some((t) => t.template === TEMPLATE.RECORDING)).toBe(true);
      // The driver answers recordings without a receipt as `unavailable`.
      const { summary } = (await commit(p, answers(p)).expect(200)).body;
      expect(summary.newWords.groups.smooth).toHaveLength(1);
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

    it('C69 random practice: answers and skill changes, no daily blocks, replayed whole', async () => {
      await onboard(6);
      await learn(3);
      h.clock.advance(24 * 3);
      const { p, response } = await practiced('random_practice', undefined, { skills: ['writing'] });
      const { summary } = response.body;
      expect(summary).toMatchObject({ review: null, newWords: null });
      expect(summary.practice.total).toBe(summary.practice.groups.clean.length);
      expect(summary.practice.total + summary.practice.excluded.count).toBeGreaterThan(0);
      expect(summary.skillChanges).toMatchObject({ cleared: [], pendingConfirm: [], regressed: [] });
      expect(summary.skillChanges.leveledUp.length).toBeGreaterThan(0);
      expect(summary.needPractice).toEqual({ before: 0, after: 0 });
      // Every word is due after three days: exactly the unprimed recalls count as its review.
      const recalled = new Set((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).plan!.tasks
        .filter((t) => { const e = t.serverEvaluation as ServerEvaluation; return e.intent === ASSESSMENT_INTENT.MEANING_RECALL && !e.isPrimed; })
        .flatMap((t) => t.targets.flatMap((g) => g.meaningId ?? [])));
      expect(new Set(ids(summary.countedAsReview))).toEqual(recalled);

      const retried = await commit(p, answers(p)).expect(200);
      expect(retried.text).toBe(response.text);
      expect((await api('get', `/v1/sessions/${p.sessionId}/commit-status`).expect(200)).body.response).toEqual(response.body);
      expect((await result(p.sessionId)).summary).toEqual({
        practiceTotal: summary.practice.total, practiceClean: summary.practice.groups.clean.length,
        leveledUp: summary.skillChanges.leveledUp.length, needPracticeAfter: 0,
      });
    });

    it('C70 practice on words not yet due is not counted as review', async () => {
      await onboard(6);
      await learn(3);
      h.clock.advance(1);
      const { response } = await practiced('random_practice');
      expect(response.body.summary.countedAsReview).toEqual([]);
    });

    it('C71 a failure regresses the skill and raises needPractice', async () => {
      await onboard(6);
      await learn(1);
      h.clock.advance(30);
      const { response } = await practiced('random_practice', fail);
      const { summary } = response.body;
      expect(summary.practice.groups.missed.length).toBeGreaterThan(0);
      expect(summary.skillChanges.regressed.length).toBeGreaterThan(0);
      expect(summary.needPractice).toEqual({ before: 0, after: 1 });
    });

    it('C72 weak: a pass before 12 h waits to confirm; after 12 h it clears and the count drops', async () => {
      await onboard(6);
      await learn(1);
      h.clock.advance(30);
      await practiced('random_practice', fail);

      h.clock.advance(1);
      const early = (await practiced('weak_words_practice')).response.body.summary;
      expect(early.skillChanges.pendingConfirm.length).toBeGreaterThan(0);
      const confirmableAt = new Date(early.skillChanges.pendingConfirm[0].confirmableAt).getTime();
      expect(confirmableAt).toBe(h.clock.now().getTime() + 11 * 3_600_000);
      expect(early.skillChanges.cleared).toEqual([]);
      expect(early.needPractice).toEqual({ before: 1, after: 1 });
      expect(early.practice.groups.clean.every((i: { hadIssue: boolean }) => i.hadIssue)).toBe(true);

      h.clock.advance(12);
      const late = (await practiced('weak_words_practice')).response.body.summary;
      expect(late.skillChanges.cleared.length).toBeGreaterThan(0);
      expect(late.needPractice).toEqual({ before: 1, after: 0 });
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
