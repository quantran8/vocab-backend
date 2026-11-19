import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { APP_LOCALES, LEARNING_LANGUAGE } from '../src/common/constants/domain';
import { activeMeaningPublications, meaningPublications, meanings, pronunciations, topicMeanings, words, wordTypes } from '../src/db/schema';
import { EntryReview, GeneratedEntry, RankedLemma, TranslatedMeaning, TranslationReview } from '../src/content-pipeline/build.types';
import { CollectionSpec } from '../src/content-pipeline/collections/collection.types';
import { JsonlStore } from '../src/content-pipeline/jsonl';
import { Lexicon, LexiconEntry } from '../src/content-pipeline/lexicon/lexicon.types';
import { toGeneratedEntry } from '../src/content-pipeline/stages/generate';
import { loadPlan } from '../src/content-pipeline/stages/load';
import { buildLoadPlan } from '../src/content-pipeline/stages/load-plan';
import { entryHash } from '../src/content-pipeline/stages/review';
import { meaningSourceHash, TARGET_LOCALES } from '../src/content-pipeline/stages/translate';
import { translationHash } from '../src/content-pipeline/stages/translation-review';
import { CAPS, createHarness, Harness } from './support/app';

const spec: CollectionSpec = {
  slug: 'pipeline-test', title: 'Pipeline Test', description: 'Test collection.', color: '#123456', promptVersion: 1,
  select: () => true, maxLevel: 'B2', maxMeanings: () => 3, examplesPerMeaning: 1,
  topics: [{ slug: 'money', title: 'Money', description: 'Money words.', iosIcon: 'banknote', covers: 'money' }],
};

const entry = (lemma: string, rank: number): LexiconEntry => ({
  key: `${lemma}|noun`, lemma, pos: 'noun', cefr: 'A1', cefrSource: 'cefrj', ngslRank: rank,
  forms: [lemma, `${lemma}s`], senses: [{ key: `${lemma}%1:14:00::`, gloss: 'a thing', lexname: 'noun.possession', homograph: null, pronunciations: [], count: 3 }],
  ipaUs: [`/${lemma}/`], ipaUk: [], confusables: { homophones: [], spelling: [] },
});

const LEMMAS = ['bank', 'cash', 'coin', 'price'];
const lexicon: Lexicon = {
  builtAt: '', entries: LEMMAS.map((l, i) => entry(l, i + 1)), ngslWithoutLevel: [],
  levelOfForm: Object.fromEntries(['i', 'have', 'a', 'the', 'is', 'in', 'my', 'on', ...LEMMAS].map((w) => [w, 'A1'])),
};

function generated(): GeneratedEntry[] {
  return lexicon.entries.map((e) => toGeneratedEntry(spec, lexicon, e, {
    key: e.key, skip: null,
    meanings: [{ senses: [1], cefrLevel: 'A1', gloss: e.lemma, definition: 'A thing used for money.', ipa: 1, topic: 'money', examples: [{ text: `I have a ${e.lemma} in my bag.`, target: e.lemma }] }],
  }, undefined, 'test-model'));
}

const LOCALES = [...APP_LOCALES];
// Every test lemma has one meaning, which needs no rank.
const noRanks = new JsonlStore<RankedLemma>('/dev/null');

/** A clean review for every entry, as the reviewer would store it. */
function approved(entries: GeneratedEntry[]) {
  const store = new JsonlStore<EntryReview>('/dev/null');
  for (const e of entries) store.rows.set(e.key, { key: e.key, sourceHash: entryHash(e), problems: [], model: 'test-model' });
  return store;
}
/** A clean translation review for every stored translation. */
function reviewedTranslations(translations: Map<string, JsonlStore<TranslatedMeaning>>) {
  return new Map([...translations].map(([locale, store]) => {
    const reviews = new JsonlStore<TranslationReview>('/dev/null');
    for (const t of store.rows.values()) reviews.rows.set(t.meaningId, { key: t.meaningId, sourceHash: translationHash(t), problems: [], model: 'test-model' });
    return [locale, reviews];
  }));
}

/** Builds a plan whose translations all passed review. */
const planOf = (entries: GeneratedEntry[], translations: Map<string, JsonlStore<TranslatedMeaning>>, reviews: JsonlStore<EntryReview>) =>
  buildLoadPlan(spec, lexicon, entries, LOCALES, translations, noRanks, reviews, reviewedTranslations(translations));

const everyLocale = (n: number) => Object.fromEntries(LOCALES.map((l) => [l, n]));

/** Stub translations for every target locale; `skip` leaves a lemma without `missingLocale`. */
function translated(entries: GeneratedEntry[], options: { skip?: string[]; missingLocale?: string; prefix?: string } = {}) {
  return new Map(TARGET_LOCALES.map((locale) => {
    const store = new JsonlStore<TranslatedMeaning>('/dev/null');
    for (const e of entries) {
      if (options.skip?.includes(e.lemma) && locale === options.missingLocale) continue;
      const m = e.meanings[0];
      store.rows.set(m.meaningId, {
        key: m.meaningId, meaningId: m.meaningId, sourceHash: meaningSourceHash(e, m),
        meaningText: `${options.prefix ?? 'nghĩa'} ${e.lemma} ${locale}`, definitionText: 'Một thứ dùng làm tiền.', exampleTranslations: ['Tôi có một thứ trong túi.'], model: 'test-model',
      });
    }
    return [locale, store];
  }));
}

