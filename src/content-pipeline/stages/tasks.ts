import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EntryReview, GeneratedEntry, RankedLemma, TranslatedMeaning } from '../build.types';
import { CollectionSpec } from '../collections/collection.types';
import { chunk, JsonlStore, readJson } from '../jsonl';
import { Lexicon } from '../lexicon/lexicon.types';
import { collectionDir, LEXICON_FILE } from '../paths';
import { currentEntries, generatedPath, generateInput, generateInstructions, generateSchema, pendingEntries, selectEntries, siblingsOf, toGeneratedEntry } from './generate';
import {
  fixRequests, pendingReviews, rejectedKeys, ReviewGroup, reviewGroups, reviewInput, reviewInstructions, reviewProblems, reviewSchema, reviewsPath, toReviews,
} from './review';
import { CLASH_LOCALE, clashProblems, translationClashes } from './clashes';
import { LemmaGroup, lemmaGroups, pendingRanks, rankInput, rankInstructions, rankProblems, ranksPath, rankSchema } from './rank';
import {
  catalogInput, catalogInstructions, catalogSchema, meaningInstructions, meaningSchema, PendingMeaning, pendingTranslations, staleCatalogLocales,
  translationInput, translationsPath, translationStores, writeCatalogs,
} from './translate';

const UPGRADE_NOTE = 'rules changed: previous was written under older rules. Redo the entry under the current instructions; copy the gloss, definition and examples of any meaning that stays the same word for word.';

/** Who wrote the AI output; the work is done by Claude Code reading task files, not by an API call. */
export const AUTHOR = 'claude-code';

type TaskKind = 'generate' | 'review' | 'rank' | 'translate' | 'catalog';

/** One unit of AI work: read `instructions` and `input`, write JSON matching `outputSchema` to `output`. */
export interface TaskFile {
  id: string;
  kind: TaskKind;
  collection: string;
  locales: string[];
  promptVersion: number;
  instructions: string;
  outputSchema: unknown;
  output: string;
  input: unknown;
}

type GenerateInput = ReturnType<typeof generateInput>;
type TranslateInput = ReturnType<typeof translationInput>;
type RankInput = ReturnType<typeof rankInput>;
type ReviewInput = ReturnType<typeof reviewInput>;

export const tasksDir = (spec: CollectionSpec) => join(collectionDir(spec.slug), 'tasks');
const outputName = (id: string) => `${id}.out.json`;

function openTasks(spec: CollectionSpec): TaskFile[] {
  const dir = tasksDir(spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.out.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as TaskFile);
}

