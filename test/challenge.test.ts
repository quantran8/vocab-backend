import { and, eq } from 'drizzle-orm';
import { MS_PER_HOUR } from '../src/common/constants/time';
import { POLICY } from '../src/config/policy';
import {
  appUsers, challengeChapterMeanings, challengeChapters, challengeLevelProgress, challengeRuns, memoryObservations, skillEvidence, userMeaningProgress,
} from '../src/db/schema';
import { Board, MatchEvent, RunPlan } from '../src/modules/challenge/domain/match-madness';
import { MaintenanceService } from '../src/modules/maintenance/services/maintenance.service';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers } from './support/driver';

const { challenge } = POLICY;
const CORE = challenge.chapterNewMeaningCount;
const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));
type IssuedRun = Omit<RunPlan, 'pairs'> & { runId: string; contentVersion: number; pairs: Omit<RunPlan['pairs'][number], 'meaningId'>[] };

describe('Challenge Map (Match Madness)', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, token = auth) =>
    h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const map = async (token = auth) => (await api('get', '/v1/me/challenge-map', token).expect(200)).body;
  const issue = (chapterNo: number, levelNo: number, token = auth) =>
    api('post', `/v1/challenge/chapters/${chapterNo}/levels/${levelNo}/runs`, token).send({});
  const start = (runId: string, token = auth) => api('post', `/v1/challenge/runs/${runId}/start`, token).send({});
  const commit = (runId: string, body: object, token = auth) => api('post', `/v1/challenge/runs/${runId}/commit`, token).send(body);
  const advanceMs = (ms: number) => h.clock.advance(ms / MS_PER_HOUR);

  async function onboard(n: number) {
    const seeded = await h.seed('topic-a', words(n));
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
  }
  /** Learns `n` Meanings in Daily, at most 30 per session. */
  async function learn(n: number) {
    for (let left = n; left > 0; left -= 30) {
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: Math.min(left, 30) }).expect(200);
      const plan = (await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
      await api('post', `/v1/sessions/${plan.sessionId}/commit`).send(answers(plan)).expect(200);
    }
  }

  /** Plays the board like the client: one correct pair per second, `wrongAt` adds a wrong pair at those match counts. */
  function play(run: IssuedRun, opts: { stepMs?: number; wrongAt?: number[]; stop?: number } = {}) {
    const board = new Board({ ...run, pairs: run.pairs.map((p) => ({ ...p, meaningId: p.word })) } as RunPlan, challenge.minMatchesBetweenRepeats);
    const events: MatchEvent[] = [];
    const add = (wordTileId: string, meaningTileId: string) =>
      events.push({ seq: events.length + 1, type: 'match', elapsedMs: (events.length + 1) * (opts.stepMs ?? 1000), wordTileId, meaningTileId });
    while (!board.done && board.correctCount < (opts.stop ?? Infinity)) {
      const [pair, other] = board.active;
      if (opts.wrongAt?.includes(board.correctCount) && other) {
        add(pair.wordTileId, other.meaningTileId);
        opts.wrongAt = opts.wrongAt.filter((n) => n !== board.correctCount);
      }
      add(pair.wordTileId, pair.meaningTileId);
      board.match(pair.wordTileId, pair.meaningTileId);
    }
    return events;
  }
  const cleared = (events: MatchEvent[]) => ({ events, endedReason: 'goal_reached', endedElapsedMs: events.at(-1)!.elapsedMs });

  /** Issue, start, play and commit one run; returns the commit response. */
  async function clear(chapterNo: number, levelNo: number, opts: { wrongAt?: number[]; stepMs?: number } = {}) {
    const run: IssuedRun = (await issue(chapterNo, levelNo).expect(201)).body;
    await start(run.runId).expect(200);
    const body = cleared(play(run, opts));
    advanceMs(body.endedElapsedMs);
    return (await commit(run.runId, body).expect(200)).body;
  }

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    auth = await h.token('user-1');
  });

  describe('map and chapter unlock', () => {
    it('shows vocabulary progress before chapter 1, then ready at 12 learned', async () => {
      await onboard(20);
      expect(await map()).toMatchObject({
        configVersion: challenge.version, gameMode: 'match_madness', chapters: [],
        nextChapter: { chapterNo: 1, state: 'needs_vocabulary', eligibleNewCount: 0, requiredNewCount: CORE }, currentNode: null,
      });
      await learn(CORE - 1);
      expect((await map()).nextChapter).toMatchObject({ state: 'needs_vocabulary', eligibleNewCount: CORE - 1 });
      expect((await issue(1, 1).expect(409)).body).toMatchObject({ code: 'CHALLENGE_NOT_ENOUGH_VOCABULARY', details: { eligibleNewCount: CORE - 1 } });
      await learn(1);
      expect(await map()).toMatchObject({ nextChapter: { chapterNo: 1, state: 'ready', eligibleNewCount: CORE }, currentNode: { chapterNo: 1, levelNo: 1 } });
      expect(await h.count(challengeChapters)).toBe(0);
    });

    it('counts a duplicate gloss once: 12 learned but 11 eligible', async () => {
      const list = words(CORE);
      list[5] = { ...list[5], meaningText: list[0].meaningText };
      const seeded = await h.seed('topic-a', list);
      await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
      await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
      await learn(CORE);
      expect((await map()).nextChapter).toMatchObject({ state: 'needs_vocabulary', eligibleNewCount: CORE - 1 });
    });

    it('plays levels 1→2→3 in one sitting, then waits for 12 more words', async () => {
      await onboard(40);
      await learn(CORE);
      await issue(1, 2).expect(403);

      const first = await clear(1, 1);
      expect(first).toMatchObject({ status: 'committed', result: { outcome: 'cleared', starsThisRun: 3 }, unlock: { kind: 'level', chapterNo: 1, levelNo: 2 }, nextAction: 'play_next_level' });
      await issue(2, 1).expect(403);
      expect(await clear(1, 2)).toMatchObject({ unlock: { kind: 'level', levelNo: 3 } });
      expect(await clear(1, 3)).toMatchObject({
        unlock: { kind: 'needs_vocabulary', chapterNo: 2, eligibleNewCount: 0, requiredNewCount: CORE }, nextAction: 'learn_more',
      });
      const m = await map();
      expect(m.chapters).toMatchObject([{ chapterNo: 1, state: 'completed', starsEarned: 9, maxStars: 9, explanationLocale: 'vi-VN' }]);
      expect(m.nextChapter).toMatchObject({ chapterNo: 2, state: 'needs_vocabulary' });
      await issue(2, 1).expect(409);

      await learn(CORE - 1);
      expect((await issue(2, 1).expect(409)).body.code).toBe('CHALLENGE_NOT_ENOUGH_VOCABULARY');
      await learn(1);
      expect((await map()).nextChapter.state).toBe('ready');
    });

    it('opens chapter after chapter without Daily when enough was learned, with up to 3 review words', async () => {
      await onboard(40);
      await learn(CORE * 2 + 1);
      await clear(1, 1);
      await clear(1, 2);
      expect(await clear(1, 3)).toMatchObject({ unlock: { kind: 'chapter_ready', chapterNo: 2 }, nextAction: 'play_next_level' });

      const l3: IssuedRun = (await issue(2, 1).expect(201)).body;
      await api('post', `/v1/challenge/runs/${l3.runId}/quit`).expect(200);
      const chapters = await h.db.select().from(challengeChapters).orderBy(challengeChapters.chapterNo);
      const slots = await h.db.select().from(challengeChapterMeanings);
      const byChapter = (id: string, role: string) => slots.filter((s) => s.chapterId === id && s.role === role);
      expect(byChapter(chapters[1].id, 'core')).toHaveLength(CORE);
      expect(byChapter(chapters[1].id, 'review')).toHaveLength(challenge.chapterReviewMeaningCount);
      const firstCore = new Set(byChapter(chapters[0].id, 'core').map((s) => s.meaningId));
      expect(byChapter(chapters[1].id, 'core').some((s) => firstCore.has(s.meaningId))).toBe(false);
      expect(byChapter(chapters[1].id, 'review').every((s) => firstCore.has(s.meaningId))).toBe(true);
      expect((await map()).chapters[1]).toMatchObject({ chapterNo: 2, state: 'active', coreMeaningCount: CORE, reviewMeaningCount: 3 });
    });

    it('keeps the chapter language frozen when the learner switches theirs', async () => {
      await onboard(20);
      await learn(CORE);
      await clear(1, 1);
      await api('put', '/v1/me/settings').send({ explanationLocale: 'en-US' }).expect(200);
      const run: IssuedRun = (await issue(1, 2).expect(201)).body;
      expect(run.explanationLocale).toBe('vi-VN');
      expect((await map()).chapters[0].explanationLocale).toBe('vi-VN');
    });
  });

  describe('runs', () => {
    beforeEach(async () => {
      await onboard(20);
      await learn(CORE);
    });

    it('issues a frozen plan of exactly goalMatches pairs, without Meaning ids', async () => {
      const res = await issue(1, 1).expect(201);
      const run = res.body;
      expect(run).toMatchObject({
        status: 'issued', gameMode: 'match_madness', chapterNo: 1, levelNo: 1, policyVersion: challenge.version, contentVersion: 1,
        explanationLocale: 'vi-VN', goalMatches: 8, visiblePairs: 3, timeLimitMs: 90_000,
        starCriteria: { two: { maxElapsedMs: 80_000, maxMistakes: 2 }, three: { maxElapsedMs: 60_000, maxMistakes: 0 } },
        score: challenge.score,
      });
      expect(run.pairs).toHaveLength(8);
      expect(new Set(run.pairs.map((p: { word: string }) => p.word)).size).toBe(8);
      expect(JSON.stringify(run)).not.toContain('meaningId');
      const stored = await h.first(challengeRuns, eq(challengeRuns.id, run.runId));
      expect(stored.plan!.pairs.map((p) => p.pairId)).toEqual(run.pairs.map((p: { pairId: string }) => p.pairId));
    });

    it('allows one open run; quit before start abandons it without an attempt', async () => {
      const { runId } = (await issue(1, 1).expect(201)).body;
      expect((await issue(1, 1).expect(409)).body).toMatchObject({ code: 'CHALLENGE_RUN_ACTIVE', details: { runId } });
      expect((await api('post', `/v1/challenge/runs/${runId}/quit`).expect(200)).body).toEqual({ runId, status: 'abandoned' });
      expect((await api('post', `/v1/challenge/runs/${runId}/quit`).expect(200)).body.status).toBe('abandoned');
      await start(runId).expect(410);
      await issue(1, 1).expect(201);
      expect(await h.count(challengeLevelProgress)).toBe(0);
    });

    it('starts once, and needs a start before commit', async () => {
      const run: IssuedRun = (await issue(1, 1).expect(201)).body;
      expect((await commit(run.runId, cleared(play(run))).expect(409)).body.code).toBe('CHALLENGE_RUN_NOT_STARTED');
      const first = (await start(run.runId).expect(200)).body;
      advanceMs(5_000);
      expect((await start(run.runId).expect(200)).body).toEqual(first);
      expect(first).toEqual({ runId: run.runId, status: 'started', startedAt: expect.any(String), timeLimitMs: 90_000 });
    });

    it('commit is idempotent; a different body conflicts; progress counts once', async () => {
      const run: IssuedRun = (await issue(1, 1).expect(201)).body;
      await start(run.runId).expect(200);
      const body = cleared(play(run, { wrongAt: [2] }));
      advanceMs(body.endedElapsedMs);
      const [a, b] = await Promise.all([commit(run.runId, body), commit(run.runId, body)]);
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(a.body.result).toMatchObject({ outcome: 'cleared', starsThisRun: 2, mistakes: 1, bestStars: 2, correctMatches: 8 });
      expect((await commit(run.runId, { events: [], endedReason: 'quit', endedElapsedMs: 0 }).expect(409)).body.code).toBe('CHALLENGE_COMMIT_CONFLICT');
      expect(await h.first(challengeLevelProgress)).toMatchObject({ levelNo: 1, bestStars: 2, attemptCount: 1, bestCompletionMs: body.endedElapsedMs });
      const status = (await api('get', `/v1/challenge/runs/${run.runId}/status`).expect(200)).body;
      expect(status).toMatchObject({ status: 'committed', response: a.body, run: null });
    });

    it('a failed run gives 0 stars and unlocks nothing; a worse replay never lowers the best', async () => {
      const run: IssuedRun = (await issue(1, 1).expect(201)).body;
      await start(run.runId).expect(200);
      advanceMs(90_000);
      const failed = (await commit(run.runId, { events: play(run, { stop: 3 }), endedReason: 'time_up', endedElapsedMs: 90_000 }).expect(200)).body;
      expect(failed).toMatchObject({ result: { outcome: 'failed', starsThisRun: 0, bestStars: 0 }, unlock: { kind: 'none' }, nextAction: 'retry' });
      await issue(1, 2).expect(403);

      expect((await clear(1, 1)).result).toMatchObject({ starsThisRun: 3, bestStars: 3 });
      const worse = await clear(1, 1, { wrongAt: [1, 2, 3, 4], stepMs: 6_000 });
      expect(worse).toMatchObject({ result: { starsThisRun: 1, bestStars: 3 }, unlock: { kind: 'none' }, nextAction: 'open_map' });
      expect(await h.first(challengeLevelProgress)).toMatchObject({ bestStars: 3, attemptCount: 3 });
      expect((await map()).chapters[0].levels[0]).toMatchObject({ state: 'cleared', bestStars: 3 });
    });

    it('quit after start settles a 0-star attempt', async () => {
      const { runId } = (await issue(1, 1).expect(201)).body;
      await start(runId).expect(200);
      const res = (await api('post', `/v1/challenge/runs/${runId}/quit`).expect(200)).body;
      expect(res).toMatchObject({ status: 'committed', response: { result: { outcome: 'quit', starsThisRun: 0 }, unlock: { kind: 'none' } } });
      expect((await api('post', `/v1/challenge/runs/${runId}/quit`).expect(200)).body.response).toEqual(res.response);
      expect(await h.first(challengeLevelProgress)).toMatchObject({ bestStars: 0, attemptCount: 1, firstClearedAt: null });
    });

    it('expires an unstarted run after 15 minutes and a started one 15 minutes after start', async () => {
      const issued: IssuedRun = (await issue(1, 1).expect(201)).body;
      advanceMs(challenge.issuedRunTtlMinutes * 60_000);
      await start(issued.runId).expect(410);
      expect((await api('get', `/v1/challenge/runs/${issued.runId}/status`).expect(200)).body.status).toBe('expired');

      const run: IssuedRun = (await issue(1, 1).expect(201)).body;
      expect((await h.first(challengeRuns, eq(challengeRuns.id, issued.runId))).status).toBe('expired');
      await start(run.runId).expect(200);
      advanceMs(challenge.startedRunCommitTtlMinutes * 60_000);
      expect((await commit(run.runId, cleared(play(run))).expect(410)).body.code).toBe('CHALLENGE_RUN_EXPIRED');
      expect(await h.count(challengeLevelProgress)).toBe(0);
    });

    it('rejects replays the board cannot produce, and elapsed time the server has not seen', async () => {
      const run: IssuedRun = (await issue(1, 1).expect(201)).body;
      await start(run.runId).expect(200);
      const events = play(run);
      const tooSoon = await commit(run.runId, cleared(events)).expect(422);
      expect(tooSoon.body.code).toBe('CHALLENGE_INVALID_EVENTS');
      advanceMs(60_000);
      const bad = events.map((e, i) => (i === 2 ? { ...e, wordTileId: run.pairs.at(-1)!.wordTileId } : e));
      await commit(run.runId, cleared(bad)).expect(422);
      await commit(run.runId, { ...cleared(events), endedReason: 'quit' }).expect(422);
      await commit(run.runId, { ...cleared(events), extra: 1 }).expect(422);
      await commit(run.runId, cleared(events)).expect(200);
    });

    it('hides runs of other learners', async () => {
      const other = await h.token('user-2');
      const { runId } = (await issue(1, 1).expect(201)).body;
      await api('get', `/v1/challenge/runs/${runId}/status`, other).expect(404);
      await start(runId, other).expect(404);
      expect((await commit(runId, { events: [], endedReason: 'quit', endedElapsedMs: 0 }, other).expect(404)).body.code).toBe('CHALLENGE_RUN_NOT_FOUND');
      await api('post', `/v1/challenge/runs/${runId}/quit`, other).expect(404);
      expect((await api('get', `/v1/challenge/runs/${runId}/status`).expect(200)).body.run.pairs).toHaveLength(8);
    });

    it('writes nothing to SRS, memory or skill evidence', async () => {
      const before = await h.db.select().from(userMeaningProgress);
      const [observations, evidence] = [await h.count(memoryObservations), await h.count(skillEvidence)];
      await clear(1, 1);
      const run: IssuedRun = (await issue(1, 2).expect(201)).body;
      await start(run.runId).expect(200);
      advanceMs(90_000);
      await commit(run.runId, { events: play(run, { stop: 2, wrongAt: [0] }), endedReason: 'time_up', endedElapsedMs: 90_000 }).expect(200);
      expect(await h.db.select().from(userMeaningProgress)).toEqual(before);
      expect([await h.count(memoryObservations), await h.count(skillEvidence)]).toEqual([observations, evidence]);
    });

    it('Daily keeps planning new words while a chapter is unfinished', async () => {
      await clear(1, 1);
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 2 }).expect(200);
      const plan = (await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
      expect(plan.steps.filter((s: { type: string }) => s.type === 'learn')).toHaveLength(2);
    });
  });

  describe('content lifecycle', () => {
    const recall = async (meaningId: string) =>
      api('post', `/admin/meanings/${meaningId}/recall?locale=vi-VN`, await h.token('admin-1', 'admin')).expect(200);
    const coreSlots = async () => h.db.select().from(challengeChapterMeanings).where(eq(challengeChapterMeanings.role, 'core'));

    it('refills a recalled slot with the next learned word and keeps the stars', async () => {
      await onboard(20);
      await learn(CORE + 1);
      await clear(1, 1);
      const [victim] = await coreSlots();
      await recall(victim.meaningId!);
      expect((await map()).chapters[0]).toMatchObject({ state: 'active', levels: [{ state: 'cleared', bestStars: 3 }, { state: 'available' }, { state: 'locked' }] });

      const run: IssuedRun = (await issue(1, 2).expect(201)).body;
      expect(run.contentVersion).toBe(2);
      expect(run.pairs.map((p) => p.word)).not.toContain(victim.lemma);
      const slots = await h.db.select().from(challengeChapterMeanings).where(eq(challengeChapterMeanings.sortIndex, victim.sortIndex));
      expect(slots.map((s) => [s.contentVersion, s.retiredInVersion])).toEqual([[1, 2], [2, null]]);
      expect((await h.first(challengeChapters)).contentVersion).toBe(2);
    });

    it('reports content_unavailable when no learned word can refill it', async () => {
      await onboard(20);
      await learn(CORE);
      await clear(1, 1);
      const [victim] = await coreSlots();
      await recall(victim.meaningId!);
      expect((await map()).chapters[0].state).toBe('content_unavailable');
      expect((await issue(1, 2).expect(409)).body.code).toBe('CHALLENGE_CONTENT_UNAVAILABLE');
      expect((await h.first(challengeLevelProgress)).bestStars).toBe(3);

      await learn(1);
      expect((await map()).chapters[0].state).toBe('active');
      await issue(1, 2).expect(201);
    });
  });

  it('maintenance expires live runs and later purges plans and events', async () => {
    await onboard(20);
    await learn(CORE);
    const stale = (await issue(1, 1).expect(201)).body.runId;
    advanceMs(challenge.issuedRunTtlMinutes * 60_000);
    const service = h.app.get(MaintenanceService);
    await service.cleanup();
    expect((await h.first(challengeRuns, eq(challengeRuns.id, stale))).status).toBe('expired');

    await clear(1, 1);
    h.clock.advance(challenge.eventsRetentionDays * 24 + 1);
    await service.cleanup();
    const runs = await h.db.select().from(challengeRuns);
    expect(runs.every((r) => r.plan === null && r.events === null)).toBe(true);
    expect(runs.find((r) => r.status === 'committed')!.result).toMatchObject({ outcome: 'cleared' });
  });

  it('account deletion removes every challenge row', async () => {
    await onboard(20);
    await learn(CORE);
    await clear(1, 1);
    await issue(1, 2).expect(201);
    const [user] = await h.db.select({ id: appUsers.id }).from(appUsers);
    await api('delete', '/v1/me').expect(200);
    for (const table of [challengeChapters, challengeChapterMeanings, challengeLevelProgress]) {
      expect(await h.count(table, and(eq(table.userId, user.id)))).toBe(0);
    }
    expect(await h.count(challengeRuns)).toBe(0);
  });

  it('map, issue, start and commit stay constant from 12 to 60 learned Meanings', async () => {
    const measure = async (learned: number) => {
      await h.reset();
      auth = await h.token('user-1');
      await onboard(learned + 2);
      await learn(learned);
      const m = await h.countQueries(() => api('get', '/v1/me/challenge-map').expect(200));
      const issued = await h.countQueries(() => issue(1, 1).expect(201));
      const run = issued.result.body as IssuedRun;
      const started = await h.countQueries(() => start(run.runId).expect(200));
      const body = cleared(play(run));
      advanceMs(body.endedElapsedMs);
      const committed = await h.countQueries(() => commit(run.runId, body).expect(200));
      return { map: m.queries, issue: issued.queries, start: started.queries, commit: committed.queries };
    };
    const small = await measure(CORE);
    const large = await measure(60);
    expect(large).toEqual(small);
  });
});
