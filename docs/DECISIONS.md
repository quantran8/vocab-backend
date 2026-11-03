# Implementation decisions for review

Spec v0.4 leaves these points open or undefined. Each default below is what the code does today. Items marked **iOS** are part of the client contract; items marked **Learning** change learner-visible behavior. Numeric defaults live in `src/config/policy.ts`.

## Needs a decision

| Topic | Current behavior | Spec reference | Impact |
|---|---|---|---|
| Event shapes **iOS** | `select`/`cloze_select`: `submit{optionId}`. `match`: `pair{leftId,rightId}`. `typing`: `submit{value}`. `surgery`: `submit{graphemeIndex,replacement}`. `recording`: `assessed{assessmentReceiptId}` or `unavailable{reason}`, or 1..(1+`maxRetries`) `transcribed{transcript}` for on-device scoring (last take counts, must match `referenceText` exactly, no score, same Speaking evidence rules as an Azure receipt). All: `hint`, `reveal`. `fly_reorder` as specified | §4.4, §5.1 only show samples | iOS must send exactly these; unknown fields are rejected |
| `deliveryMode` **iOS** | Required on audio-prompt tasks; `audio` or `fallback` on a text prompt is rejected | §4.4 says "may be required" | Missing value rejects the whole commit |
| Retries before auto-next **iOS** **Learning** | Each task's `clientPayload.maxRetries` is the number of retries after a wrong answer; total tries = 1 + `maxRetries`. When they run out the client moves on with no extra event and the task scores `incorrect`. A submit past the limit fails the whole commit. `match` counts per left item; `recording` counts all assessments, including invalid audio (422 past the limit). Trial values: `select`/`cloze_select`/`match` 1, `typing`/`fly_reorder`/`surgery`/`recording` 2 | §4.4 mentions retry, no limit | iOS must honor the limit from the payload; values are fixed in the session snapshot |
| Commit completeness **iOS** | Every issued task and Learn step must be submitted; otherwise the whole batch fails | §7.1 step 5 | The client must terminate every task, including Recording |
| New-learning evidence **Learning** | Evidence in phase `new_practice` carries reason `new_practice` and does not count toward verified | §5.2 implies it, does not state it | Skills verify only from review and practice sessions |
| Evidence reasons | `skill_evidence.directness` is replaced by `reasons` (JSONB array) listing every reason a row is not direct: `new_practice`, `hinted`, `revealed`, `primed`, `weak_template`, `quality_unqualified`, `audio_not_played`, `invalid_recording`. Empty means direct; only empty + `valid` counts toward verified | §5.2, §6 define `direct`/`supporting` | Diverges from the spec column. Rows backfilled by migration 0010 without their plan add `unknown`, since phase and priming are lost |
| `demonstrated` **Learning** | At least one valid direct success, not yet verified. After a revocation, prior passes keep the status at `demonstrated` | Undefined in §6 | Affects the status shown to users |
| Daily Due SRS for assisted and failed **Learning** | Assisted: next = now + min(interval, 24h), streak reset. Failed recall: interval 12h, streak reset, lapse + 1. Failed recognition: min(next, now + 24h) | §5.4 gives formulas only for unaided and recognition | Sets review frequency after mistakes |
| Priming **Learning** | Recall is primed when its answer appears in the immediately preceding step. A primed correct recall counts as assisted | §5.2 undefined window | A one-Meaning session is always primed: reverseGloss directly precedes recall, so first interval is 24h, not 48h |
| Non-Daily while due (D17) **Learning** | Random, Weak and Checkpoint never consume due; only failures pull it earlier | §5.3 `[OPEN]` | Due Meanings stay due after practice |
| Weak ranking **Learning** | From `memory_observations`: rate of non-unaided, non-recognition-success signals over 30 days, minimum 3 sessions, top 10 | §8.3 `[OPEN]` | One signal per session, and a correct recall hides a wrong `select` in the same session |
| Due ordering | Oldest `next_review_at` first | §8.1 also asks for recent failures first | Failures rank by their pulled-in due date, no separate signal |
| Review skill tasks **Learning** | 30% chance per due Meaning of one extra skill-only task | §2.9 | Controls how often Speaking and Listening get direct evidence |
| Checkpoint plan request **iOS** | Adds optional `challengeId`; defaults to oldest available | §4.2 lists only `mode` | |
| Empty plan **iOS** | Returns `{sessionId: null, steps: []}`; no session row | §2.7 `[OPEN]` | The client needs an empty state |
| Plan with no audio URL | Audio candidate rejected, text used instead | §2.5 | |
| Generated vs curated | Generated: `select.gloss/reverseGloss`, `typing`, `fly_reorder`, `match`, `recording`. Curated only: `cloze_select`, `surgery`, `meaning_clash`, `phonetic_choice`, `stress_choice`, and any audio that reads a Meaning | §2.4, §2.5 | Schema has no syllable or confusable-word data. These templates appear only once items are authored |
| `match` and `surgery` evidence | Always reason `weak_template`, with no memory signal | Absent from §5.2 table | |
| Custom words: shared pool **Product** | A lemma exists once in `words` (unique on language, lowered lemma, homograph key). Lookup searches every word first; a hit attaches to the learner's roadmap, a miss generates with AI and adds to the shared pool | Absent from spec; §2.5 and §10 assume editor-approved content | Unreviewed AI content is shared. It stays out of the catalog and of distractors, and admins review it through `GET /admin/ai-meanings` and `recall` |
| Custom words: approval **Product** | Non-negotiable app rule: a learner's edit belongs to that learner's own pool and never affects the shared pool. The confirmation publishes the AI draft unedited, without an editor. Edits live only in `user_meaning_overrides`. The same holds for a meaning generated from the learner's `context`: it is owned (`meanings.owner_user_id`), and neither it nor its drafts reach other learners or distractors until an admin approves the stored AI text. Edits are never sent to AI as a translation source, never shown to reviewers and never approved |
| Custom words: review **Product** | `GET /admin/ai-meanings` lists AI text awaiting review, private meanings included. `POST /admin/ai-meanings/:id/approve` moves the meaning to the shared pool, marks it curated and records the reviewer, so nobody generates it again. Approved meanings can be distractors. To change the text first, use `PUT /admin/meanings/:id/locales/:locale` and publish | Absent from spec | Not added to any catalog topic; two private meanings of the same sense are not merged Pool content is read from `lexical_drafts`, never from the request | §10 requires `approved` | AI content is approved by the system, so `editorial_state` no longer proves human review; `origin` says which is which |
| Custom words: translation **Product** | Generated in the learner's `explanation_locale`. A meaning missing that locale is translated once and published for all; this includes curated meanings, marked `origin = ai_generated`. Sessions never call AI, since the text is stored in the snapshot | §2.5 forbids runtime machine translation; read here as serve time | After a locale change a roadmap word is hidden until the worker translates it (one every 10 seconds). An admin's `PUT .../locales/:locale` replaces the AI text and sets `origin = curated` |
| Custom words: roadmap | One personal topic per user, under a `personal` collection left in `draft`, so the catalog and `setScope` ignore it. `newTargets` serves these first | Absent from spec | Reuses planner, commit and SRS unchanged |
| Retention | `plan` and `raw_events` cleared 30 days after expiry or commit. `result` and the session row kept | §12 `[OPEN]` | Legal/product input needed |
| Cron | In-process hourly job; assumes one running instance or tolerates a failed retry | §1.1 | Run with `ENABLE_CRON=false` on extra replicas |

