# Vocab Flow backend

NestJS (Fastify) + Drizzle ORM + Supabase (Postgres, Auth). Spec: `spec/`. Open decisions: `docs/DECISIONS.md`.

## Commands

- `pnpm test` runs everything against an embedded real Postgres (no Docker needed)
- `pnpm test:unit`, `pnpm test:int`, `pnpm lint`, `pnpm build`
- `pnpm db:migrate`, `pnpm db:seed`

## Coding rules

**No extra round trips, no N+1.**
- Never query in a loop, including `Promise.all(items.map(...))`. Read once with `inArray(col, ids)` and index with a `Map`.
- Write with one multi-row `insert().values([...])`, or one `INSERT ... ON CONFLICT` / `jsonb_to_recordset` statement for rows with differing values.
- Select only needed columns; avoid loading `snapshot` and other large JSONB when unused.
- Aggregate screens are one SQL statement, not several queries merged in code.
- A request's query count must not grow with data. ESLint blocks common shapes; `test/api.test.ts` compares query counts at 1 vs 20 Meanings.

**Comments are short.** Explain only a non-obvious reason, usually in one line.

**Constants for repeated values.** Domain enums, error codes and event names live in `src/common/constants/`, trial numbers in `src/config/policy.ts`.

**Domain consts:** keys are UPPER_SNAKE_CASE, stored values are lower_snake_case: `RANDOM_PRACTICE: 'random_practice'`. Never hardcode these values in `src`.

## Things that are easy to break

- Ids: every table's `id` column uses `$defaultFn(newId)` (UUID v7, generated in the app). Call `newId()` when an id is needed before insert. DB columns have no default.
- CHECK constraints, partial indexes, triggers and foreign keys are not in `src/db/schema.ts`; they live in the hand-written SQL migrations in `drizzle/` (listed in `drizzle/meta/_journal.json`). `test/schema.test.ts` diffs the catalog against `spec/*.sql`.
- Raw `db.execute(sql`...`)` returns timestamptz as text, not `Date`: convert with `toDate`. Add `::type` casts to parameters in `SELECT` lists.
- JS `Date` keeps milliseconds only. Do not compare stored timestamps to microsecond values computed in SQL.
- Drizzle drops `undefined` inside `and(...)` and treats `where(undefined)` as no filter, which widens it to every row. Never pass an optional id to `update`/`delete`.
- `insert().values([])` throws: guard empty arrays.
- `learning_sessions.plan` and `meaning_publications` are immutable, enforced by triggers; retention may only set `plan` to NULL.
- Never select `plan`, `raw_events` or `result` unless the request uses them.
- `words` is unique on language + `lower(btrim(lemma))` + `homograph_key`; never insert a word without searching that key first. A pool write takes content from `lexical_drafts`, never from the request.
- Non-negotiable: what a learner writes stays in their own pool and never changes shared content. An edit goes to `user_meaning_overrides`; a meaning generated from their `context` has `meanings.owner_user_id` set, and only an admin approving its stored AI text may share it. Edits are never approved or shown to reviewers. Any query that lists a word's meanings must filter `owner_user_id IS NULL OR = user`.
- R (new words left in scope), C (own words left) and B (review backlog) come only from `src/modules/review-load/repositories/review-scope.sql.ts`. Planner, learn-home, commit, journey and challenge map must share them, or Home and the plan disagree. Review takes every learned Meaning except those only in a paused collection (`reviewableSql`), not just the active topics.
- A commit's `scopeEvents` is computed inside `writeCommit`, from the pre-write snapshot, and stored in `commit_response`. Never compute it after the write: a retry must replay the first answer.
- A `known_check` task and the tasks in a learn step's `skippableTaskIds` may be missing from a commit only as `evaluateBatch` allows. A step in `knownLearnSteps` counts as known without a check (`declaredKnown`); `applySrs` drops it back to a normal schedule only on a slip in a shared task. A failed check is neither a memory signal nor evidence (`countedTasks`).
- Keep pure logic (evaluators, reducer, SRS, skills, interleaver) free of Nest and Drizzle.
- Run seeds through the Nest build: `tsx`/esbuild does not emit decorator metadata.
