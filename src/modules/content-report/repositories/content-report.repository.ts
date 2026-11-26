import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { newId } from '../../../common/ids';
import {
  CONTENT_REPORT_SORT, CONTENT_REPORT_STATUS, ContentReportReason, ContentReportSource, ContentReportStatus, SESSION_MODE,
} from '../../../common/constants/domain';
import { MS_PER_DAY } from '../../../common/constants/time';
import { POLICY } from '../../../config/policy';
import { DB, Db, toDate } from '../../../db/db';
import { contentReports } from '../../../db/schema';
import { ReportedMeaning } from '../domain/content-report';
import { ListReports } from '../dto/content-report.schemas';

/** What the learner was shown, resolved on the server. */
export type ResolvedContext = {
  locale: string;
  meanings: ReportedMeaning[];
  /** The plan's learn step or task, or the publication snapshot. */
  element: Record<string, unknown>;
  overridden: boolean;
};

export type NewReport = {
  reporterId: string; clientReportId: string; requestSha256: string; source: ContentReportSource; reason: ContentReportReason;
  note: string | null; sessionId: string | null; taskId: string | null; learnStepId: string | null; meaningIds: string[];
  targetKey: string; contentVersion: string | null; explanationLocale: string; snapshot: object; attemptExcerpt: object | null; now: Date;
};

const OPEN = sql`(${CONTENT_REPORT_STATUS.PENDING}, ${CONTENT_REPORT_STATUS.UNDER_REVIEW})`;
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

