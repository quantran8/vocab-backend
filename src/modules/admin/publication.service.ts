import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { CEFR_LEVELS, EDITORIAL_STATE } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { newId } from '../../common/ids';
import { DB, Db } from '../../db/db';
import { activeMeaningPublications } from '../../db/schema';
import { MeaningSnapshot } from '../practice-resolver/task.types';

const reject = (message: string) => new ApiError('PUBLICATION_INVALID', message);

@Injectable()
export class PublicationService {
  constructor(@Inject(DB) private readonly db: Db, private readonly clock: Clock) {}

  async publish(meaningId: string, locale: string) {
    const snapshot = await this.buildSnapshot(meaningId, locale);
    const now = this.clock.now();
    const publicationId = newId();

    // Revision and pointer move in one statement so concurrent publishes cannot share a revision.
    const { rows: [row] } = await this.db.execute<{ revision: number }>(sql`
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
    return { publicationId, meaningId, locale, revision: row.revision };
  }

  async recall(meaningId: string, locale: string) {
    const recalled = await this.db
      .update(activeMeaningPublications)
      .set({ recalledAt: this.clock.now() })
      .where(and(
        eq(activeMeaningPublications.meaningId, meaningId),
        eq(activeMeaningPublications.locale, locale),
        isNull(activeMeaningPublications.recalledAt),
      ))
      .returning({ meaningId: activeMeaningPublications.meaningId });
    if (recalled.length === 0) throw new ApiError('NOT_FOUND', 'No active publication');
    return { meaningId, locale, recalled: true };
  }

  private async buildSnapshot(meaningId: string, locale: string): Promise<MeaningSnapshot> {
    const meaning = await this.db.query.meanings.findFirst({
      where: (m) => eq(m.id, meaningId),
      columns: { id: true, cefrLevel: true },
      with: {
        localizations: { where: (l) => eq(l.locale, locale) },
        examples: {
          columns: { sourceText: true, targetLocator: true },
          with: { localizations: { where: (l) => eq(l.locale, locale), columns: { translationText: true } } },
        },
        type: {
          columns: { id: true, partOfSpeech: true },
          with: {
            word: { columns: { id: true, lemma: true } },
            pronunciations: { columns: { id: true, accentLocale: true, ipa: true, audioAssetKey: true } },
          },
        },
      },
    });
    if (!meaning) throw new ApiError('NOT_FOUND', 'Meaning not found');

    const localization = meaning.localizations[0];
    if (!meaning.cefrLevel || !(CEFR_LEVELS as readonly string[]).includes(meaning.cefrLevel)) throw reject('CEFR level missing');
    if (!localization?.meaningText.trim() || !localization.definitionText.trim()) throw reject('Localized meaning or definition missing');
    if (localization.editorialState !== EDITORIAL_STATE.APPROVED) throw reject('Localization is not approved');

    const pronunciations = meaning.type.pronunciations;
    if (pronunciations.length === 0 || pronunciations.some((p) => !p.ipa?.trim())) throw reject('IPA missing');

    const examples = meaning.examples.flatMap((e) => {
      const translation = e.localizations[0]?.translationText;
      return translation?.trim() && hasValidHighlight(e.sourceText, e.targetLocator)
        ? [{ text: e.sourceText, translation, targetLocator: e.targetLocator }]
        : [];
    });
    if (examples.length === 0) throw reject('No usable localized example');

    const { word, ...type } = meaning.type;
    return {
      wordId: word.id,
      lemma: word.lemma,
      typeId: type.id,
      partOfSpeech: type.partOfSpeech,
      meaningId: meaning.id,
      cefrLevel: meaning.cefrLevel,
      meaningText: localization.meaningText,
      definitionText: localization.definitionText,
      pronunciations: pronunciations.map((p) => ({ id: p.id, accentLocale: p.accentLocale, ipa: p.ipa!, audioUrl: p.audioAssetKey })),
      examples,
    };
  }
}

function hasValidHighlight(text: string, locator: unknown) {
  const { start, end } = (locator ?? {}) as { start?: unknown; end?: unknown };
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (start as number) < (end as number) && (end as number) <= text.length;
}
