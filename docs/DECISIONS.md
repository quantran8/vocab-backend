# Implementation decisions for review

Spec v0.4 leaves these points open or undefined. Each default below is what the code does today. Items marked **iOS** are part of the client contract; items marked **Learning** change learner-visible behavior. Numeric defaults live in `src/config/policy.ts`.

## Needs a decision

| Topic | Current behavior | Spec reference | Impact |
|---|---|---|---|
| Event shapes **iOS** | `select`/`cloze_select`: `submit{optionId}`. `match`: `pair{leftId,rightId}`. `typing`: `submit{value}`. `surgery`: `submit{graphemeIndex,replacement}`. `recording`: `assessed{assessmentReceiptId}` or `unavailable{reason}`. All: `hint`, `reveal`. `fly_reorder` as specified | §4.4, §5.1 only show samples | iOS must send exactly these; unknown fields are rejected |
| `deliveryMode` **iOS** | Required on audio-prompt tasks; `audio` or `fallback` on a text prompt is rejected | §4.4 says "may be required" | Missing value rejects the whole commit |
| Retries before auto-next **iOS** **Learning** | Each task's `clientPayload.maxRetries` is the number of retries after a wrong answer; total tries = 1 + `maxRetries`. When they run out the client moves on with no extra event and the task scores `incorrect`. A submit past the limit fails the whole commit. `match` counts per left item; `recording` counts all assessments, including invalid audio (422 past the limit). Trial values: `select`/`cloze_select`/`match` 1, `typing`/`fly_reorder`/`surgery`/`recording` 2 | §4.4 mentions retry, no limit | iOS must honor the limit from the payload; values are fixed in the session snapshot |
| Commit completeness **iOS** | Every issued task and Learn step must be submitted; otherwise the whole batch fails | §7.1 step 5 | The client must terminate every task, including Recording |
| New-learning evidence **Learning** | Evidence in phase `new_practice` is `supporting` and does not count toward verified | §5.2 implies it, does not state it | Skills verify only from review and practice sessions |
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
| `match` and `surgery` evidence | Always `supporting`, with no memory signal | Absent from §5.2 table | |
| Retention | `plan` and `raw_events` cleared 30 days after expiry or commit. `result` and the session row kept | §12 `[OPEN]` | Legal/product input needed |
| Cron | In-process hourly job; assumes one running instance or tolerates a failed retry | §1.1 | Run with `ENABLE_CRON=false` on extra replicas |

## Not implemented

- **Curation admin:** no API for collections, topics or `topic_meanings`, because §10 does not list them. Only the seed writes these today, so production content cannot be assigned to topics without direct SQL or a new route.
- **DB role separation (§12):** the app connects as `postgres`. Triggers protect snapshots, but a dedicated least-privilege runtime role is not set up.
- **Rate limits (§12):** event and audio sizes are capped; request rate limiting is not implemented.
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