describe('content pipeline load', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => { await h.reset(); });

  it('loads, publishes, re-runs without new revisions, and revises only changed snapshots', async () => {
    // A learner's custom word got there first: the load attaches to it.
    const [custom] = await h.db.insert(words).values({ language: LEARNING_LANGUAGE, lemma: 'Bank' }).returning({ id: words.id });
    const entries = generated();
    const plan = planOf(entries, translated(entries), approved(entries));
    expect(plan.report).toMatchObject({ meanings: 4, ruleFailures: 0, missingRequiredLocale: 0 });

    const first = await loadPlan(h.db, plan, true);
    expect(first).toMatchObject({ words: 3, published: everyLocale(4), rejected: [] });
    expect(await h.count(words, sql`lower(btrim(${words.lemma})) = 'bank'`)).toBe(1);
    expect(await h.count(wordTypes, eq(wordTypes.wordId, custom.id))).toBe(1);
    expect(await h.count(topicMeanings)).toBe(4);
    expect(await h.first(pronunciations, eq(pronunciations.meaningId, entries[0].meanings[0].meaningId))).toMatchObject({ ipa: '/bank/' });

    expect(await loadPlan(h.db, plan, true)).toMatchObject({ words: 0, published: everyLocale(0) });
    expect(await h.count(meanings)).toBe(4);

    // New translated text: one revision per meaning in each translated locale; English is unchanged.
    const third = await loadPlan(h.db, planOf(entries, translated(entries, { prefix: 'từ' }), approved(entries)), true);
    expect(third.published).toEqual({ ...everyLocale(4), 'en-US': 0 });
    expect(await h.count(meaningPublications)).toBe(4 * LOCALES.length + 4 * TARGET_LOCALES.length);
    expect(await h.count(activeMeaningPublications)).toBe(4 * LOCALES.length);
  });

  it('leaves out meanings with rule failures or missing any app locale', async () => {
    const entries = generated();
    entries[0].issues[entries[0].meanings[0].meaningId] = ['example 1: target not found'];
    const plan = planOf(entries, translated(entries, { skip: ['cash'], missingLocale: 'ja-JP' }), approved(entries));
    expect(plan.report).toMatchObject({ meanings: 2, ruleFailures: 1, missingRequiredLocale: 1 });
    expect(plan.topics[0].meaningIds).toHaveLength(2);

    // The reviewer rejected "coin"; "price" changed after its review, so that verdict no longer counts.
    const reviews = approved(entries);
    reviews.rows.get('coin|noun')!.problems.push({ key: 'coin|noun', gloss: 'coin', kind: 'merged', note: 'split' });
    reviews.rows.get('price|noun')!.sourceHash = 'stale';
    const reviewed = planOf(entries, translated(entries), reviews);
    expect(reviewed.report).toMatchObject({ meanings: 1, ruleFailures: 1, rejectedByReview: 1, unreviewed: 1 });
  });

  it('leaves out meanings whose translation is unreviewed, stale-reviewed or rejected in any locale', async () => {
    const entries = generated();
    const translations = translated(entries);
    const reviews = reviewedTranslations(translations);
    const id = (lemma: string) => entries.find((e) => e.lemma === lemma)!.meanings[0].meaningId;
    reviews.get('ja-JP')!.rows.get(id('bank'))!.problems.push({ kind: 'unnatural', note: 'use a common word' });
    reviews.get('ko-KR')!.rows.delete(id('cash'));
    // Text edited after its review: the old verdict no longer counts.
    translations.get('th-TH')!.rows.get(id('coin'))!.meaningText = 'edited';
    const plan = buildLoadPlan(spec, lexicon, entries, LOCALES, translations, noRanks, approved(entries), reviews);
    expect(plan.report).toMatchObject({ meanings: 1, missingRequiredLocale: 3 });
    expect(plan.report.translationRejected).toMatchObject({ 'ja-JP': 1, 'en-US': 0 });
    expect(plan.report.translationUnreviewed).toMatchObject({ 'ko-KR': 1, 'th-TH': 1 });
    expect(plan.meanings.map((m) => m.lemma)).toEqual(['price']);
  });

  it('serves loaded content to a learner', async () => {
    const entries = generated();
    await loadPlan(h.db, planOf(entries, translated(entries), approved(entries)), true);
    const auth = await h.token('learner');
    const api = (method: 'get' | 'post' | 'put', path: string) => h.http()[method](path).set('Authorization', `Bearer ${auth}`);
    const { collections } = (await api('get', '/v1/catalog/collections').expect(200)).body;
    const collection = collections.find((c: { slug: string }) => c.slug === spec.slug);
    expect(collection).toBeDefined();
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'A1' }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: collection.id, topicIds: [collection.topics[0].id] }).expect(200);
    const plan = (await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});
