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
- Keep pure logic (evaluators, reducer, SRS, skills, interleaver) free of Nest and Drizzle.
- Run seeds through the Nest build: `tsx`/esbuild does not emit decorator metadata.
