# Content reports

A learner flags a problem in what they were shown: a learn card, a practice task, or a meaning in word detail. Reports are feedback for admins. They never change scoring, SRS, LP, the session or its commit, and nothing in the learning code reads them.

## What can be reported

| Source | Context the client sends | What the server resolves |
| --- | --- | --- |
| `learn_card` | `sessionId`, `learnStepId` | The learn step in that session's stored plan |
| `practice_task` | `sessionId`, `taskId`, optional `attemptExcerpt` | The task in that session's stored plan, with its answer key |
| `word_detail` | `meaningId` | The active publication of that Meaning in the learner's explanation locale |

- The session must belong to the reporter and still hold its plan. Plans are purged `POLICY.session.retentionHours` after commit or expiry (30 days), so in practice a report is sent long before that. A missing or foreign context answers `404 REPORT_CONTEXT_UNAVAILABLE`, whichever it is, so ids of other learners leak nothing.
- Checkpoint challenge sessions cannot be reported (V1). Match Madness, placement and Practice Lab do not issue sessions here, so they cannot be reported either.
- A word detail Meaning must be visible to the reporter: shared, or private and owned by them.
- Custom words have no separate source. A custom Meaning is reported from word detail or from the session that taught it.
- The client never sends the content, the Word id, the revision or the locale: the server reads them. The explanation locale comes from `user_settings`.

## Own edits cannot be reported

If the reporter has an edit (`user_meaning_overrides`) on any Meaning the report targets, in their explanation locale, the report is refused with `422 REPORT_TARGET_OVERRIDDEN`. The learn card and tasks they saw were built from their own edit, and edits are never shown to reviewers (see `CLAUDE.md`). The app should hide the action on such Meanings.

Known gap: an edit deleted after the plan was issued is not detected, so that plan's snapshot can still carry the old edited text.

## Reasons

| Reason | Allowed on |
| --- | --- |
| `incorrect_meaning`, `incorrect_definition`, `incorrect_example`, `audio_issue` | every source |
| `incorrect_question` | `practice_task` |
| `answer_should_be_accepted` | `practice_task` with an `attemptExcerpt` |
| `other` | every source; `note` is required |

`note` is trimmed and holds at most 500 Unicode scalars. `attemptExcerpt` is diagnostic only, never evidence for regrading. Its text fields are capped at 256 scalars, and it never carries audio.

## Idempotency and duplicates

- `clientReportId` is created by the app once per send and reused for every retry. The same id with the same body replays the first answer (`200`). The same id with a different body answers `409 REPORT_IDEMPOTENCY_CONFLICT`.
- A **duplicate** is a second open report (`pending` or `under_review`) from the same reporter on the same `target_key`, reason and explanation locale. It is not stored; the answer points at the first report with `duplicate: true` (`200`). The first report's note is kept. Once that report is closed, or the content gets a new revision, a new report is accepted. A partial unique index enforces this, so concurrent sends cannot create two.
- `target_key` identifies the content revision:
  - `meaning:<meaningId>@<publicationId>` for learn cards and word detail, so both share one group.
  - `item:<practiceItemId>` for a curated task. Curated items are immutable revisions.
  - `task:<template>/<variant>:<meaningIds>@<publicationIds>` for a generated task. A match task with several Meanings is one report on the whole task, and no single Meaning is picked for it.
- At most `POLICY.contentReport.perDay` (20) new reports per reporter per rolling 24 hours, else `429 REPORT_LIMIT_REACHED`. Replays and duplicates do not count.

## Snapshot

The report stores what the learner was shown: the plan's learn step or task (task snapshots include the answer key, which only admins see), or the publication snapshot for word detail. It is taken when the report is received. It never includes tokens, audio or learning history. The admin detail shows the current active publication next to it, labelled separately, so a fix made later is never mistaken for the original.

## Admin review

Editors and admins (`AdminOnly`) work the queue at `/admin/content-reports`:

- `pending → under_review | resolved | dismissed`
- `under_review → pending | resolved | dismissed`
- `resolved | dismissed → pending` (reopen)

Closing (`resolved` or `dismissed`) requires a resolution note. Every transition is written to `content_report_events` with its actor. Reopening fails with `409 CONTENT_LOCKED` if the reporter has since opened another report on the same target and reason.

Fixes go through the normal content editor and publication workflow; a report never edits content. Issued plans keep the content they were issued with, and new plans pick up the new revision. Resolving a report does not regrade or touch any learner's progress.

## Deletion

Reports reference `app_user` with `ON DELETE CASCADE`, and events cascade from reports, so deleting an account removes the reporter's reports, notes and snapshots.
