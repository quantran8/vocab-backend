import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERSONAL_COLLECTION_SLUG } from '../src/common/constants/domain';
import { AppConfig } from '../src/config/app-config';
import { appUsers, collections, topicMeanings, topics, userMeaningOverrides, words } from '../src/db/schema';
import { AuthProvider } from '../src/modules/auth/providers/auth.provider';
import { seedAdmin } from '../src/seed/seed-admin';
import { createHarness, Harness, SEED_ADMIN, seedWord } from './support/app';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const VI = 'vi-VN';

describe('admin API', () => {
  let h: Harness;
  let admin: string;
  const api = (method: Method, path: string, token = admin) => h.http()[method](path).set('Authorization', `Bearer ${token}`);

  const draft = (lemma = 'probe', overrides: object = {}) => ({
    lemma,
    types: [{
      partOfSpeech: 'verb',
      pronunciations: [{ accentLocale: 'en-US', ipa: '/proʊb/' }],
      meanings: [{ cefrLevel: 'B1', examples: [{ sourceText: 'Use it now.', targetLocator: { start: 4, end: 6 } }] }],
    }],
    ...overrides,
  });

  async function createWord(lemma = 'probe') {
    const { body } = await api('post', '/admin/words').send(draft(lemma)).expect(201);
    const type = body.types[0];
    const meaning = type.meanings[0];
    return { wordId: body.wordId as string, typeId: type.id as string, meaningId: meaning.id as string, exampleId: meaning.examples[0].id as string, pronunciationId: type.pronunciations[0].id as string };
  }

  async function publishWord(lemma = 'probe') {
    const ids = await createWord(lemma);
    await api('put', `/admin/meanings/${ids.meaningId}/locales/${VI}`).send({
      meaningText: 'dò', definitionText: 'dò xét', editorialState: 'approved',
      exampleTranslations: [{ exampleId: ids.exampleId, translationText: 'Dùng nó ngay.' }],
    }).expect(200);
    await api('post', `/admin/meanings/${ids.meaningId}/publish?locale=${VI}`).expect(200);
    return ids;
  }

  async function createPrivateMeaning(token: string) {
    const lookup = await api('post', '/v1/custom-words/lookup', token).send({ text: 'serendipity' }).expect(200);
    const created = await api('post', '/v1/custom-words', token).send({ draftId: lookup.body.draftId }).expect(201);
    const first = created.body.meanings?.[0]?.meaningId ?? created.body.meaningId;
    const lookupContext = await api('post', '/v1/custom-words/lookup', token).send({ text: 'serendipity', context: 'a lucky find' }).expect(200);
    await api('post', '/v1/custom-words', token).send({ draftId: lookupContext.body.draftId }).expect(201);
    const { body } = await api('get', '/admin/ai-meanings?scope=private').expect(200);
    return { first, privateId: body.meanings[0].meaningId as string, wordId: body.meanings[0].wordId as string };
  }

  beforeAll(async () => { h = await createHarness(); });
  beforeEach(async () => { await h.reset(); admin = await h.token('admin-1', 'admin'); });
  afterAll(async () => { await h.close(); });

  describe('access', () => {
    it('refuses learners on every new content route and editors on users', async () => {
      const learner = await h.token('learner');
      const editor = await h.token('editor-1', 'editor');
      for (const path of ['/admin/meta', '/admin/words', '/admin/meanings', '/admin/practice-items', '/admin/collections', '/admin/users']) {
        await api('get', path, learner).expect(403);
      }
      await api('get', '/admin/words', editor).expect(200);
      await api('get', '/admin/users', editor).expect(403);
      await api('put', `/admin/users/${randomUUID()}/role`, editor).send({ role: 'admin' }).expect(403);
    });

    it('exposes the enums the screens need', async () => {
      const { body } = await api('get', '/admin/meta').expect(200);
      expect(body.locales).toEqual(expect.arrayContaining([VI, 'en-US']));
      expect(body.templateVariants.select).toContain('gloss');
    });
  });

  describe('existing routes', () => {
    it('rejects an unsupported or missing locale instead of storing it', async () => {
      const { meaningId } = await createWord();
      await api('put', `/admin/meanings/${meaningId}/locales/xx-XX`).send({ meaningText: 'a', definitionText: 'b' }).expect(400);
      await api('put', `/admin/meanings/${meaningId}/locales/${'x'.repeat(40)}`).send({ meaningText: 'a', definitionText: 'b' }).expect(400);
      await api('post', `/admin/meanings/${meaningId}/publish`).expect(400);
      await api('post', `/admin/meanings/${meaningId}/recall`).expect(400);
    });

    it('answers 404 or 422 for an unknown id, not a retryable 500', async () => {
      const missing = randomUUID();
      await api('put', `/admin/meanings/${missing}/locales/${VI}`).send({ meaningText: 'a', definitionText: 'b' }).expect(404);
      await api('put', `/admin/practice-items/${missing}/locales/${VI}`).send({}).expect(404);
      const item = (extra: object) => ({
        template: 'typing', variant: 'meaning_recall', sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { acceptedResponses: ['x'] }, ...extra,
      });
      await api('post', '/admin/practice-items').send(item({ targets: [{ meaningId: missing }] })).expect(422);
      const { meaningId } = await createWord();
      await api('post', '/admin/practice-items').send(item({ targets: [{ meaningId }], supersedesItemId: missing })).expect(422);
    });

    it('answers 409 for a repeated part of speech in one word', async () => {
      const type = draft().types[0];
      await api('post', '/admin/words').send(draft('dup', { types: [type, type] })).expect(409);
    });

    it('keeps a private meaning approvable: its text cannot be edited first', async () => {
      const learner = await h.token('learner');
      const { privateId } = await createPrivateMeaning(learner);
      const res = await api('put', `/admin/meanings/${privateId}/locales/${VI}`).send({ meaningText: 'sửa', definitionText: 'sửa' }).expect(409);
      expect(res.body.code).toBe('CONTENT_LOCKED');
      await api('post', `/admin/ai-meanings/${privateId}/approve`).expect(200);
    });

    it('adds total, examples and recalled locales to the AI queue', async () => {
      const learner = await h.token('learner');
      const { privateId } = await createPrivateMeaning(learner);
      await api('post', `/admin/meanings/${privateId}/recall?locale=${VI}`).expect(200);
      const { body } = await api('get', '/admin/ai-meanings?scope=private&limit=1&offset=5').expect(200);
      expect(body.total).toBe(1);
      expect(body.meanings).toEqual([]);
      const row = (await api('get', '/admin/ai-meanings?scope=private').expect(200)).body.meanings[0];
      expect(row.recalledLocales).toEqual([VI]);
      expect(row.liveLocales).toEqual([]);
      expect(row.examples[0].translations[0].locale).toBe(VI);
    });
  });

  describe('words', () => {
    it('searches by lemma prefix, escapes wildcards and paginates with a total', async () => {
      await createWord('apple');
      await createWord('apply');
      await createWord('banana');
      const { body } = await api('get', '/admin/words?q=APP&limit=1').expect(200);
      expect(body.total).toBe(2);
      expect(body.items.map((w: Json) => w.lemma)).toEqual(['apple']);
      expect(body.items[0]).toMatchObject({ partsOfSpeech: ['verb'], meaningCount: 1, liveMeaningCount: 0 });
      expect((await api('get', '/admin/words?q=%25').expect(200)).body.total).toBe(0);
      expect((await api('get', '/admin/words?offset=99').expect(200)).body).toEqual({ total: 3, items: [] });
    });

    it('returns ids and publication state on detail, without snapshots', async () => {
      const { wordId, meaningId } = await publishWord();
      const { body } = await api('get', `/admin/words/${wordId}`).expect(200);
      const meaning = body.types[0].meanings[0];
      expect(meaning.id).toBe(meaningId);
      expect(meaning.examples[0].localizations[0].translationText).toBe('Dùng nó ngay.');
      expect(meaning.publications[0]).toMatchObject({ locale: VI, revision: 1, recalledAt: null });
      expect(body.identityLocked).toBe(true);
      expect(JSON.stringify(body)).not.toContain('snapshot');
      await api('get', `/admin/words/${randomUUID()}`).expect(404);
    });

    it('edits a lemma until something was published', async () => {
      const { wordId } = await createWord('first');
      await createWord('taken');
      await api('patch', `/admin/words/${wordId}`).send({ lemma: 'second' }).expect(200);
      expect((await h.first(words, eq(words.id, wordId))).lemma).toBe('second');
      expect((await api('patch', `/admin/words/${wordId}`).send({ lemma: ' TAKEN ' }).expect(409)).body.code).toBe('WORD_ALREADY_EXISTS');
      await api('patch', `/admin/words/${wordId}`).send({}).expect(400);

      const published = await publishWord('live');
      expect((await api('patch', `/admin/words/${published.wordId}`).send({ lemma: 'other' }).expect(409)).body.code).toBe('CONTENT_LOCKED');
    });

    it('deletes a draft word with all its children', async () => {
      const { wordId } = await createWord();
      await api('delete', `/admin/words/${wordId}`).expect(204);
      await api('get', `/admin/words/${wordId}`).expect(404);
      await api('delete', `/admin/words/${wordId}`).expect(404);
    });

    it('never deletes published content, at any level', async () => {
      const { wordId, typeId, meaningId, exampleId, pronunciationId } = await publishWord();
      for (const path of [`/admin/words/${wordId}`, `/admin/word-types/${typeId}`, `/admin/meanings/${meaningId}`, `/admin/examples/${exampleId}`, `/admin/pronunciations/${pronunciationId}`, `/admin/meanings/${meaningId}/locales/${VI}`]) {
        expect((await api('delete', path).expect(409)).body.code).toBe('CONTENT_LOCKED');
      }
      await api('post', `/admin/meanings/${meaningId}/recall?locale=${VI}`).expect(200);
      await api('delete', `/admin/meanings/${meaningId}`).expect(409);
    });

    it('answers 409 when a draft is still used by a practice item', async () => {
      const { meaningId, wordId } = await createWord();
      await api('post', '/admin/practice-items').send({
        template: 'typing', variant: 'meaning_recall', sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { acceptedResponses: ['x'] }, targets: [{ meaningId }],
      }).expect(201);
      expect((await api('delete', `/admin/words/${wordId}`).expect(409)).body.code).toBe('CONTENT_LOCKED');
      await api('get', `/admin/words/${wordId}`).expect(200);
    });

    it('manages types, pronunciations, meanings and examples', async () => {
      const { wordId, typeId, meaningId, exampleId, pronunciationId } = await createWord();
      const type = (await api('post', `/admin/words/${wordId}/types`).send({ partOfSpeech: 'noun' }).expect(201)).body;
      await api('post', `/admin/words/${wordId}/types`).send({ partOfSpeech: 'noun' }).expect(409);
      await api('post', `/admin/words/${randomUUID()}/types`).send({ partOfSpeech: 'noun' }).expect(404);

      await api('post', `/admin/word-types/${typeId}/pronunciations`).send({ accentLocale: 'en-US' }).expect(409);
      await api('post', `/admin/word-types/${typeId}/pronunciations`).send({ accentLocale: 'en-GB', ipa: '/x/' }).expect(201);
      await api('patch', `/admin/pronunciations/${pronunciationId}`).send({ ipa: '/new/' }).expect(200);
      await api('patch', `/admin/pronunciations/${pronunciationId}`).send({ accentLocale: 'en-GB' }).expect(409);
      await api('delete', `/admin/pronunciations/${pronunciationId}`).expect(204);

      const added = (await api('post', `/admin/word-types/${type.id}/meanings`).send({ cefrLevel: 'A1' }).expect(201)).body;
      await api('post', `/admin/word-types/${randomUUID()}/meanings`).send({}).expect(404);
      expect((await api('patch', `/admin/meanings/${added.id}`).send({ cefrLevel: 'B2' }).expect(200)).body.cefrLevel).toBe('B2');
      await api('patch', `/admin/meanings/${randomUUID()}`).send({ cefrLevel: 'B2' }).expect(404);
      await api('delete', `/admin/meanings/${added.id}`).expect(204);
      await api('delete', `/admin/word-types/${type.id}`).expect(204);

      await api('post', `/admin/meanings/${meaningId}/examples`).send({ sourceText: 'short', targetLocator: { start: 0, end: 99 } }).expect(400);
      const example = (await api('post', `/admin/meanings/${meaningId}/examples`).send({ sourceText: 'Probe it.', targetLocator: { start: 0, end: 5 } }).expect(201)).body;
      await api('patch', `/admin/examples/${example.id}`).send({ sourceText: 'Probe me.', targetLocator: { start: 0, end: 5 } }).expect(200);
      await api('delete', `/admin/examples/${example.id}`).expect(204);
      await api('delete', `/admin/examples/${exampleId}`).expect(204);
    });

    it('removes a draft locale with its example translations', async () => {
      const { meaningId, exampleId, wordId } = await createWord();
      await api('put', `/admin/meanings/${meaningId}/locales/${VI}`).send({ meaningText: 'a', definitionText: 'b', exampleTranslations: [{ exampleId, translationText: 'c' }] }).expect(200);
      await api('delete', `/admin/meanings/${meaningId}/locales/${VI}`).expect(204);
      await api('delete', `/admin/meanings/${meaningId}/locales/${VI}`).expect(404);
      const { body } = await api('get', `/admin/words/${wordId}`).expect(200);
      expect(body.types[0].meanings[0].localizations).toEqual([]);
      expect(body.types[0].meanings[0].examples[0].localizations).toEqual([]);
    });

    it('lists revisions newest first and marks the current one', async () => {
      const { meaningId } = await publishWord();
      await api('post', `/admin/meanings/${meaningId}/publish?locale=${VI}`).expect(200);
      const { body } = await api('get', `/admin/meanings/${meaningId}/publications`).expect(200);
      expect(body.items.map((p: Json) => [p.revision, p.isCurrent])).toEqual([[2, true], [1, false]]);
      expect(JSON.stringify(body)).not.toContain('snapshot');
    });
  });

  describe('private content', () => {
    it('never shows a private meaning or a learner edit outside the AI queue', async () => {
      const learner = await h.token('learner');
      const { first, privateId, wordId } = await createPrivateMeaning(learner);
      await h.db.insert(userMeaningOverrides).values({
        userId: (await h.first(appUsers, eq(appUsers.identitySubject, 'learner'))).id, meaningId: first, locale: VI, content: { meaningText: 'bản sửa riêng' } as never,
      });

      const detail = await api('get', `/admin/words/${wordId}`).expect(200);
      const shownIds = detail.body.types.flatMap((t: Json) => t.meanings.map((m: Json) => m.id));
      expect(shownIds).not.toContain(privateId);
      expect(detail.body.privateMeaningCount).toBe(1);
      expect(JSON.stringify(detail.body)).not.toContain('bản sửa riêng');

      const listed = await api('get', '/admin/meanings?q=serendipity').expect(200);
      expect(listed.body.items.map((m: Json) => m.id)).not.toContain(privateId);
      expect(JSON.stringify(listed.body)).not.toContain('bản sửa riêng');
    });

    it('refuses every write to a private meaning', async () => {
      const learner = await h.token('learner');
      const { privateId, wordId } = await createPrivateMeaning(learner);
      await api('patch', `/admin/meanings/${privateId}`).send({ cefrLevel: 'C1' }).expect(409);
      await api('delete', `/admin/meanings/${privateId}`).expect(409);
      await api('delete', `/admin/meanings/${privateId}/locales/${VI}`).expect(409);
      await api('post', `/admin/meanings/${privateId}/examples`).send({ sourceText: 'Use it.', targetLocator: { start: 0, end: 3 } }).expect(409);
      await api('patch', `/admin/words/${wordId}`).send({ lemma: 'other' }).expect(409);
      const queue = (await api('get', '/admin/ai-meanings?scope=private').expect(200)).body.meanings[0];
      await api('patch', `/admin/examples/${queue.examples[0].id}`).send({ sourceText: 'Use it.', targetLocator: { start: 0, end: 3 } }).expect(409);
    });

    it('refuses a private meaning as a practice target', async () => {
      const learner = await h.token('learner');
      const { privateId } = await createPrivateMeaning(learner);
      await api('post', '/admin/practice-items').send({
        template: 'typing', variant: 'meaning_recall', sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { acceptedResponses: ['x'] }, targets: [{ meaningId: privateId }],
      }).expect(422);
    });
  });

  describe('practice items', () => {
    const typing = (meaningId: string, extra: object = {}) => ({
      template: 'typing', variant: 'meaning_recall', sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { acceptedResponses: ['probe'] }, targets: [{ meaningId }], ...extra,
    });
    const approve = (id: string, body: object = {}) => api('put', `/admin/practice-items/${id}/locales/${VI}`).send({ editorialState: 'approved', ...body }).expect(200);

    it('lists without content and filters; detail carries content', async () => {
      const { meaningId } = await createWord();
      const { body: { id } } = await api('post', '/admin/practice-items').send(typing(meaningId)).expect(201);
      const { body } = await api('get', `/admin/practice-items?template=typing&status=draft&meaningId=${meaningId}`).expect(200);
      expect(body.total).toBe(1);
      expect(body.items[0].targets[0].lemma).toBe('probe');
      expect(JSON.stringify(body)).not.toContain('sourceContent');
      expect((await api('get', '/admin/practice-items?status=published').expect(200)).body.total).toBe(0);
      const detail = (await api('get', `/admin/practice-items/${id}`).expect(200)).body;
      expect(detail.sourceEvaluation.acceptedResponses).toEqual(['probe']);
      await api('get', `/admin/practice-items/${randomUUID()}`).expect(404);
    });

    it('edits and deletes only drafts', async () => {
      const { meaningId } = await createWord();
      const { body: { id } } = await api('post', '/admin/practice-items').send(typing(meaningId)).expect(201);
      await api('patch', `/admin/practice-items/${id}`).send({ sourceEvaluation: { acceptedResponses: ['y'] }, targets: [{ meaningId }] }).expect(200);
      await api('patch', `/admin/practice-items/${id}`).send({ variant: 'gloss' }).expect(422);
      await approve(id);
      await api('post', `/admin/practice-items/${id}/publish`).expect(200);
      expect((await api('patch', `/admin/practice-items/${id}`).send({ sourceContent: { promptVariants: {} } }).expect(409)).body.code).toBe('CONTENT_LOCKED');
      await api('delete', `/admin/practice-items/${id}`).expect(409);

      const other = (await api('post', '/admin/practice-items').send(typing(meaningId)).expect(201)).body.id;
      await api('put', `/admin/practice-items/${other}/locales/${VI}`).send({}).expect(200);
      await api('delete', `/admin/practice-items/${other}`).expect(204);
      await api('get', `/admin/practice-items/${other}`).expect(404);
    });

    it('retires only a published item, and a retired one cannot return', async () => {
      const { meaningId } = await createWord();
      const { body: { id } } = await api('post', '/admin/practice-items').send(typing(meaningId)).expect(201);
      await api('post', `/admin/practice-items/${id}/retire`).expect(409);
      await approve(id);
      await api('post', `/admin/practice-items/${id}/publish`).expect(200);
      expect((await api('post', `/admin/practice-items/${id}/retire`).expect(200)).body.status).toBe('retired');
      expect((await api('post', `/admin/practice-items/${id}/publish`).expect(409)).body.code).toBe('CONTENT_LOCKED');
      await api('post', `/admin/practice-items/${randomUUID()}/retire`).expect(404);
    });

    it('refuses to publish an item the planner would drop', async () => {
      const { meaningId } = await createWord();
      const noAnswer = { sourceEvaluation: {} };
      const { body: { id } } = await api('post', '/admin/practice-items').send(typing(meaningId, noAnswer)).expect(201);
      await approve(id);
      const res = await api('post', `/admin/practice-items/${id}/publish`).expect(422);
      expect(res.body.code).toBe('TASK_DATA_INVALID');
      expect(res.body.message).toContain(VI);
    });
  });

  describe('catalog', () => {
    const entry = (slug: string, extra: object = {}) => ({ slug, title: slug, ...extra });
    const collection = async (slug = 'travel') => (await api('post', '/admin/collections').send(entry(slug)).expect(201)).body.id as string;
    const topic = async (collectionId: string, slug = 'airport') => (await api('post', `/admin/collections/${collectionId}/topics`).send(entry(slug)).expect(201)).body.id as string;

    it('creates, edits and localizes collections and topics', async () => {
      const id = await collection();
      await api('post', '/admin/collections').send(entry('travel')).expect(409);
      await api('post', '/admin/collections').send(entry('Not A Slug')).expect(400);
      const topicId = await topic(id);
      await api('post', `/admin/collections/${id}/topics`).send(entry('airport')).expect(409);

      expect((await api('patch', `/admin/collections/${id}`).send({ status: 'published' }).expect(200)).body.status).toBe('published');
      await api('patch', `/admin/topics/${topicId}`).send({ title: 'Sân bay', status: 'published' }).expect(200);
      await api('put', `/admin/collections/${id}/locales/${VI}`).send({ title: 'Du lịch', description: 'mô tả' }).expect(200);
      await api('put', `/admin/topics/${topicId}/locales/${VI}`).send({ title: 'Sân bay' }).expect(200);
      await api('put', `/admin/topics/${topicId}/locales/xx-XX`).send({ title: 'x' }).expect(400);

      const detail = (await api('get', `/admin/collections/${id}`).expect(200)).body;
      expect(detail.localizations[0].title).toBe('Du lịch');
      expect(detail.topics[0]).toMatchObject({ id: topicId, meaningCount: 0, locales: [VI] });
      expect((await api('get', '/admin/collections').expect(200)).body.items[0]).toMatchObject({ topicCount: 1, locales: [VI] });
      expect((await api('get', `/admin/topics/${topicId}`).expect(200)).body.localizations[0].title).toBe('Sân bay');

      await api('delete', `/admin/topics/${topicId}/locales/${VI}`).expect(204);
      await api('delete', `/admin/collections/${id}/locales/${VI}`).expect(204);
      await api('delete', `/admin/collections/${id}/locales/${VI}`).expect(404);
    });

    it('deletes only drafts, and only when learners do not use them', async () => {
      const id = await collection();
      const topicId = await topic(id);
      expect((await api('delete', `/admin/collections/${id}`).expect(409)).body.message).toContain('topics');
      await api('patch', `/admin/topics/${topicId}`).send({ status: 'published' }).expect(200);
      await api('delete', `/admin/topics/${topicId}`).expect(409);
      await api('patch', `/admin/topics/${topicId}`).send({ status: 'draft' }).expect(200);
      await api('delete', `/admin/topics/${topicId}`).expect(204);
      await api('delete', `/admin/collections/${id}`).expect(204);

      const learner = await h.token('learner');
      const seeded = await h.seed('used', [seedWord(0)]);
      await api('put', '/v1/me/levels', learner).send({ proficiencyLevel: 'B1' }).expect(200);
      await api('put', '/v1/me/scope', learner).send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
      await api('patch', `/admin/topics/${seeded.topicId}`).send({ status: 'draft' }).expect(200);
      expect((await api('delete', `/admin/topics/${seeded.topicId}`).expect(409)).body.code).toBe('CONTENT_LOCKED');
      await api('patch', `/admin/collections/${seeded.collectionId}`).send({ status: 'draft' }).expect(200);
    });

    it('assigns only shared published meanings and reorders without breaking the unique rank', async () => {
      const topicId = await topic(await collection());
      const a = await publishWord('alpha');
      const b = await publishWord('beta');
      const c = await publishWord('gamma');
      const draftWord = await createWord('delta');

      expect((await api('post', `/admin/topics/${topicId}/meanings`).send({ meaningIds: [draftWord.meaningId] }).expect(422)).body.code).toBe('CONTENT_UNAVAILABLE');
      const learner = await h.token('learner');
      const { privateId } = await createPrivateMeaning(learner);
      await api('post', `/admin/topics/${topicId}/meanings`).send({ meaningIds: [privateId] }).expect(422);

      expect((await api('post', `/admin/topics/${topicId}/meanings`).send({ meaningIds: [a.meaningId, b.meaningId] }).expect(201)).body.added).toBe(2);
      expect((await api('post', `/admin/topics/${topicId}/meanings`).send({ meaningIds: [b.meaningId, c.meaningId] }).expect(201)).body.added).toBe(1);
      const ranked = async () => (await api('get', `/admin/topics/${topicId}/meanings`).expect(200)).body.items.map((m: Json) => [m.lemma, m.rank]);
      expect(await ranked()).toEqual([['alpha', 1], ['beta', 2], ['gamma', 3]]);

      await api('put', `/admin/topics/${topicId}/meanings/order`).send({ meaningIds: [c.meaningId, a.meaningId, b.meaningId] }).expect(200);
      expect(await ranked()).toEqual([['gamma', 1], ['alpha', 2], ['beta', 3]]);
      await api('put', `/admin/topics/${topicId}/meanings/order`).send({ meaningIds: [a.meaningId, b.meaningId] }).expect(400);
      await api('put', `/admin/topics/${topicId}/meanings/order`).send({ meaningIds: [a.meaningId, b.meaningId, draftWord.meaningId] }).expect(400);

      await api('delete', `/admin/topics/${topicId}/meanings/${a.meaningId}`).expect(204);
      await api('delete', `/admin/topics/${topicId}/meanings/${a.meaningId}`).expect(404);
      await api('post', `/admin/topics/${topicId}/meanings`).send({ meaningIds: [a.meaningId] }).expect(201);
      expect(await ranked()).toEqual([['gamma', 1], ['beta', 3], ['alpha', 4]]);
      expect(await h.count(topicMeanings, and(eq(topicMeanings.topicId, topicId)))).toBe(3);
    });

    it('never exposes or changes personal collections and learner-owned topics', async () => {
      const learner = await h.token('learner');
      await createPrivateMeaning(learner);
      const personal = await h.first(collections, eq(collections.slug, PERSONAL_COLLECTION_SLUG));
      const owned = await h.first(topics, eq(topics.collectionId, personal.id));

      expect((await api('get', '/admin/collections').expect(200)).body.total).toBe(0);
      await api('get', `/admin/collections/${personal.id}`).expect(404);
      await api('patch', `/admin/collections/${personal.id}`).send({ title: 'x' }).expect(404);
      await api('delete', `/admin/collections/${personal.id}`).expect(404);
      await api('post', `/admin/collections/${personal.id}/topics`).send(entry('x')).expect(404);
      await api('post', '/admin/collections').send(entry(PERSONAL_COLLECTION_SLUG)).expect(400);
      await api('get', `/admin/topics/${owned.id}`).expect(404);
      await api('patch', `/admin/topics/${owned.id}`).send({ title: 'x' }).expect(404);
      await api('delete', `/admin/topics/${owned.id}`).expect(404);
      await api('get', `/admin/topics/${owned.id}/meanings`).expect(404);
    });
  });

  describe('users', () => {
    const subject = randomUUID();
    beforeEach(() => {
      h.authUsers.push(
        { id: subject, email: 'editor@example.com', app_metadata: { role: 'editor' }, created_at: '2026-01-01T00:00:00Z', last_sign_in_at: null },
        { id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' } },
      );
    });

    it('lists accounts joined with their app_user row', async () => {
      await api('get', '/admin/words').expect(200);
      const { body } = await api('get', '/admin/users?perPage=10').expect(200);
      expect(body.total).toBe(2);
      expect(body.items[0]).toMatchObject({ id: subject, email: 'editor@example.com', role: 'editor', appUserId: null });
      expect(body.items[1].appUserId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain('app_metadata');
    });

    it('sets and clears the editor role', async () => {
      const learner = randomUUID();
      h.authUsers.push({ id: learner, email: 'learner@example.com', app_metadata: {} });
      await api('put', `/admin/users/${learner}/role`).send({ role: 'editor' }).expect(200);
      expect(h.authUsers.at(-1)?.app_metadata).toEqual({ role: 'editor' });
      await api('put', `/admin/users/${learner}/role`).send({ role: null }).expect(200);
      expect(h.authUsers.at(-1)?.app_metadata).toEqual({});
      await api('put', `/admin/users/${learner}/role`).send({ role: 'owner' }).expect(400);
      await api('put', `/admin/users/${randomUUID()}/role`).send({ role: 'editor' }).expect(404);
    });

    it('never grants the admin role and never changes an admin account', async () => {
      await api('put', `/admin/users/${subject}/role`).send({ role: 'admin' }).expect(400);
      expect(h.authUsers[0].app_metadata).toEqual({ role: 'editor' });
      const otherAdmin = randomUUID();
      h.authUsers.push({ id: otherAdmin, email: 'other@example.com', app_metadata: { role: 'admin' } });
      await api('put', `/admin/users/${otherAdmin}/role`).send({ role: null }).expect(403);
      await api('put', `/admin/users/${otherAdmin}/role`).send({ role: 'editor' }).expect(403);
      expect(h.authUsers.at(-1)?.app_metadata).toEqual({ role: 'admin' });
    });
  });

  describe('seeded admin', () => {
    const auth = () => h.app.get(AuthProvider);
    const config = () => h.app.get(AppConfig);

    it('creates the account once and keeps it on later runs', async () => {
      await seedAdmin(auth(), config());
      await seedAdmin(auth(), config());
      const seeded = h.authUsers.filter((u) => u.email === SEED_ADMIN.EMAIL);
      expect(seeded).toHaveLength(1);
      expect(seeded[0].app_metadata).toEqual({ role: 'admin' });
    });

    it('refuses to promote a learner who already holds the address', async () => {
      h.authUsers.push({ id: randomUUID(), email: SEED_ADMIN.EMAIL, app_metadata: {} });
      await expect(seedAdmin(auth(), config())).rejects.toThrow(/without the admin role/);
      expect(h.authUsers[0].app_metadata).toEqual({});
    });

    it('refuses to seed without the env values', async () => {
      await expect(seedAdmin(auth(), { seedAdminEmail: SEED_ADMIN.EMAIL, seedAdminPassword: undefined })).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
      await expect(seedAdmin(auth(), { seedAdminEmail: undefined, seedAdminPassword: 'x' })).rejects.toThrow(/SEED_ADMIN_EMAIL/);
      expect(h.authUsers).toEqual([]);
    });

    it('signs in with the login name, and accepts no other bare name', async () => {
      const login = (email: string) => h.http().post('/v1/auth/login').send({ email, password: 'correct-horse' });
      expect((await login(' Admin ').expect(200)).body.user.email).toBe(SEED_ADMIN.EMAIL);
      await login('someone').expect(400);
      await h.http().post('/v1/auth/signup').send({ email: 'admin', password: 'correct-horse' }).expect(400);
    });
  });

  describe('query counts', () => {
    const listAndDetail = async (wordId: string, topicId: string, collectionId: string, itemId: string) => {
      const paths = [
        '/admin/words?limit=100', `/admin/words/${wordId}`, '/admin/meanings?limit=100', '/admin/ai-meanings?limit=100', '/admin/practice-items?limit=100', `/admin/practice-items/${itemId}`,
        '/admin/collections?limit=100', `/admin/collections/${collectionId}`, `/admin/topics/${topicId}/meanings`,
      ];
      const counts: Record<string, number> = {};
      await api('get', '/v1/me').expect(200); // Provisions the admin first, so its insert does not count below.
      for (const path of paths) {
        const { queries } = await h.countQueries(() => api('get', path).expect(200).then(() => undefined));
        counts[path.split('?')[0].replace(/[0-9a-f-]{36}/, ':id')] = queries;
      }
      return counts;
    };

    it('does not grow with data', async () => {
      const measure = async (n: number) => {
        await h.reset();
        admin = await h.token('admin-1', 'admin');
        const seeded = await h.seed('topic-a', Array.from({ length: n }, (_, i) => seedWord(i)));
        const { body: { id: itemId } } = await api('post', '/admin/practice-items').send({
          template: 'typing', variant: 'meaning_recall', sourceContent: { promptVariants: { text: { text: 'cue' } } }, sourceEvaluation: { acceptedResponses: ['x'] }, targets: seeded.meaningIds.map((meaningId: string) => ({ meaningId })),
        }).expect(201);
        await api('post', `/admin/topics/${seeded.topicId}/meanings`).send({ meaningIds: seeded.meaningIds }).expect(201);
        return listAndDetail(seeded.wordIds[0], seeded.topicId, seeded.collectionId, itemId);
      };
      const one = await measure(1);
      const twenty = await measure(20);
      expect(twenty).toEqual(one);
      expect(Math.max(...Object.values(one))).toBeLessThanOrEqual(4);
    });
  });

});
