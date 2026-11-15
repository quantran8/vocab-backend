import { Inject, Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { DEFAULT_ACCENT } from '../../../common/constants/domain';
import { DB, Db, toDate } from '../../../db/db';
import { GenerateAudio, ListAudioMissing, ListAudioStale, PublicationKey } from '../dto/admin.schemas';

export interface AudioTarget { id: string; meaningId: string; wordId: string; lemma: string; ipa: string; hasAudio: boolean }

const idsIn = (ids: string[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`;
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

// A snapshot pronunciation whose IPA or audio differs from the row's current one. A cleared value never goes live this way.
const outdatedAudio = (snapshot: SQL) => sql`
  jsonb_array_elements(${snapshot}->'pronunciations') e
  JOIN pronunciations pr ON pr.id = (e->>'id')::uuid
  WHERE (pr.audio_asset_key IS NOT NULL AND e->>'audioUrl' IS DISTINCT FROM pr.audio_asset_key)
     OR (pr.ipa IS NOT NULL AND e->>'ipa' IS DISTINCT FROM pr.ipa)`;

/** Live (not recalled) publications showing an older IPA or playing older (or no) audio. */
const stalePublications = sql`
  SELECT a.meaning_id, a.locale, p.id AS publication_id
  FROM active_meaning_publications a
  JOIN meaning_publications p ON p.id = a.publication_id
  WHERE a.recalled_at IS NULL AND EXISTS (SELECT 1 FROM ${outdatedAudio(sql`p.snapshot`)})`;

// Generation covers only the default accent (the configured voice speaks it) and only rows with IPA, which is what is voiced.
@Injectable()
export class AdminAudioRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async status() {
    const { rows: [row] } = await this.db.execute<{ missing: number; missingIpa: number; withAudio: number; staleLivePublications: number }>(sql`
      SELECT
        count(*) FILTER (WHERE audio_asset_key IS NULL AND ipa IS NOT NULL)::int AS missing,
        count(*) FILTER (WHERE audio_asset_key IS NULL AND ipa IS NULL)::int AS "missingIpa",
        count(*) FILTER (WHERE audio_asset_key IS NOT NULL)::int AS "withAudio",
        (SELECT count(*)::int FROM (${stalePublications}) s) AS "staleLivePublications"
      FROM pronunciations WHERE accent_locale = ${DEFAULT_ACCENT}`);
    return row;
  }

  async listMissing({ q, limit, offset }: ListAudioMissing) {
    const { rows: [page] } = await this.db.execute<{
      total: number;
      items: {
        pronunciationId: string; meaningId: string; wordId: string; lemma: string; homographKey: string | null; partOfSpeech: string;
        ipa: string | null; definition: string | null; isPrivate: boolean; live: boolean;
      }[];
    }>(sql`
      WITH filtered AS (
        SELECT pr.id, pr.meaning_id, pr.ipa, m.core_definition, m.owner_user_id, wt.word_id, wt.part_of_speech, w.lemma, w.homograph_key
        FROM pronunciations pr
        JOIN meanings m ON m.id = pr.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        JOIN words w ON w.id = wt.word_id
        WHERE pr.accent_locale = ${DEFAULT_ACCENT} AND pr.audio_asset_key IS NULL
          AND ${q ? sql`lower(btrim(w.lemma)) LIKE ${`${escapeLike(q.toLowerCase())}%`}` : sql`true`}
      ), page AS (
        SELECT * FROM filtered ORDER BY lower(btrim(lemma)), id LIMIT ${limit} OFFSET ${offset}
      )
      SELECT (SELECT count(*)::int FROM filtered) AS total,
        COALESCE(jsonb_agg(jsonb_build_object(
          'pronunciationId', p.id, 'meaningId', p.meaning_id, 'wordId', p.word_id, 'lemma', p.lemma, 'homographKey', p.homograph_key,
          'partOfSpeech', p.part_of_speech, 'ipa', p.ipa, 'definition', p.core_definition, 'isPrivate', p.owner_user_id IS NOT NULL,
          'live', EXISTS (SELECT 1 FROM active_meaning_publications a WHERE a.meaning_id = p.meaning_id AND a.recalled_at IS NULL)
        ) ORDER BY lower(btrim(p.lemma)), p.id), '[]') AS items
      FROM page p`);
    return page;
  }

  async listStale({ limit, offset }: ListAudioStale) {
    const { rows: [page] } = await this.db.execute<{
      total: number;
      items: { meaningId: string; locale: string; wordId: string; lemma: string; partOfSpeech: string; meaningText: string; revision: number; publishedAt: string }[];
    }>(sql`
      WITH stale AS (${stalePublications}),
      page AS (
        SELECT s.meaning_id, s.locale, p.revision, p.published_at,
          p.snapshot->>'wordId' AS word_id, p.snapshot->>'lemma' AS lemma, p.snapshot->>'partOfSpeech' AS pos, p.snapshot->>'meaningText' AS meaning_text
        FROM stale s JOIN meaning_publications p ON p.id = s.publication_id
        ORDER BY lower(p.snapshot->>'lemma'), s.meaning_id, s.locale LIMIT ${limit} OFFSET ${offset}
      )
      SELECT (SELECT count(*)::int FROM stale) AS total,
        COALESCE(jsonb_agg(jsonb_build_object(
          'meaningId', meaning_id, 'locale', locale, 'wordId', word_id, 'lemma', lemma, 'partOfSpeech', pos, 'meaningText', meaning_text,
          'revision', revision, 'publishedAt', published_at
        ) ORDER BY lower(lemma), meaning_id, locale), '[]') AS items
      FROM page`);
    return { total: page.total, items: page.items.map((i) => ({ ...i, publishedAt: toDate(i.publishedAt) })) };
  }

  /** Stale publications to refresh: the given ones that are stale, or the first `limit`. */
  async staleTargets(publications: PublicationKey[] | undefined, limit: number) {
    const { rows: [row] } = await this.db.execute<{ total: number; items: PublicationKey[] }>(sql`
      WITH stale AS (${stalePublications}),
      picked AS (
        SELECT s.meaning_id, s.locale FROM stale s
        WHERE ${publications
          ? sql`(s.meaning_id, s.locale) IN (SELECT "meaningId", locale FROM jsonb_to_recordset(${JSON.stringify(publications)}::jsonb) AS x("meaningId" uuid, locale varchar))`
          : sql`true`}
        ORDER BY s.meaning_id, s.locale LIMIT ${limit}
      )
      SELECT (SELECT count(*)::int FROM stale) AS total,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('meaningId', meaning_id, 'locale', locale)) FROM picked), '[]') AS items`);
    return row;
  }

  /**
   * New revision = the live snapshot with only each pronunciation's IPA and audioUrl updated, so no other unpublished edit goes live.
   * approved_at is carried over: the content approval did not change.
   */
  async refreshAudio(rows: (PublicationKey & { id: string })[], now: Date) {
    if (rows.length === 0) return [];
    const { rows: refreshed } = await this.db.execute<{ meaningId: string; locale: string; revision: number }>(sql`
      WITH x AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id uuid, "meaningId" uuid, locale varchar)
      ), current AS (
        SELECT x.id AS new_id, p.meaning_id, p.locale, p.snapshot, p.approved_at,
          (SELECT max(r.revision) FROM meaning_publications r WHERE r.meaning_id = p.meaning_id AND r.locale = p.locale) + 1 AS revision
        FROM x
        JOIN active_meaning_publications a ON a.meaning_id = x."meaningId" AND a.locale = x.locale AND a.recalled_at IS NULL
        JOIN meaning_publications p ON p.id = a.publication_id
        WHERE EXISTS (SELECT 1 FROM ${outdatedAudio(sql`p.snapshot`)})
      ), publication AS (
        INSERT INTO meaning_publications (id, meaning_id, locale, revision, snapshot, approved_at, published_at)
        SELECT c.new_id, c.meaning_id, c.locale, c.revision,
          jsonb_set(c.snapshot, '{pronunciations}', (
            SELECT jsonb_agg(e
                || CASE WHEN pr.audio_asset_key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('audioUrl', pr.audio_asset_key) END
                || CASE WHEN pr.ipa IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ipa', pr.ipa) END ORDER BY t.ord)
            FROM jsonb_array_elements(c.snapshot->'pronunciations') WITH ORDINALITY AS t(e, ord)
            LEFT JOIN pronunciations pr ON pr.id = (t.e->>'id')::uuid)),
          c.approved_at, ${now}::timestamptz
        FROM current c
        RETURNING id, meaning_id, locale, revision
      ), pointer AS (
        UPDATE active_meaning_publications a SET publication_id = p.id
        FROM publication p WHERE a.meaning_id = p.meaning_id AND a.locale = p.locale
      )
      SELECT meaning_id AS "meaningId", locale, revision FROM publication ORDER BY meaning_id, locale`);
    return refreshed;
  }

  /** The batch to voice, plus how many default-accent pronunciations still lack audio. */
  async targets({ pronunciationIds, wordIds, overwrite, limit }: GenerateAudio) {
    const { rows: [row] } = await this.db.execute<{ missing: number; items: AudioTarget[] }>(sql`
      WITH picked AS (
        SELECT pr.id, pr.meaning_id AS "meaningId", wt.word_id AS "wordId", w.lemma, pr.ipa, pr.audio_asset_key IS NOT NULL AS "hasAudio"
        FROM pronunciations pr
        JOIN meanings m ON m.id = pr.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        JOIN words w ON w.id = wt.word_id
        WHERE pr.accent_locale = ${DEFAULT_ACCENT} AND pr.ipa IS NOT NULL
          AND ${pronunciationIds ? sql`pr.id IN ${idsIn(pronunciationIds)}` : sql`true`}
          AND ${wordIds ? sql`w.id IN ${idsIn(wordIds)}` : sql`true`}
          AND (${overwrite}::boolean OR pr.audio_asset_key IS NULL)
        ORDER BY lower(btrim(w.lemma)), pr.id
        LIMIT ${limit}
      )
      SELECT
        (SELECT count(*)::int FROM pronunciations WHERE accent_locale = ${DEFAULT_ACCENT} AND audio_asset_key IS NULL AND ipa IS NOT NULL) AS missing,
        COALESCE((SELECT jsonb_agg(picked ORDER BY lower(btrim(picked.lemma)), picked.id) FROM picked), '[]') AS items`);
    return row;
  }

  /** Audio already made for these sounds (bare IPA), so the same sound is never paid for twice. */
  async audioBySound(ipas: string[], voiceId: string) {
    if (ipas.length === 0) return new Map<string, string>();
    const { rows } = await this.db.execute<{ ipa: string; url: string }>(sql`
      SELECT DISTINCT ON (btrim(ipa, '/[] ')) btrim(ipa, '/[] ') AS ipa, audio_asset_key AS url
      FROM pronunciations
      WHERE accent_locale = ${DEFAULT_ACCENT} AND audio_asset_key IS NOT NULL
        AND audio_asset_key LIKE ${`%/tts/${escapeLike(voiceId)}/%`}
        AND btrim(ipa, '/[] ') IN (SELECT jsonb_array_elements_text(${JSON.stringify(ipas)}::jsonb))
      ORDER BY btrim(ipa, '/[] '), created_at DESC`);
    return new Map(rows.map((r) => [r.ipa, r.url]));
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
