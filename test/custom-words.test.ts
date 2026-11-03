import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { CUSTOM_MEANING_STATUS, CUSTOM_WORD_LOOKUP_RESULT, MEANING_ORIGIN, PERSONAL_COLLECTION_SLUG } from '../src/common/constants/domain';
import { ApiError } from '../src/common/http/api-error';
import { POLICY } from '../src/config/policy';
import {
  customWordUsage, lexicalDrafts, meaningExamples, meaningLocalizations, meaningPublications, meanings, pronunciations, userActiveTopics, userMeaningOverrides, words, wordTypes,
} from '../src/db/schema';
import { PlannerRepository } from '../src/modules/session-planner/planner.repository';
import { answers, tasksOf } from './support/driver';
import { CAPS, createHarness, Harness, seedWord } from './support/app';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const curated = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));
const VI = 'vi-VN';
const EN = 'en-US';

describe('custom words', () => {
  let h: Harness;
  let auth: string;
  let other: string;

  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, token = auth) =>
    h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const lookup = async (text: string, token = auth, context?: string): Promise<Json> =>
    (await api('post', '/v1/custom-words/lookup', token).send({ text, context }).expect(200)).body;
  const add = (body: object, token = auth) => api('post', '/v1/custom-words', token).send(body);
  const addWord = async (text: string, token = auth): Promise<Json> => {
    const { draftId } = await lookup(text, token);
    return (await add({ draftId }, token).expect(201)).body;
  };
  const list = async (token = auth): Promise<Json[]> => (await api('get', '/v1/custom-words', token).expect(200)).body.words;
  const plan = async (mode = 'daily', token = auth) => (await api('post', '/v1/sessions/plan', token).send({ mode, capabilities: CAPS }).expect(200)).body;
  const setLocale = (explanationLocale: string, token = auth) => api('put', '/v1/me/settings', token).send({ explanationLocale }).expect(200);

  async function onboard(token = auth, from = 0) {
    const seeded = await h.seed(`topic-${from}`, curated(6, from));
    await api('put', '/v1/me/levels', token).send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope', token).send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    return seeded;
  }

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    auth = await h.token('user-1');
    other = await h.token('user-2');
    await api('get', '/v1/me').expect(200);
    await api('get', '/v1/me', other).expect(200);
  });

  describe('lookup finds the word before generating', () => {
    it('matches an existing word across case and spacing without calling AI', async () => {
      const seeded = await onboard();
      const lemma = seedWord(0).lemma;
      const body = await lookup(`  ${lemma.toUpperCase()}  `);
      expect(body).toMatchObject({ result: CUSTOM_WORD_LOOKUP_RESULT.EXISTING, wordId: seeded.wordIds[0], lemma });
      expect(body.meanings[0]).toMatchObject({ status: CUSTOM_MEANING_STATUS.AVAILABLE, meaningId: seeded.meaningIds[0], meaningText: seedWord(0).meaningText, ipa: seedWord(0).ipa, learned: false });
      expect(body.meanings[0].examples).toEqual([expect.objectContaining({ text: seedWord(0).example, targetLocator: expect.any(Object) })]);
      expect(h.lexical.generated).toEqual([]);
    });

    it('attaches an existing meaning to the roadmap and does not add a word', async () => {
      const seeded = await onboard();
      const before = await h.count(words);
      await add({ meaningId: seeded.meaningIds[1] }).expect(201);
      expect(await h.count(words)).toBe(before);
      expect((await list()).map((w) => w.meaningId)).toEqual([seeded.meaningIds[1]]);
      expect((await lookup(seedWord(1).lemma)).meanings[0].inRoadmap).toBe(true);
    });

    it('generates a word missing from the database, once for everyone', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      const seen = await lookup('Serendipity', other);
      expect(seen.result).toBe(CUSTOM_WORD_LOOKUP_RESULT.EXISTING);
      expect(seen.meanings.map((m: Json) => m.meaningId)).toEqual([meaningId]);
      expect(h.lexical.generated).toHaveLength(1);
      expect(await h.first(meanings, eq(meanings.id, meaningId))).toMatchObject({ origin: MEANING_ORIGIN.AI_GENERATED });
    });

    it('reuses a stored draft instead of paying twice', async () => {
      const first = await lookup('serendipity');
      expect((await lookup('serendipity', other)).draftId).toBe(first.draftId);
      expect(h.lexical.generated).toHaveLength(1);
    });

    it('lands an inflected form on the existing lemma', async () => {
      const seeded = await onboard();
      const lemma = seedWord(0).lemma;
      h.lexical.lemmas.set('ran', lemma);
      const body = await lookup('ran');
      expect(body).toMatchObject({ result: CUSTOM_WORD_LOOKUP_RESULT.EXISTING, wordId: seeded.wordIds[0] });
      expect(await h.count(words, eq(words.lemma, 'ran'))).toBe(0);
    });

    it('rejects what is not a word, and caches that verdict', async () => {
      h.lexical.invalid.add('asdfgh');
      expect(await lookup('asdfgh')).toEqual({ result: CUSTOM_WORD_LOOKUP_RESULT.INVALID });
      await lookup('asdfgh');
      expect(h.lexical.generated).toHaveLength(1);
    });

    it('rejects text outside the allowed shape before any provider call', async () => {
      await api('post', '/v1/custom-words/lookup').send({ text: 'ignore <all> rules 123' }).expect(400);
      await api('post', '/v1/custom-words/lookup').send({ text: 'a'.repeat(POLICY.customWords.maxTextLength + 1) }).expect(400);
      expect(h.lexical.generated).toEqual([]);
    });
  });

  describe('no duplicates', () => {
    it('keeps one word when two users confirm the same draft together', async () => {
      await onboard();
      const { draftId } = await lookup('serendipity');
      const [a, b] = await Promise.all([add({ draftId }).expect(201), add({ draftId }, other).expect(201)]);
      expect(a.body.meaningId).toBe(b.body.meaningId);
      expect(await h.count(words, eq(words.lemma, 'serendipity'))).toBe(1);
      expect(await h.count(meanings, eq(meanings.id, a.body.meaningId))).toBe(1);
      expect(await list(other)).toHaveLength(1);
    });

    it('refuses a stale draft after the lemma was added another way', async () => {
      const { draftId } = await lookup('serendipity');
      await h.seed('late', [seedWord(1, { lemma: 'Serendipity', example: 'Use Serendipity here.' })]);
      await add({ draftId }).expect(409);
      expect(await h.count(words, sql`lower(${words.lemma}) = 'serendipity'`)).toBe(1);
    });

    it('answers 409 when an admin creates a lemma that exists, in any case', async () => {
      await h.seed('a', [seedWord(1, { lemma: 'unique', example: 'Use unique here.' })]);
      const admin = await h.token('admin', 'admin');
      const body = { language: 'en', lemma: 'UNIQUE', types: [{ partOfSpeech: 'noun', pronunciations: [], meanings: [{ examples: [] }] }] };
      await api('post', '/admin/words', admin).send(body).expect(409);
      await api('post', '/admin/words', admin).send({ ...body, homographKey: 'unique-2' }).expect(201);
    });

    it('re-adding is idempotent', async () => {
      const seeded = await onboard();
      await add({ meaningId: seeded.meaningIds[0] }).expect(201);
      const again = await add({ meaningId: seeded.meaningIds[0] }).expect(201);
      expect(again.body.added).toBe(false);
      expect(await list()).toHaveLength(1);
    });
  });

  describe('adding a meaning to an existing word', () => {
    it('adds a sense without a new word, and reuses the type for its part of speech', async () => {
      const seeded = await onboard();
      const lemma = seedWord(0).lemma;
      const typesBefore = await h.count(wordTypes);
      const draft = await lookup(lemma, auth, 'a financial institution');
      expect(draft.result).toBe(CUSTOM_WORD_LOOKUP_RESULT.NEW_MEANING_DRAFT);
      expect(h.lexical.generated[0].existingMeanings).toEqual([seedWord(0).meaningText]);

      const { body } = await add({ draftId: draft.draftId }).expect(201);
      expect(await h.count(words, eq(words.lemma, lemma))).toBe(1);
      expect(await h.count(wordTypes)).toBe(typesBefore);
      const seen = await lookup(lemma);
      expect(seen.meanings.map((m: Json) => m.meaningId).sort()).toEqual([seeded.meaningIds[0], body.meaningId].sort());
    });

    describe('a meaning from context stays private to its author', () => {
      const context = 'a financial institution';
      const lemma = seedWord(0).lemma;
      const addPrivate = async () => {
        const { draftId } = await lookup(lemma, auth, context);
        return { draftId, meaningId: (await add({ draftId }).expect(201)).body.meaningId as string };
      };

      it('is stored as owned, and the author learns it', async () => {
        await onboard();
        const { meaningId } = await addPrivate();
        expect(await h.first(meanings, eq(meanings.id, meaningId))).toMatchObject({ ownerUserId: expect.any(String) });
        expect((await list()).map((w) => w.meaningId)).toEqual([meaningId]);
        await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 1 }).expect(200);
        expect(JSON.stringify(await plan())).toContain(context);
      });

      it('is invisible in lookup and word detail for other users', async () => {
        const seeded = await onboard();
        const { meaningId } = await addPrivate();
        expect((await lookup(lemma)).meanings.map((m: Json) => m.meaningId)).toContain(meaningId);
        expect((await lookup(lemma, other)).meanings.map((m: Json) => m.meaningId)).toEqual([seeded.meaningIds[0]]);
        expect(JSON.stringify((await api('get', `/v1/words/${seeded.wordIds[0]}`).expect(200)).body)).toContain(context);
        expect(JSON.stringify((await api('get', `/v1/words/${seeded.wordIds[0]}`, other).expect(200)).body)).not.toContain(context);
      });

      it('cannot be taken by id or by draft', async () => {
        await onboard();
        const { draftId, meaningId } = await addPrivate();
        await add({ meaningId }, other).expect(422);
        await add({ draftId }, other).expect(422);
        await api('put', `/v1/custom-words/${meaningId}/override`, other).send({ meaningText: 'x' }).expect(404);
        expect(await list(other)).toEqual([]);
      });

      it('does not share the AI result across users, even for the same context', async () => {
        await onboard();
        const mine = await addPrivate();
        const theirs = await lookup(lemma, other, context);
        expect(theirs.draftId).not.toBe(mine.draftId);
        expect(h.lexical.generated).toHaveLength(2);
        expect(h.lexical.generated[1].existingMeanings).toEqual([seedWord(0).meaningText]);
      });

      it('keeps its translation draft private too', async () => {
        await onboard();
        await setLocale(EN, other);
        await addPrivate();
        await setLocale(EN);
        const pending = (await lookup(lemma)).meanings.filter((m: Json) => m.status === CUSTOM_MEANING_STATUS.TRANSLATION_DRAFT);
        const draftIds = pending.map((m: Json) => m.draftId);
        expect(draftIds).toHaveLength(2);
        const mine = await h.first(lexicalDrafts, and(isNotNull(lexicalDrafts.ownerUserId), eq(lexicalDrafts.kind, 'translation')));
        await add({ draftId: mine.id }, other).expect(422);
      });

      it('reaches everyone after admin approval, so nobody generates it again', async () => {
        await onboard();
        const { meaningId } = await addPrivate();
        const admin = await h.token('admin', 'admin');
        const { body } = await api('get', '/admin/ai-meanings?scope=private', admin).expect(200);
        expect(body.meanings).toEqual([expect.objectContaining({ meaningId, isPrivate: true, ipa: expect.any(String) })]);

        await api('post', `/admin/ai-meanings/${meaningId}/approve`, admin).expect(200);
        const calls = h.lexical.generated.length;
        const seen = (await lookup(lemma, other)).meanings.find((m: Json) => m.meaningId === meaningId);
        expect(seen).toMatchObject({ status: CUSTOM_MEANING_STATUS.AVAILABLE });
        await add({ meaningId }, other).expect(201);
        expect(h.lexical.generated).toHaveLength(calls);
        expect(await h.first(meanings, eq(meanings.id, meaningId))).toMatchObject({ ownerUserId: null, origin: MEANING_ORIGIN.CURATED, reviewedAt: expect.any(Date) });

        const pool = await h.app.get(PlannerRepository).distractorPool(VI, POLICY.session.distractorPoolSize);
        expect(JSON.stringify(pool)).toContain(context);
        expect((await api('get', '/admin/ai-meanings', admin).expect(200)).body.meanings).toEqual([]);
      });

      it('lets other languages use it after approval', async () => {
        await onboard();
        await setLocale(EN);
        const { draftId } = await lookup(lemma, auth, context);
        const { meaningId } = (await add({ draftId }).expect(201)).body;
        await setLocale(VI);
        const preview = (await lookup(lemma)).meanings.find((m: Json) => m.meaningId === meaningId);
        await api('post', `/admin/ai-meanings/${meaningId}/approve`, await h.token('admin', 'admin')).expect(200);
        await add({ draftId: preview.draftId }, other).expect(201);
      });

      it('keeps the author\'s edit private through approval and away from the reviewer', async () => {
        await onboard();
        const { meaningId } = await addPrivate();
        await api('put', `/v1/custom-words/${meaningId}/override`).send({ meaningText: 'bản riêng' }).expect(200);
        const admin = await h.token('admin', 'admin');
        expect(JSON.stringify((await api('get', '/admin/ai-meanings', admin).expect(200)).body)).not.toContain('bản riêng');

        await api('post', `/admin/ai-meanings/${meaningId}/approve`, admin).expect(200);
        await add({ meaningId }, other).expect(201);
        expect((await list())[0]).toMatchObject({ meaningText: 'bản riêng', overridden: true });
        expect(JSON.stringify(await list(other))).not.toContain('bản riêng');
        expect(JSON.stringify(await h.first(meaningPublications, eq(meaningPublications.meaningId, meaningId)))).not.toContain('bản riêng');
      });

      it('never enters distractors for others', async () => {
        await onboard();
        await addPrivate();
        const pool = await h.app.get(PlannerRepository).distractorPool(VI, POLICY.session.distractorPoolSize);
        expect(JSON.stringify(pool)).not.toContain(context);
      });

      it('leaves the shared meaning limit to other users', async () => {
        await onboard();
        const policy = POLICY.customWords as { maxMeaningsPerWord: number };
        const limit = policy.maxMeaningsPerWord;
        policy.maxMeaningsPerWord = 2;
        try {
          await addPrivate();
          await api('post', '/v1/custom-words/lookup').send({ text: lemma, context: 'one more' }).expect(429);
          await add({ draftId: (await lookup(lemma, other, 'theirs')).draftId }, other).expect(201);
        } finally {
          policy.maxMeaningsPerWord = limit;
        }
      });

      it('does not hand its pronunciation to shared content', async () => {
        const { draftId } = await lookup('serendipity');
        const noun = (await add({ draftId, senseIndex: 0 }).expect(201)).body;
        h.lexical.ipa = '/from-context/';
        const custom = await lookup('serendipity', other, 'a private verb sense');
        await add({ draftId: custom.draftId }, other).expect(201);
        h.lexical.ipa = undefined;

        const verb = (await add({ draftId, senseIndex: 1 }).expect(201)).body;
        const snapshot = (await h.first(meaningPublications, eq(meaningPublications.meaningId, verb.meaningId))).snapshot;
        expect(JSON.stringify(snapshot)).not.toContain('from-context');
        expect(noun.meaningId).not.toBe(verb.meaningId);
      });
    });

    it('points to the existing meaning when AI says it is the same sense, even from cache', async () => {
      const seeded = await onboard();
      h.lexical.duplicateOf = 0;
      const lemma = seedWord(0).lemma;
      const body = await lookup(lemma, auth, 'same sense');
      expect(body.result).toBe(CUSTOM_WORD_LOOKUP_RESULT.EXISTING);
      expect(body.meanings.map((m: Json) => m.meaningId)).toEqual([seeded.meaningIds[0]]);

      h.lexical.duplicateOf = null;
      const { draftId } = await lookup(lemma, auth, 'a new sense');
      await add({ draftId }).expect(201);
      const cached = await lookup(lemma, auth, 'same sense');
      expect(cached.meanings.map((m: Json) => m.meaningId)).toEqual([seeded.meaningIds[0]]);
      expect(h.lexical.generated).toHaveLength(2);
    });
  });

  describe('learning', () => {
    it('schedules an added word first, through session, commit and review', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 1 }).expect(200);
      const first = await plan();
      expect(JSON.stringify(first)).toContain('serendipity');
      await api('post', `/v1/sessions/${first.sessionId}/commit`).send(answers(first)).expect(200);
      expect((await lookup('serendipity')).meanings[0]).toMatchObject({ inRoadmap: true, learned: true });
      h.clock.advance(24 * 3);
      const review = await plan();
      expect(JSON.stringify(review)).toContain('serendipity');
      expect((await list()).map((w) => w.meaningId)).toEqual([meaningId]);
    });

    it('keeps the roadmap when the catalog scope changes', async () => {
      const seeded = await onboard();
      await addWord('serendipity');
      await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
      expect(await h.count(userActiveTopics)).toBe(2);
      expect((await api('get', '/v1/me').expect(200)).body.scope.topicIds).toEqual([seeded.topicId]);
    });

    it('stops scheduling a removed word but keeps the shared content', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await api('delete', `/v1/custom-words/${meaningId}`).expect(200);
      expect(await list()).toEqual([]);
      expect(JSON.stringify(await plan())).not.toContain('serendipity');
      expect((await lookup('serendipity', other)).meanings[0].status).toBe(CUSTOM_MEANING_STATUS.AVAILABLE);
      await api('delete', `/v1/custom-words/${meaningId}`).expect(404);
    });
  });

  describe('pool isolation', () => {
    it('keeps AI meanings out of the catalog and of distractors', async () => {
      await onboard();
      await onboard(other, 10);
      await addWord('serendipity');
      const catalog = (await api('get', '/v1/catalog/collections').expect(200)).body;
      expect(catalog.collections.map((c: Json) => c.slug)).not.toContain(PERSONAL_COLLECTION_SLUG);
      await api('put', '/v1/me/settings', other).send({ dailyNewWordGoal: 6 }).expect(200);
      const plans = [await plan('daily', other), await plan('daily', other), await plan('daily', other)];
      expect(JSON.stringify(plans)).not.toContain('serendipity');
      const pool = await h.app.get(PlannerRepository).distractorPool(VI, POLICY.session.distractorPoolSize);
      expect(pool.length).toBeGreaterThan(0);
      expect(pool.map((d) => d.lemma)).not.toContain('serendipity');
    });

    it('keeps AI translations of curated meanings out of distractors', async () => {
      await onboard();
      await setLocale(EN, other);
      const preview = await lookup(seedWord(0).lemma, other);
      await add({ draftId: preview.meanings[0].draftId }, other).expect(201);
      await expect(h.app.get(PlannerRepository).distractorPool(EN, POLICY.session.distractorPoolSize)).resolves.toEqual([]);
    });

    it('never takes pool content from the request', async () => {
      const { draftId } = await lookup('serendipity');
      await add({ draftId, meaningText: 'forged' }).expect(400);
      await add({ draftId, senses: [{ meaningText: 'forged' }] }).expect(400);
      await add({ draftId: '01a18d69-b8c8-7699-b121-735a85b63537' }).expect(422);
    });

    it('rejects a draft from another language setting', async () => {
      const { draftId } = await lookup('serendipity');
      await setLocale(EN, other);
      await add({ draftId }, other).expect(422);
    });
  });

  describe('private edits', () => {
    const edits = { meaningText: 'bản riêng của tôi' };

    it('shows the edit to its author only and leaves publications untouched', async () => {
      await onboard();
      await onboard(other, 10);
      const { draftId } = await lookup('serendipity');
      const { meaningId } = (await add({ draftId, edits }).expect(201)).body;
      await add({ meaningId }, other).expect(201);
      const published = await h.first(meaningPublications, eq(meaningPublications.meaningId, meaningId));
      expect(JSON.stringify(published.snapshot)).not.toContain(edits.meaningText);
      expect(await h.count(meaningPublications, eq(meaningPublications.meaningId, meaningId))).toBe(1);

      expect(JSON.stringify(await plan())).toContain(edits.meaningText);
      expect(JSON.stringify(await plan('daily', other))).not.toContain(edits.meaningText);
      expect((await list())[0]).toMatchObject({ meaningText: edits.meaningText, overridden: true });
      expect((await list(other))[0]).toMatchObject({ overridden: false });
    });

    it('never changes shared content, whichever way the edit arrives', async () => {
      await onboard();
      const shared = async () => (await h.db.execute(sql`
        SELECT
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM words t) AS words,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM pronunciations t) AS pronunciations,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM meanings t) AS meanings,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.meaning_id, t.locale) FROM meaning_localizations t) AS localizations,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM meaning_examples t) AS examples,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.example_id, t.locale) FROM example_localizations t) AS example_localizations,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM meaning_publications t) AS publications,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM lexical_drafts t) AS drafts`)).rows[0];

      const { meaningId } = await addWord('serendipity');
      const before = await shared();
      const example = { text: 'My own line.', translation: 'Câu của tôi.', targetLocator: { start: 3, end: 6 } };
      await api('put', `/v1/custom-words/${meaningId}/override`).send({ ...edits, definitionText: 'của tôi', examples: [example] }).expect(200);
      await add({ meaningId, edits }).expect(201);
      expect(await shared()).toEqual(before);

      const { draftId } = await lookup('epiphany');
      const original = (await lookup('epiphany')).senses[0];
      const created = (await add({ draftId, edits }).expect(201)).body;
      const row = await h.first(meaningLocalizations, eq(meaningLocalizations.meaningId, created.meaningId));
      expect(row.meaningText).toBe(original.meaningText);
    });

    it('keeps an edited example when a later edit changes only the gloss', async () => {
      await onboard();
      const example = { text: 'My own line.', translation: 'Câu của tôi.', targetLocator: { start: 3, end: 6 } };
      const { draftId } = await lookup('serendipity');
      const { meaningId } = (await add({ draftId, edits: { examples: [example] } }).expect(201)).body;
      await api('put', `/v1/custom-words/${meaningId}/override`).send(edits).expect(200);
      expect((await list())[0]).toMatchObject({ meaningText: edits.meaningText, examples: [example] });
    });

    it('lists shared examples until the user edits them, and hides them once recalled', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      expect((await list())[0].examples).toEqual([expect.objectContaining({ text: 'Use serendipity here.', targetLocator: { start: 4, end: 15 } })]);
      await api('post', `/admin/meanings/${meaningId}/recall?locale=${VI}`, await h.token('admin', 'admin')).expect(200);
      expect((await list())[0].examples).toBeNull();
    });

    it('accepts an inflected form when the client picks the highlight', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      const examples = [{ text: 'She ran home.', translation: 'Cô ấy chạy về.', targetLocator: { start: 4, end: 7 } }];
      await api('put', `/v1/custom-words/${meaningId}/override`).send({ examples }).expect(200);
      expect((await list())[0].examples).toEqual(examples);
    });

    it('never sends an edit to AI as the source of a translation', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await api('put', `/v1/custom-words/${meaningId}/override`).send(edits).expect(200);
      await setLocale(EN);
      await h.customWords.translateNextPending();
      expect(JSON.stringify(h.lexical.translated)).not.toContain(edits.meaningText);
    });

    it('applies the edit to progress views, and can be cleared', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await api('put', `/v1/custom-words/${meaningId}/override`).send(edits).expect(200);
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 1 }).expect(200);
      const p = await plan();
      await api('post', `/v1/sessions/${p.sessionId}/commit`).send(answers(p)).expect(200);
      expect(JSON.stringify((await api('get', '/v1/me/words').expect(200)).body)).toContain(edits.meaningText);

      await api('delete', `/v1/custom-words/${meaningId}/override`).expect(200);
      expect(JSON.stringify((await api('get', '/v1/me/words').expect(200)).body)).not.toContain(edits.meaningText);
    });

    it('returns the definition and examples on progress views', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      const definitionText = 'định nghĩa riêng của tôi';
      await api('put', `/v1/custom-words/${meaningId}/override`).send({ definitionText }).expect(200);
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 1 }).expect(200);
      const p = await plan();
      await api('post', `/v1/sessions/${p.sessionId}/commit`).send(answers(p)).expect(200);
      const { words } = (await api('get', '/v1/me/words').expect(200)).body;
      const { meaning } = words[0].meanings[0];
      expect(meaning.definition).toBe(definitionText);
      expect(meaning.examples[0]).toEqual({ text: expect.any(String), translation: expect.any(String) });
    });

    it('rejects edits outside the roadmap, empty edits and invalid highlights', async () => {
      const seeded = await onboard();
      const { meaningId } = await addWord('serendipity');
      await api('put', `/v1/custom-words/${seeded.meaningIds[0]}/override`).send(edits).expect(404);
      await api('put', `/v1/custom-words/${meaningId}/override`).send({}).expect(400);
      await api('put', `/v1/custom-words/${meaningId}/override`)
        .send({ examples: [{ text: 'short', translation: 'x', targetLocator: { start: 2, end: 90 } }] }).expect(400);
      await api('put', `/v1/custom-words/${meaningId}/override`).send({ lemma: 'other' }).expect(400);
      expect(await h.count(userMeaningOverrides)).toBe(0);
    });

    it('still grades on the shared lemma when the gloss was edited', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await api('put', `/v1/custom-words/${meaningId}/override`).send(edits).expect(200);
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 1 }).expect(200);
      const p = await plan();
      expect(tasksOf(p).length).toBeGreaterThan(0);
      await api('post', `/v1/sessions/${p.sessionId}/commit`).send(answers(p)).expect(200);
    });
  });

  describe('translation by user language', () => {
    it('generates in the language of the user', async () => {
      await setLocale(EN);
      await lookup('serendipity');
      expect(h.lexical.generated[0].locale).toBe(EN);
    });

    it('translates an existing word once per locale, then publishes it for everyone', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await setLocale(EN, other);
      const preview = await lookup('serendipity', other);
      expect(preview.meanings[0]).toMatchObject({ status: CUSTOM_MEANING_STATUS.TRANSLATION_DRAFT, meaningText: `${EN} gloss of serendipity`, ipa: '/serendipity/' });
      expect(preview.meanings[0].examples).toEqual([{ text: 'Use serendipity here.', translation: `${EN} sentence`, targetLocator: { start: 4, end: 15 } }]);
      expect(h.lexical.generated).toHaveLength(1);
      expect(h.lexical.translated).toHaveLength(1);

      await add({ draftId: preview.meanings[0].draftId }, other).expect(201);
      expect(await h.first(meaningLocalizations, and(eq(meaningLocalizations.meaningId, meaningId), eq(meaningLocalizations.locale, EN))))
        .toMatchObject({ origin: MEANING_ORIGIN.AI_GENERATED });

      const third = await h.token('user-3');
      await api('get', '/v1/me', third).expect(200);
      await setLocale(EN, third);
      expect((await lookup('serendipity', third)).meanings[0].status).toBe(CUSTOM_MEANING_STATUS.AVAILABLE);
      expect(h.lexical.translated).toHaveLength(1);
    });

    it('covers curated meanings that lack the locale', async () => {
      const seeded = await onboard();
      await setLocale(EN, other);
      const preview = await lookup(seedWord(0).lemma, other);
      const { body } = await add({ draftId: preview.meanings[0].draftId }, other).expect(201);
      expect(body.meaningId).toBe(seeded.meaningIds[0]);
      expect(await h.count(meaningPublications, eq(meaningPublications.meaningId, body.meaningId))).toBe(2);
    });

    it('backfills the roadmap after a locale change, outside the request', async () => {
      await onboard();
      await addWord('serendipity');
      await setLocale(EN);
      expect(h.lexical.translated).toEqual([]);
      expect((await list())[0]).toMatchObject({ translationPending: true });

      await expect(h.customWords.translateNextPending()).resolves.toBe(true);
      expect((await list())[0]).toMatchObject({ translationPending: false, meaningText: `${EN} gloss of serendipity` });
      await expect(h.customWords.translateNextPending()).resolves.toBe(false);
    });

    it('marks an AI translation as curated once an admin replaces it', async () => {
      const { meaningId } = await addWord('serendipity');
      await setLocale(EN, other);
      const preview = await lookup('serendipity', other);
      await add({ draftId: preview.meanings[0].draftId }, other).expect(201);
      const example = await h.first(meaningExamples, eq(meaningExamples.meaningId, meaningId));
      await api('put', `/admin/meanings/${meaningId}/locales/${EN}`, await h.token('admin', 'admin')).send({
        meaningText: 'reviewed', definitionText: 'reviewed', editorialState: 'approved',
        exampleTranslations: [{ exampleId: example.id, translationText: 'reviewed' }],
      }).expect(200);
      expect(await h.first(meaningLocalizations, and(eq(meaningLocalizations.meaningId, meaningId), eq(meaningLocalizations.locale, EN))))
        .toMatchObject({ origin: MEANING_ORIGIN.CURATED, meaningText: 'reviewed' });
    });

    it('leaves a locale an editor is working on alone', async () => {
      const seeded = await onboard();
      await h.db.insert(meaningLocalizations).values({ meaningId: seeded.meaningIds[0], locale: EN, meaningText: 'draft', definitionText: 'draft' });
      await setLocale(EN, other);
      expect((await lookup(seedWord(0).lemma, other)).meanings[0].status).toBe(CUSTOM_MEANING_STATUS.UNAVAILABLE);
      expect(h.lexical.translated).toEqual([]);
    });
  });

  describe('moderation', () => {
    const recall = async (meaningId: string) => {
      const admin = await h.token('admin', 'admin');
      await api('post', `/admin/meanings/${meaningId}/recall?locale=${VI}`, admin).expect(200);
    };

    it('lists AI meanings for admins only', async () => {
      await addWord('serendipity');
      await api('get', '/admin/ai-meanings').expect(403);
      const { body } = await api('get', '/admin/ai-meanings', await h.token('admin', 'admin')).expect(200);
      expect(body.meanings).toEqual([expect.objectContaining({ lemma: 'serendipity', liveLocales: [VI], isPrivate: false })]);
    });

    it('approves a shared AI meaning, and an AI translation of a curated one', async () => {
      const seeded = await onboard();
      const admin = await h.token('admin', 'admin');
      const { meaningId } = await addWord('serendipity');
      await setLocale(EN, other);
      const preview = await lookup(seedWord(0).lemma, other);
      await add({ draftId: preview.meanings[0].draftId }, other).expect(201);

      await api('post', `/admin/ai-meanings/${meaningId}/approve`).expect(403);
      await api('post', `/admin/ai-meanings/${meaningId}/approve`, admin).expect(200);
      await api('post', `/admin/ai-meanings/${seeded.meaningIds[0]}/approve`, admin).expect(200);
      expect((await api('get', '/admin/ai-meanings', admin).expect(200)).body.meanings).toEqual([]);
      expect(await h.count(meaningLocalizations, eq(meaningLocalizations.origin, MEANING_ORIGIN.AI_GENERATED))).toBe(0);
      await api('post', `/admin/ai-meanings/${meaningId}/approve`, admin).expect(404);
    });

    it('does not approve a recalled meaning', async () => {
      const { meaningId } = await addWord('serendipity');
      await recall(meaningId);
      await api('post', `/admin/ai-meanings/${meaningId}/approve`, await h.token('admin', 'admin')).expect(404);
    });

    it('does not regenerate, translate or re-add a recalled meaning', async () => {
      await onboard();
      const { meaningId } = await addWord('serendipity');
      await recall(meaningId);
      expect((await list())[0]).toMatchObject({ recalled: true, meaningText: null, ipa: null, audioUrl: null });

      expect((await lookup('serendipity', other)).meanings[0].status).toBe(CUSTOM_MEANING_STATUS.UNAVAILABLE);
      await add({ meaningId }, other).expect(422);
      expect(h.lexical.generated).toHaveLength(1);

      await setLocale(EN, other);
      expect((await lookup('serendipity', other)).meanings[0].status).toBe(CUSTOM_MEANING_STATUS.UNAVAILABLE);
      await setLocale(EN);
      await expect(h.customWords.translateNextPending()).resolves.toBe(false);
      expect(h.lexical.translated).toEqual([]);
    });
  });

  describe('limits', () => {
    it('stops at the daily lookup limit, but cached and existing words stay free', async () => {
      await onboard();
      await lookup('cached');
      const { id } = (await api('get', '/v1/me').expect(200)).body;
      await h.db.update(customWordUsage).set({ lookups: POLICY.customWords.dailyLookups }).where(eq(customWordUsage.userId, id));

      await api('post', '/v1/custom-words/lookup').send({ text: 'fresh' }).expect(429);
      await lookup('cached');
      await lookup(seedWord(0).lemma);
      h.clock.advance(24);
      await lookup('fresh');
    });

    it('stops at the roadmap limit', async () => {
      const seeded = await onboard();
      await add({ meaningId: seeded.meaningIds[0] }).expect(201);
      const { rows: [topic] } = await h.db.execute<{ id: string }>(sql`SELECT id FROM topics WHERE owner_user_id IS NOT NULL`);
      await h.db.execute(sql`
        INSERT INTO topic_meanings (topic_id, meaning_id, curated_rank)
        SELECT ${topic.id}::uuid, m.id, row_number() OVER () + 1 FROM meanings m WHERE m.id <> ${seeded.meaningIds[0]}::uuid`);
      const policy = POLICY.customWords as { maxRoadmapWords: number };
      const limit = policy.maxRoadmapWords;
      policy.maxRoadmapWords = 3;
      try {
        await add({ draftId: (await lookup('serendipity')).draftId }).expect(429);
      } finally {
        policy.maxRoadmapWords = limit;
      }
    });

    it('reports a provider outage as retryable', async () => {
      h.lexical.error = new ApiError('LEXICAL_PROVIDER_UNAVAILABLE', 'down');
      const { body } = await api('post', '/v1/custom-words/lookup').send({ text: 'serendipity' }).expect(503);
      expect(body.error ?? body).toMatchObject({ retryable: true });
    });
  });

  describe('audio', () => {
    it('stores the generated audio on the pronunciation and in the snapshot', async () => {
      const { meaningId } = await addWord('serendipity');
      expect(h.tts.calls).toEqual(['serendipity']);
      const published = await h.first(meaningPublications, eq(meaningPublications.meaningId, meaningId));
      expect(JSON.stringify(published.snapshot)).toContain('https://cdn.example.invalid/tts/fake-voice/en-US/');
    });

    it('does not pay again for a second sense of the same part of speech', async () => {
      await addWord('serendipity');
      const { draftId } = await lookup('serendipity', auth, 'another sense');
      const verbDraft = await add({ draftId }).expect(201);
      expect(h.tts.calls).toHaveLength(2);

      const noun = await lookup('serendipity', auth, 'third sense');
      await h.db.execute(sql`UPDATE lexical_drafts SET payload = jsonb_set(payload, '{senses,0,partOfSpeech}', '"noun"') WHERE id = ${noun.draftId}::uuid`);
      await add({ draftId: noun.draftId }).expect(201);
      expect(h.tts.calls).toHaveLength(2);
      expect(verbDraft.body.added).toBe(true);
    });

    it('adds the word when TTS fails, then repairs it through the worker', async () => {
      await onboard();
      h.tts.error = new ApiError('TTS_PROVIDER_UNAVAILABLE', 'down');
      const { meaningId } = await addWord('serendipity');
      expect(await list()).toHaveLength(1);
      expect(await h.count(pronunciations, isNotNull(pronunciations.audioAssetKey))).toBe(6);

      await expect(h.customWords.repairNextAudio()).rejects.toMatchObject({ status: 503 });
      h.tts.error = undefined;
      await expect(h.customWords.repairNextAudio()).resolves.toBe(true);
      expect(await h.count(meaningPublications, eq(meaningPublications.meaningId, meaningId))).toBe(1);
      await expect(h.customWords.repairNextAudio()).resolves.toBe(true);
      expect(await h.count(meaningPublications, eq(meaningPublications.meaningId, meaningId))).toBe(2);
      expect((await list())[0].audioUrl).toContain('https://');
      expect((await list())[0].ipa).toEqual(expect.any(String));
      await expect(h.customWords.repairNextAudio()).resolves.toBe(false);
    });
  });

  describe('performance', () => {
    const name = (i: number) => `word${String.fromCharCode(97 + i)}q`;
    const measure = async (size: number) => {
      await h.reset();
      auth = await h.token('user-1');
      await api('get', '/v1/me').expect(200);
      await onboard();
      for (let i = 0; i < size; i += 1) await addWord(name(i));
      const listed = await h.countQueries(() => list());
      const looked = await h.countQueries(() => lookup(name(0)));
      const draft = await lookup('latest');
      const added = await h.countQueries(() => add({ draftId: draft.draftId }).expect(201));
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: size }).expect(200);
      const planned = await h.countQueries(() => plan());
      return { list: listed.queries, lookup: looked.queries, add: added.queries, plan: planned.queries };
    };

    it('query count does not grow with the roadmap', async () => {
      const small = await measure(1);
      const large = await measure(20);
      expect(large).toEqual(small);
    }, 120_000);
  });
});
