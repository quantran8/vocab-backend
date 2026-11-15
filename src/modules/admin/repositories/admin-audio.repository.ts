import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DEFAULT_ACCENT } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { GenerateAudio } from '../dto/admin.schemas';

export interface AudioTarget { id: string; wordId: string; lemma: string; hasAudio: boolean }

const idsIn = (ids: string[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`;

// Only the default accent: the configured voice speaks that accent and audioKey is per accent.
@Injectable()
export class AdminAudioRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async status() {
    const { rows: [row] } = await this.db.execute<{ missing: number; withAudio: number; staleLivePublications: number }>(sql`
      SELECT
        count(*) FILTER (WHERE audio_asset_key IS NULL)::int AS missing,
        count(*) FILTER (WHERE audio_asset_key IS NOT NULL)::int AS "withAudio",
        (SELECT count(*)::int
         FROM active_meaning_publications a
         JOIN meaning_publications p ON p.id = a.publication_id
         JOIN meanings m ON m.id = a.meaning_id
         JOIN pronunciations pr ON pr.type_id = m.type_id AND pr.accent_locale = ${DEFAULT_ACCENT} AND pr.audio_asset_key IS NOT NULL
         WHERE a.recalled_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p.snapshot->'pronunciations') e
           WHERE e->>'id' = pr.id::text AND e->>'audioUrl' = pr.audio_asset_key)) AS "staleLivePublications"
      FROM pronunciations WHERE accent_locale = ${DEFAULT_ACCENT}`);
    return row;
  }

  /** The batch to voice, plus how many default-accent pronunciations still lack audio. */
  async targets({ pronunciationIds, wordIds, overwrite, limit }: GenerateAudio) {
    const { rows: [row] } = await this.db.execute<{ missing: number; items: AudioTarget[] }>(sql`
      WITH picked AS (
        SELECT pr.id, wt.word_id AS "wordId", w.lemma, pr.audio_asset_key IS NOT NULL AS "hasAudio"
        FROM pronunciations pr
        JOIN word_types wt ON wt.id = pr.type_id
        JOIN words w ON w.id = wt.word_id
        WHERE pr.accent_locale = ${DEFAULT_ACCENT}
          AND ${pronunciationIds ? sql`pr.id IN ${idsIn(pronunciationIds)}` : sql`true`}
          AND ${wordIds ? sql`w.id IN ${idsIn(wordIds)}` : sql`true`}
          AND (${overwrite}::boolean OR pr.audio_asset_key IS NULL)
        ORDER BY lower(btrim(w.lemma)), pr.id
        LIMIT ${limit}
      )
      SELECT
        (SELECT count(*)::int FROM pronunciations WHERE accent_locale = ${DEFAULT_ACCENT} AND audio_asset_key IS NULL) AS missing,
        COALESCE((SELECT jsonb_agg(picked ORDER BY lower(btrim(picked.lemma)), picked.id) FROM picked), '[]') AS items`);
    return row;
  }

  /** One statement for the batch; without overwrite a row filled meanwhile (by the worker) is kept. */
  async setAudio(rows: { id: string; url: string }[], overwrite: boolean) {
    if (rows.length === 0) return new Set<string>();
    const { rows: updated } = await this.db.execute<{ id: string }>(sql`
      UPDATE pronunciations pr SET audio_asset_key = x.url
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id uuid, url text)
      WHERE pr.id = x.id AND (${overwrite}::boolean OR pr.audio_asset_key IS NULL)
      RETURNING pr.id`);
    return new Set(updated.map((r) => r.id));
  }
}