function writeTasks(spec: CollectionSpec, prefix: string, tasks: Omit<TaskFile, 'id' | 'output'>[]) {
  const dir = tasksDir(spec);
  mkdirSync(dir, { recursive: true });
  const taken = new Set(readdirSync(dir));
  let n = 0;
  return tasks.map((task) => {
    let id: string;
    do { n += 1; id = `${prefix}-${String(n).padStart(4, '0')}`; } while (taken.has(`${id}.json`));
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ id, output: outputName(id), ...task }, null, 2)}\n`);
    return id;
  });
}

export interface ExportOptions { batchSize: number; limit?: number; only?: string[]; force: boolean; retryIssues: boolean; fixesOnly?: boolean }

/** Writes task files for work not done and not already waiting in an open task. */
export function exportTasks(spec: CollectionSpec, kind: 'generate' | 'review' | 'rank' | 'translate', options: ExportOptions) {
  const open = openTasks(spec);
  if (kind === 'generate') {
    const waiting = new Set(open.filter((t) => t.kind === 'generate').flatMap((t) => (t.input as GenerateInput).entries.map((e) => e.key)));
    const lexicon = readJson<Lexicon>(LEXICON_FILE);
    const store = new JsonlStore<GeneratedEntry>(generatedPath(spec));
    const reviews = new JsonlStore<EntryReview>(reviewsPath(spec));
    const clashes = clashProblems(translationClashes(currentEntries(spec, lexicon, store), new JsonlStore<TranslatedMeaning>(translationsPath(spec, CLASH_LOCALE))));
    const rejected = new Set([...rejectedKeys(store, reviews), ...clashes.keys()]);
    const all = pendingEntries(spec, lexicon, store, options, rejected)
      .filter((e) => !waiting.has(e.key) && (!options.fixesOnly || rejected.has(e.key)));
    // A limit never splits a word: the reviewer needs every part of speech to judge it.
    const lemmas = new Set(all.slice(0, options.limit).map((e) => e.lemma));
    const pending = all.filter((e) => lemmas.has(e.lemma));
    const siblings = siblingsOf(spec, lexicon);
    // An entry from an older prompt is redone under the new rules, keeping the wording of meanings that stay, so their
    // translations (tied to the English by hash) are reused.
    const upgrades = new Map<string, string[]>(pending.flatMap((e): [string, string[]][] => {
      const old = store.rows.get(e.key);
      return old && old.promptVersion !== spec.promptVersion && old.meanings.length ? [[e.key, [UPGRADE_NOTE]]] : [];
    }));
    const fixes = fixRequests(store, reviews, pending.map((e) => e.key), new Map([...upgrades, ...clashes]), new Map(lexicon.entries.map((e) => [e.key, e])));
    const ids = writeTasks(spec, 'gen', chunk(pending, options.batchSize).map((batch) => ({
      kind: 'generate', collection: spec.slug, locales: [], promptVersion: spec.promptVersion,
      instructions: generateInstructions(spec), outputSchema: z.toJSONSchema(generateSchema(spec)), input: generateInput(spec, batch, siblings, fixes),
    })));
    console.log(`generate: ${pending.length} entries (${fixes.size} to fix after review) in ${ids.length} new tasks, ${waiting.size} already waiting`);
    return;
  }

  if (kind === 'review') {
    const waiting = new Set(open.filter((t) => t.kind === 'review').flatMap((t) => (t.input as ReviewInput).words.map((w) => w.lemma)));
    const generated = new JsonlStore<GeneratedEntry>(generatedPath(spec));
    const lexicon = readJson<Lexicon>(LEXICON_FILE);
    const reviews = new JsonlStore<EntryReview>(reviewsPath(spec));
    const ready = completeGroups(spec, lexicon, reviewGroups(spec, generated));
    const chosen = options.only ? ready.filter((g) => g.entries.some((e) => options.only!.includes(e.key))) : ready;
    const groups = (options.force ? chosen : pendingReviews(chosen, reviews)).filter((g) => !waiting.has(g.lemma)).slice(0, options.limit);
    const ids = writeTasks(spec, 'rev', chunk(groups, options.batchSize).map((batch) => ({
      kind: 'review', collection: spec.slug, locales: [], promptVersion: spec.promptVersion,
      instructions: reviewInstructions, outputSchema: z.toJSONSchema(reviewSchema), input: reviewInput(spec, lexicon, batch),
    })));
    console.log(`review: ${groups.length} words in ${ids.length} new tasks, ${waiting.size} already waiting`);
    return;
  }

  if (kind === 'rank') {
    const waiting = new Set(open.filter((t) => t.kind === 'rank').flatMap((t) => (t.input as RankInput).words.map((w) => w.lemma)));
    const groups = currentGroups(spec).filter((g) => !options.only || g.meanings.some(({ entry }) => options.only!.includes(entry.key)));
    const candidates = options.force ? groups.filter((g) => g.meanings.length > 1) : pendingRanks(groups, new JsonlStore<RankedLemma>(ranksPath(spec)));
    const pending = candidates.filter((g) => !waiting.has(g.lemma)).slice(0, options.limit);
    const ids = writeTasks(spec, 'rank', chunk(pending, options.batchSize).map((batch) => ({
      kind: 'rank', collection: spec.slug, locales: [], promptVersion: spec.promptVersion,
      instructions: rankInstructions, outputSchema: z.toJSONSchema(rankSchema), input: rankInput(batch),
    })));
    console.log(`rank: ${pending.length} words in ${ids.length} new tasks, ${waiting.size} already waiting`);
    return;
  }

  const staleCatalog = staleCatalogLocales(spec);
  if (staleCatalog.length > 0 && !open.some((t) => t.kind === 'catalog')) {
    writeTasks(spec, 'cat', [{
      kind: 'catalog', collection: spec.slug, locales: staleCatalog, promptVersion: spec.promptVersion,
      instructions: catalogInstructions(staleCatalog), outputSchema: z.toJSONSchema(catalogSchema), input: catalogInput(spec, staleCatalog),
    }]);
  }
  const waiting = new Set(open.filter((t) => t.kind === 'translate').flatMap((t) => (t.input as TranslateInput).meanings.map((m) => m.id)));
  const pending = pendingTranslations(spec, translationStores(spec)).filter(({ m }) => !waiting.has(m.meaningId)).slice(0, options.limit);
  // Meanings missing the same locales share a task, so finished locales are not translated again.
  const groups = new Map<string, PendingMeaning[]>();
  for (const p of pending) groups.set(p.missing.join(','), [...(groups.get(p.missing.join(',')) ?? []), p]);
  const tasks = [...groups.entries()].flatMap(([key, items]) => chunk(items, options.batchSize).map((batch) => {
    const locales = key.split(',');
    return {
      kind: 'translate' as const, collection: spec.slug, locales, promptVersion: spec.promptVersion,
      instructions: meaningInstructions(locales), outputSchema: z.toJSONSchema(meaningSchema), input: translationInput(locales, batch),
    };
  }));
  const ids = writeTasks(spec, 'tr', tasks);
  console.log(`translate: ${pending.length} meanings in ${ids.length} new tasks, ${waiting.size} already waiting${staleCatalog.length ? `, catalog for ${staleCatalog.length} locales` : ''}`);
}

/** Problems that keep a translate output from being stored; every asked locale must be complete. */
function translateProblems(task: TaskFile, out: z.infer<typeof meaningSchema>) {
  const byId = new Map(out.meanings.map((m) => [m.id, m]));
  return (task.input as TranslateInput).meanings.flatMap((asked) => {
    const got = byId.get(asked.id);
    if (!got) return [`${asked.id}: missing`];
    return task.locales.flatMap((locale) => {
      const t = got.translations.find((x) => x.locale === locale);
      if (!t) return [`${asked.id} ${locale}: missing`];
      if (!t.meaningText.trim() || !t.definitionText.trim()) return [`${asked.id} ${locale}: empty text`];
      if (t.exampleTranslations.length !== asked.examples.length || t.exampleTranslations.some((x) => !x.trim())) {
        return [`${asked.id} ${locale}: ${t.exampleTranslations.length} example translations for ${asked.examples.length} examples`];
      }
      return [];
    });
  });
}

/** Reads every finished task output, validates it, stores the result and removes the task. Bad outputs stay for a fix. */
export function ingestTasks(spec: CollectionSpec) {
  const dir = tasksDir(spec);
  const tasks = openTasks(spec).filter((t) => existsSync(join(dir, t.output)));
  const lexicon = tasks.some((t) => t.kind === 'generate') ? readJson<Lexicon>(LEXICON_FILE) : null;
  const generated = new JsonlStore<GeneratedEntry>(generatedPath(spec));
  const stores = translationStores(spec);
  let stored = 0;
  const failures: string[] = [];

  for (const task of tasks) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, task.output), 'utf8')) as unknown;
      if (task.kind === 'generate') stored += ingestGenerate(spec, lexicon!, generated, task, raw);
      else if (task.kind === 'translate') stored += ingestTranslate(spec, stores, task, raw);
      else if (task.kind === 'rank') stored += ingestRank(spec, task, raw);
      else if (task.kind === 'review') stored += ingestReview(spec, task, raw);
      else { writeCatalogs(spec, catalogSchema.parse(raw)); stored += task.locales.length; }
      rmSync(join(dir, `${task.id}.json`));
      rmSync(join(dir, task.output));
    } catch (error) {
      failures.push(`${task.id}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  }
  console.log(`ingested ${tasks.length - failures.length}/${tasks.length} task outputs (${stored} rows), ${openTasks(spec).length} tasks still open`);
  for (const failure of failures) console.log(`  failed ${failure}`);
}

