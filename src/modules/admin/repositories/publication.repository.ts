import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB, Db, Executor } from '../../../db/db';
import { activeMeaningPublications, exampleLocalizations, meaningLocalizations } from '../../../db/schema';
import { MeaningSnapshot } from '../../practice-resolver/task.types';

const snapshotShape = (locale: string) => ({
  columns: { id: true, cefrLevel: true },
  with: {
    localizations: { where: eq(meaningLocalizations.locale, locale) },
    examples: {
      columns: { sourceText: true, targetLocator: true },
      with: { localizations: { where: eq(exampleLocalizations.locale, locale), columns: { translationText: true } } },
    },
    pronunciations: { columns: { id: true, accentLocale: true, ipa: true, audioAssetKey: true } },
    type: {
      columns: { id: true, partOfSpeech: true },
      with: { word: { columns: { id: true, lemma: true } } },
    },
  },
} as const);

export interface SnapshotSource {
  id: string;
  cefrLevel: string | null;
  localizations: { meaningText: string; definitionText: string; editorialState: string }[];
  examples: { sourceText: string; targetLocator: Record<string, unknown>; localizations: { translationText: string }[] }[];
  pronunciations: { id: string; accentLocale: string; ipa: string | null; audioAssetKey: string | null }[];
  type: { id: string; partOfSpeech: string; word: { id: string; lemma: string } };
}

@Injectable()
export class PublicationRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findMeaningForSnapshot(meaningId: string, locale: string, executor: Executor = this.db): Promise<SnapshotSource | undefined> {
    return executor.query.meanings.findFirst({ where: (m) => eq(m.id, meaningId), ...snapshotShape(locale) });
  }

  findMeaningsForSnapshot(meaningIds: string[], locale: string, executor: Executor = this.db): Promise<SnapshotSource[]> {
    return executor.query.meanings.findMany({ where: (m) => inArray(m.id, meaningIds), ...snapshotShape(locale) });
  }

  // Revision and pointer move in one statement so concurrent publishes cannot share a revision.
  async insertRevision(
    row: { publicationId: string; meaningId: string; locale: string; snapshot: MeaningSnapshot; now: Date },
    executor: Executor = this.db,
  ) {
    const { publicationId, meaningId, locale, snapshot, now } = row;
    const { rows: [inserted] } = await executor.execute<{ revision: number }>(sql`
      WITH next AS (
        SELECT COALESCE(max(revision), 0) + 1 AS revision
        FROM meaning_publications WHERE meaning_id = ${meaningId}::uuid AND locale = ${locale}
      ), publication AS (
        INSERT INTO meaning_publications (id, meaning_id, locale, revision, snapshot, approved_at, published_at)
        SELECT ${publicationId}::uuid, ${meaningId}::uuid, ${locale}::varchar, revision, ${JSON.stringify(snapshot)}::jsonb,
               ${now}::timestamptz, ${now}::timestamptz
        FROM next
        RETURNING id, meaning_id, locale, revision
      ), pointer AS (
        INSERT INTO active_meaning_publications (meaning_id, locale, publication_id)
        SELECT meaning_id, locale, id FROM publication
        ON CONFLICT (meaning_id, locale) DO UPDATE SET publication_id = EXCLUDED.publication_id, recalled_at = NULL
      )
      SELECT revision FROM publication`);
    return inserted.revision;
  }

  async recall(meaningId: string, locale: string, recalledAt: Date) {
    const recalled = await this.db
      .update(activeMeaningPublications)
      .set({ recalledAt })
      .where(and(
        eq(activeMeaningPublications.meaningId, meaningId),
        eq(activeMeaningPublications.locale, locale),
        isNull(activeMeaningPublications.recalledAt),
      ))
      .returning({ meaningId: activeMeaningPublications.meaningId });
    return recalled.length > 0;
  }
}