@Injectable()
export class ContentReportRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async byClientId(reporterId: string, clientReportId: string) {
    const [row] = await this.db
      .select({ id: contentReports.id, requestSha256: contentReports.requestSha256 })
      .from(contentReports)
      .where(and(eq(contentReports.reporterId, reporterId), eq(contentReports.clientReportId, clientReportId)));
    return row;
  }

  /** A learn step or task from the reporter's own stored plan; null when missing, foreign or purged. */
  async sessionContext(userId: string, sessionId: string, collection: 'learnSteps' | 'tasks', elementId: string) {
    const { rows: [row] } = await this.db.execute<{ element: Record<string, unknown> | null; locale: string; meanings: ReportedMeaning[]; overridden: boolean }>(sql`
      WITH cfg AS (
        SELECT explanation_locale AS locale FROM user_settings WHERE user_id = ${userId}::uuid
      ), el AS (
        SELECT e FROM learning_sessions s, jsonb_array_elements(s.plan -> ${collection}::text) e
        WHERE s.id = ${sessionId}::uuid AND s.user_id = ${userId}::uuid AND s.mode <> ${SESSION_MODE.CHECKPOINT_CHALLENGE}
          AND e ->> 'id' = ${elementId}::text
      ), ids AS (
        SELECT (el.e ->> 'meaningId')::uuid AS id FROM el WHERE el.e ->> 'meaningId' IS NOT NULL
        UNION
        SELECT COALESCE((t ->> 'meaningId')::uuid, p.meaning_id)
        FROM el, jsonb_array_elements(COALESCE(el.e -> 'targets', '[]'::jsonb)) t
        LEFT JOIN pronunciations p ON p.id = (t ->> 'pronunciationId')::uuid
        WHERE t ->> 'meaningId' IS NOT NULL OR p.meaning_id IS NOT NULL
      )
      SELECT (SELECT e FROM el) AS element, cfg.locale,
        COALESCE((SELECT json_agg(json_build_object('meaningId', ids.id, 'publicationId', a.publication_id) ORDER BY ids.id)
          FROM ids LEFT JOIN active_meaning_publications a ON a.meaning_id = ids.id AND a.locale = cfg.locale), '[]'::json) AS meanings,
        EXISTS (SELECT 1 FROM user_meaning_overrides o JOIN ids ON ids.id = o.meaning_id
          WHERE o.user_id = ${userId}::uuid AND o.locale = cfg.locale) AS overridden
      FROM cfg`);
    return row?.element ? (row as ResolvedContext) : null;
  }

  /** A Meaning the reporter may see, with its active publication in their explanation locale. */
  async meaningContext(userId: string, meaningId: string) {
    const { rows: [row] } = await this.db.execute<ResolvedContext & { publicationId: string }>(sql`
      WITH cfg AS (SELECT explanation_locale AS locale FROM user_settings WHERE user_id = ${userId}::uuid)
      SELECT cfg.locale, p.snapshot AS element,
        json_build_array(json_build_object('meaningId', m.id, 'publicationId', p.id)) AS meanings,
        EXISTS (SELECT 1 FROM user_meaning_overrides o
          WHERE o.user_id = ${userId}::uuid AND o.meaning_id = m.id AND o.locale = cfg.locale) AS overridden
      FROM cfg
      JOIN meanings m ON m.id = ${meaningId}::uuid AND (m.owner_user_id IS NULL OR m.owner_user_id = ${userId}::uuid)
      JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.locale = cfg.locale AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id`);
    return row ?? null;
  }

  // Duplicates are checked before the daily limit, so they never count against it.
  async insert(r: NewReport) {
    const since = new Date(r.now.getTime() - MS_PER_DAY);
    const { rows: [row] } = await this.db.execute<{ insertedId: string | null; duplicateId: string | null; recent: number }>(sql`
      WITH recent AS (
        SELECT count(*)::int AS n FROM content_reports WHERE reporter_id = ${r.reporterId}::uuid AND created_at > ${since}::timestamptz
      ), open AS (
        SELECT id FROM content_reports
        WHERE reporter_id = ${r.reporterId}::uuid AND target_key = ${r.targetKey} AND reason = ${r.reason}
          AND explanation_locale = ${r.explanationLocale} AND status IN ${OPEN}
        LIMIT 1
      ), ins AS (
        INSERT INTO content_reports (id, reporter_id, client_report_id, request_sha256, source, reason, note, session_id, task_id,
          learn_step_id, meaning_ids, target_key, content_version, explanation_locale, snapshot, attempt_excerpt, created_at)
        SELECT ${newId()}::uuid, ${r.reporterId}::uuid, ${r.clientReportId}::uuid, ${r.requestSha256}::text, ${r.source}::text, ${r.reason}::text,
          ${r.note}::text, ${r.sessionId}::uuid, ${r.taskId}::uuid, ${r.learnStepId}::uuid, ${json(r.meaningIds)}, ${r.targetKey}::text,
          ${r.contentVersion}::text, ${r.explanationLocale}::text, ${json(r.snapshot)},
          ${r.attemptExcerpt === null ? sql`NULL::jsonb` : json(r.attemptExcerpt)}, ${r.now}::timestamptz
        FROM recent WHERE recent.n < ${POLICY.contentReport.perDay}::int AND NOT EXISTS (SELECT 1 FROM open)
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT (SELECT id FROM ins) AS "insertedId", (SELECT id FROM open) AS "duplicateId", (SELECT n FROM recent) AS recent`);
    return row;
  }

  // One statement per page, total included; reporterCount counts distinct learners in the open group, never retries.
  async list(q: ListReports) {
    const filters = [
      sql`r.status = ${q.status}`,
      q.reason && sql`r.reason = ${q.reason}`,
      q.source && sql`r.source = ${q.source}`,
      q.locale && sql`r.explanation_locale = ${q.locale}`,
    ].filter((f) => !!f);
    const order = q.sort === CONTENT_REPORT_SORT.MOST_REPORTED ? sql`"reporterCount" DESC, r.created_at` : sql`r.created_at`;
    const { rows } = await this.db.execute<Record<string, unknown> & { createdAt: string }>(sql`
      SELECT r.id, r.source, r.reason, r.status, r.note, r.explanation_locale AS "explanationLocale", r.meaning_ids AS "meaningIds",
        r.target_key AS "targetKey", r.content_version AS "contentVersion", r.created_at AS "createdAt",
        (SELECT w.lemma FROM meanings m JOIN word_types wt ON wt.id = m.type_id JOIN words w ON w.id = wt.word_id
         WHERE m.id = (r.meaning_ids ->> 0)::uuid) AS lemma,
        (SELECT count(DISTINCT o.reporter_id)::int FROM content_reports o
         WHERE o.target_key = r.target_key AND o.reason = r.reason AND o.explanation_locale = r.explanation_locale
           AND (o.status IN ${OPEN} OR o.id = r.id)) AS "reporterCount",
        count(*) OVER ()::int AS total
      FROM content_reports r
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY ${order}
      LIMIT ${q.perPage}::int OFFSET ${(q.page - 1) * q.perPage}::int`);
    const total = (rows[0]?.total as number | undefined) ?? 0;
    return { total, items: rows.map(({ total: _, ...r }) => ({ ...r, createdAt: toDate(r.createdAt) })) };
  }

  /** The report with the original snapshot, the current revision of its Meanings and its history. */
  async detail(id: string) {
    const { rows: [row] } = await this.db.execute<Record<string, unknown> & { createdAt: string; reviewedAt: string | null }>(sql`
      SELECT r.id, r.source, r.reason, r.status, r.note, r.session_id AS "sessionId", r.task_id AS "taskId", r.learn_step_id AS "learnStepId",
        r.meaning_ids AS "meaningIds", r.target_key AS "targetKey", r.content_version AS "contentVersion",
        r.explanation_locale AS "explanationLocale", r.snapshot AS "originalSnapshot", r.attempt_excerpt AS "attemptExcerpt",
        r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt", r.resolution_note AS "resolutionNote", r.created_at AS "createdAt",
        COALESCE((SELECT json_agg(json_build_object('meaningId', a.meaning_id, 'publicationId', p.id, 'revision', p.revision,
            'recalled', a.recalled_at IS NOT NULL, 'snapshot', p.snapshot) ORDER BY a.meaning_id)
          FROM jsonb_array_elements_text(r.meaning_ids) mid
          JOIN active_meaning_publications a ON a.meaning_id = mid::uuid AND a.locale = r.explanation_locale
          JOIN meaning_publications p ON p.id = a.publication_id), '[]'::json) AS "currentRevisions",
        COALESCE((SELECT json_agg(json_build_object('actorId', e.actor_id, 'fromStatus', e.from_status, 'toStatus', e.to_status,
            'note', e.note, 'createdAt', e.created_at) ORDER BY e.created_at)
          FROM content_report_events e WHERE e.report_id = r.id), '[]'::json) AS events
      FROM content_reports r WHERE r.id = ${id}::uuid`);
    return row && { ...row, createdAt: toDate(row.createdAt), reviewedAt: row.reviewedAt ? toDate(row.reviewedAt) : null };
  }

  async status(id: string) {
    const [row] = await this.db.select({ status: contentReports.status }).from(contentReports).where(eq(contentReports.id, id));
    return row?.status;
  }

  /** Moves the report only if it is still in `from`, and records the move; null when someone moved it first. */
  async transition(input: { id: string; from: ContentReportStatus; to: ContentReportStatus; actorId: string; note: string | null; now: Date }) {
    const { id, from, to, actorId, note, now } = input;
    const reviewed = to !== CONTENT_REPORT_STATUS.PENDING;
    const { rows: [row] } = await this.db.execute<{ id: string; status: ContentReportStatus }>(sql`
      WITH upd AS (
        UPDATE content_reports
        SET status = ${to}, reviewed_by = ${reviewed ? actorId : null}::uuid, reviewed_at = ${reviewed ? now : null}::timestamptz,
          resolution_note = ${reviewed ? note : null}::text
        WHERE id = ${id}::uuid AND status = ${from}
        RETURNING id, status
      ), ev AS (
        INSERT INTO content_report_events (id, report_id, actor_id, from_status, to_status, note, created_at)
        SELECT ${newId()}::uuid, upd.id, ${actorId}::uuid, ${from}::text, ${to}::text, ${note}::text, ${now}::timestamptz FROM upd
      )
      SELECT id, status FROM upd`);
    return row ?? null;
  }
}