/** Words whose every selected part of speech is generated under the current prompt; a partial word would look incomplete. */
function completeGroups(spec: CollectionSpec, lexicon: Lexicon, groups: ReviewGroup[]) {
  const wanted = new Map<string, number>();
  for (const e of selectEntries(spec, lexicon)) wanted.set(e.lemma, (wanted.get(e.lemma) ?? 0) + 1);
  return groups.filter((g) => g.entries.length === wanted.get(g.lemma));
}

/** The groups a review task asked about, as they are now; an entry edited since then gets no verdict. */
function askedReviewGroups(spec: CollectionSpec, task: TaskFile): ReviewGroup[] {
  const asked = new Map((task.input as ReviewInput).words.map((w) => [w.lemma, new Set(w.entries.map((e) => e.key))]));
  return reviewGroups(spec, new JsonlStore<GeneratedEntry>(generatedPath(spec)))
    .filter((g) => asked.has(g.lemma))
    .map((g) => ({ ...g, entries: g.entries.filter((e) => asked.get(g.lemma)!.has(e.key)) }));
}

function ingestReview(spec: CollectionSpec, task: TaskFile, raw: unknown) {
  const out = reviewSchema.parse(raw);
  const groups = askedReviewGroups(spec, task);
  const problems = reviewProblems(groups, out);
  if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
  const rows = toReviews(groups, out, AUTHOR);
  new JsonlStore<EntryReview>(reviewsPath(spec)).append(rows);
  return rows.length;
}

function currentGroups(spec: CollectionSpec) {
  const lexicon = readJson<Lexicon>(LEXICON_FILE);
  return lemmaGroups(currentEntries(spec, lexicon), lexicon);
}

const askedGroups = (spec: CollectionSpec, task: TaskFile): LemmaGroup[] => {
  const asked = new Set((task.input as RankInput).words.map((w) => w.lemma));
  return currentGroups(spec).filter((g) => asked.has(g.lemma));
};