## Not implemented

- **Curation admin:** no API for collections, topics or `topic_meanings`, because §10 does not list them. Only the seed writes these today, so production content cannot be assigned to topics without direct SQL or a new route.
- **DB role separation (§12):** the app connects as `postgres`. Triggers protect snapshots, but a dedicated least-privilege runtime role is not set up.
- **Rate limits (§12):** event and audio sizes are capped; request rate limiting is not implemented. Custom word lookups that call AI have their own daily limit (`POLICY.customWords`).
- **Custom word reporting:** learners cannot report a wrong AI meaning. Approved meanings cannot be assigned to a catalog topic through the API (see Curation admin).
- **Catalog audio:** ElevenLabs audio covers only words created through custom words; existing catalog words are not backfilled.
- **Metrics (§12):** logs carry `requestId`; the listed monitoring metrics and audit log are not implemented.
- **Recording abuse control (§4.2):** repeated `unavailable` events are accepted without limits.
- **C54 legacy prompts:** no legacy decoder, since no v0.2 data exists.

## Deviations from the spec SQL

- `id` columns are UUID v7 generated by the app, with no database default. Direct SQL inserts must supply `id`.
- Unique rules are unique indexes rather than constraints, with identical effect. FKs work the same.
- Added: RLS on all tables, and triggers blocking updates to `meaning_publications`, `learning_sessions.plan` and published `practice_items` content.

## Operational constraints

- Database session TimeZone must be UTC; the app refuses to boot otherwise.
- Drizzle ORM is pinned to 0.45.4 (stable `latest`); the 1.0 beta tags are not used.
- `embedded-postgres` runs tests on Postgres 17. Native `uuidv7()` is not used.
