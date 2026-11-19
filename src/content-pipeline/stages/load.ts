import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { EDITORIAL_STATE } from '../../common/constants/domain';
import { Db } from '../../db/db';
import * as schema from '../../db/schema';
import { PublicationRepository } from '../../modules/admin/repositories/publication.repository';
import { toMeaningSnapshot } from '../../modules/admin/services/publication.service';
import { MeaningSnapshot } from '../../modules/practice-resolver/task.types';
import { EntryReview, RankedLemma, TranslatedMeaning } from '../build.types';
import { CollectionSpec } from '../collections/collection.types';
import { JsonlStore, readJson } from '../jsonl';
import { Lexicon } from '../lexicon/lexicon.types';
import { collectionDir, LEXICON_FILE } from '../paths';
import { publishSnapshots, writeContent } from './content-load.repository';
import { currentEntries } from './generate';
import { ranksPath } from './rank';
import { reviewsPath } from './review';
import { buildLoadPlan, LoadPlan, REQUIRED_LOCALES } from './load-plan';
import { translationsPath } from './translate';

export function planFromBuild(spec: CollectionSpec, locales: readonly string[] = REQUIRED_LOCALES): LoadPlan {
  const lexicon = readJson<Lexicon>(LEXICON_FILE);
  const entries = currentEntries(spec, lexicon);
  const translations = new Map(locales.map((l) => [l, new JsonlStore<TranslatedMeaning>(translationsPath(spec, l))]));
  return buildLoadPlan(spec, lexicon, entries, [...locales], translations, new JsonlStore<RankedLemma>(ranksPath(spec)), new JsonlStore<EntryReview>(reviewsPath(spec)));
}

/** Writes the plan in one transaction. With `publish`, localizations are approved and every changed snapshot gets a revision. */
export async function loadPlan(db: Db, plan: LoadPlan, publish: boolean, now = new Date()) {
  const editorialState = publish ? EDITORIAL_STATE.APPROVED : EDITORIAL_STATE.DRAFT;
  const publications = new PublicationRepository(db);
  return db.transaction(async (tx) => {
    const written = await writeContent(tx, plan, editorialState);
    const published: Record<string, number> = {};
    const rejected: { meaningId: string; locale: string; reason: string }[] = [];
    if (publish) {
      const locales = [...new Set(plan.meanings.flatMap((m) => m.localizations.map((l) => l.locale)))];
      for (const locale of locales) {
        const ids = plan.meanings.filter((m) => m.localizations.some((l) => l.locale === locale)).map((m) => m.meaningId);
        const sources = await publications.findMeaningsForSnapshot(ids, locale, tx);
        const snapshots: MeaningSnapshot[] = sources.flatMap((source) => {
          try {
            return [toMeaningSnapshot(source)];
          } catch (error) {
            rejected.push({ meaningId: source.id, locale, reason: error instanceof Error ? error.message : String(error) });
            return [];
          }
        });
        published[locale] = await publishSnapshots(tx, locale, snapshots, now);
      }
    }
    return { ...written, published, rejected };
  });
}

export interface LoadOptions { publish: boolean; dryRun: boolean }

export async function load(spec: CollectionSpec, options: LoadOptions) {
  const plan = planFromBuild(spec);
  const linked = plan.topics.reduce((n, t) => n + t.meaningIds.length, 0);
  console.log(`load ${spec.slug}:`, JSON.stringify(plan.report), `→ ${plan.meanings.length} meanings, ${linked} topic links`);
  if (options.dryRun) return;

  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const result = await loadPlan(drizzle(pool, { schema }), plan, options.publish);
    mkdirSync(collectionDir(spec.slug), { recursive: true });
    writeFileSync(join(collectionDir(spec.slug), 'load-report.json'), `${JSON.stringify({ at: new Date().toISOString(), report: plan.report, ...result }, null, 2)}\n`);
    console.log(`loaded: ${result.words} new words, published ${JSON.stringify(result.published)}, ${result.rejected.length} rejected by publish rules`);
  } finally {
    await pool.end();
  }
}