function ingestRank(spec: CollectionSpec, task: TaskFile, raw: unknown) {
  const out = rankSchema.parse(raw);
  const groups = askedGroups(spec, task);
  const problems = rankProblems(groups, out);
  if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
  const byLemma = new Map(out.words.map((w) => [w.lemma, w]));
  // rankProblems already required every current meaning, so the stored hash matches what was ranked.
  const rows = groups.map((g): RankedLemma => ({
    key: g.lemma, sourceHash: g.sourceHash, model: AUTHOR,
    frequencies: Object.fromEntries(byLemma.get(g.lemma)!.meanings.map((x) => [x.id, x.frequency])),
  }));
  new JsonlStore<RankedLemma>(ranksPath(spec)).append(rows);
  return rows.length;
}

function ingestGenerate(spec: CollectionSpec, lexicon: Lexicon, store: JsonlStore<GeneratedEntry>, task: TaskFile, raw: unknown) {
  if (task.promptVersion !== spec.promptVersion) throw new Error(`made for prompt version ${task.promptVersion}, spec is ${spec.promptVersion}`);
  const { entries } = generateSchema(spec).parse(raw);
  const asked = new Set((task.input as GenerateInput).entries.map((e) => e.key));
  const byKey = new Map(lexicon.entries.map((e) => [e.key, e]));
  const rows = entries.filter((e) => asked.has(e.key) && byKey.has(e.key))
    .map((output) => toGeneratedEntry(spec, lexicon, byKey.get(output.key)!, output, store.rows.get(output.key), AUTHOR));
  const missing = [...asked].filter((k) => !rows.some((r) => r.key === k));
  if (missing.length) throw new Error(`no output for ${missing.join(', ')}`);
  store.append(rows);
  return rows.length;
}

function ingestTranslate(spec: CollectionSpec, stores: Map<string, JsonlStore<TranslatedMeaning>>, task: TaskFile, raw: unknown) {
  const out = meaningSchema.parse(raw);
  const problems = translateProblems(task, out);
  if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
  // English that changed after the task was written has a new hash; such meanings are left for the next export.
  const current = new Map(pendingTranslations(spec, stores).map((p) => [p.m.meaningId, p]));
  let rows = 0;
  for (const locale of task.locales) {
    const store = stores.get(locale)!;
    store.append(out.meanings.flatMap((m): TranslatedMeaning[] => {
      const source = current.get(m.id);
      const t = m.translations.find((x) => x.locale === locale)!;
      if (!source || !source.missing.includes(locale)) return [];
      return [{
        key: m.id, meaningId: m.id, sourceHash: source.sourceHash, meaningText: t.meaningText.trim(), definitionText: t.definitionText.trim(),
        exampleTranslations: t.exampleTranslations.map((x) => x.trim()), model: AUTHOR,
      }];
    }));
    rows += out.meanings.length;
  }
  return rows;
}

/** Validates one task output without storing it, so the writer can fix issues before ingest. */
export function checkTask(spec: CollectionSpec, id: string) {
  const dir = tasksDir(spec);
  const task = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as TaskFile;
  const raw = JSON.parse(readFileSync(join(dir, task.output), 'utf8')) as unknown;
  const problems: string[] = [];
  if (task.kind === 'catalog') {
    const out = catalogSchema.parse(raw);
    for (const locale of task.locales) {
      const t = out.translations.find((x) => x.locale === locale);
      if (!t) { problems.push(`${locale}: missing`); continue; }
      for (const topic of spec.topics) if (!t.topics.some((x) => x.slug === topic.slug && x.title.trim())) problems.push(`${locale} ${topic.slug}: missing`);
    }
  } else if (task.kind === 'translate') {
    problems.push(...translateProblems(task, meaningSchema.parse(raw)));
  } else if (task.kind === 'rank') {
    problems.push(...rankProblems(askedGroups(spec, task), rankSchema.parse(raw)));
  } else if (task.kind === 'review') {
    problems.push(...reviewProblems(askedReviewGroups(spec, task), reviewSchema.parse(raw)));
  } else {
    const lexicon = readJson<Lexicon>(LEXICON_FILE);
    const byKey = new Map(lexicon.entries.map((e) => [e.key, e]));
    const { entries } = generateSchema(spec).parse(raw);
    const asked = (task.input as GenerateInput).entries.map((e) => e.key);
    problems.push(...asked.filter((k) => !entries.some((e) => e.key === k)).map((k) => `${k}: missing`));
    for (const output of entries) {
      const entry = byKey.get(output.key);
      if (!entry) { problems.push(`${output.key}: not in this task`); continue; }
      const row = toGeneratedEntry(spec, lexicon, entry, output, undefined, AUTHOR);
      row.meanings.forEach((m, i) => { for (const issue of row.issues[m.meaningId] ?? []) problems.push(`${output.key} meaning ${i + 1}: ${issue}`); });
    }
  }
  console.log(problems.length ? `${id}:\n  ${problems.join('\n  ')}` : `${id}: ok`);
}
