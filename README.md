# Vocab Flow Backend

MVP backend for Vocab Flow: vocabulary sessions, seven practice templates, Meaning SRS and four-skill verification. Spec: [spec/](spec/). Decisions needing review: [docs/DECISIONS.md](docs/DECISIONS.md).

**Status:** implements Spec v0.4, which is an unapproved Engineering Review Draft. SRS and threshold values are trial defaults.

## Setup

Requires Node 22.18+ and pnpm.

```sh
pnpm install
cp .env.example .env      # fill in Supabase values
pnpm db:migrate           # needs DIRECT_URL
pnpm db:seed              # optional 8-word demo; set ALLOW_PLACEHOLDER_AUDIO only for local use
pnpm start:dev
```

API docs are served at `/docs`.

## Supabase

- `DATABASE_URL` is the transaction pooler (6543); `DIRECT_URL` is for migrations only.
- The database session TimeZone must be UTC (the Supabase default). The app refuses to boot otherwise.
- Migrations enable RLS on every table with no policies, so anon and authenticated roles cannot reach them through PostgREST. The app uses the `postgres` role, which bypasses RLS.
- Admin routes require `app_metadata.role` of `editor` or `admin`, set server-side in Supabase Auth.

## Audio

`pronunciations.audio_asset_key` holds a ready-to-play HTTPS URL. Storage is managed outside this service. URLs for blind listening tasks must not contain the target word; such tasks are rejected.

## Tests

```sh
pnpm test
```

Runs unit tests plus REST integration tests against an embedded Postgres 17. Tests carry spec case IDs (C01–C62).
