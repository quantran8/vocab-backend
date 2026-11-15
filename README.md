# Vocab Flow Backend

MVP backend for Vocab Flow: vocabulary sessions, seven practice templates, Meaning SRS and four-skill verification. Spec: [spec/](spec/). Decisions needing review: [docs/DECISIONS.md](docs/DECISIONS.md).

**Status:** implements Spec v0.4, which is an unapproved Engineering Review Draft. SRS and threshold values are trial defaults.

## Setup

Requires Node 22.18+ and pnpm.

```sh
pnpm install
cp .env.example .env      # fill in Supabase values
pnpm db:migrate           # needs DIRECT_URL
pnpm db:seed              # admin account, plus optional demo: 4 collections, 20 words, 33 curated items (text-only, no audio)
pnpm start:dev
```

API docs are served at `/docs`.

## Supabase

- `DATABASE_URL` is the transaction pooler (6543); `DIRECT_URL` is for migrations only.
- The database session TimeZone must be UTC (the Supabase default). The app refuses to boot otherwise.
- Migrations enable RLS on every table with no policies, so anon and authenticated roles cannot reach them through PostgREST. The app uses the `postgres` role, which bypasses RLS.
- `/v1/custom-words` needs `ANTHROPIC_API_KEY` for generation, and `ELEVENLABS_*` plus `R2_*` for audio. Make the R2 bucket public (custom domain or r2.dev) first. Provider choice is one `useClass` line in `src/app.module.ts`.
- `/v1/auth/{signup,login,google,refresh}` are public and proxy Supabase Auth (needs `SUPABASE_ANON_KEY`). Google: enable the provider in the Supabase dashboard; the client sends the Google ID token (and the raw `nonce` if it used one). Email confirmation on means signup returns `session: null`.
- Admin routes require `app_metadata.role` of `editor` or `admin`. `pnpm db:seed` creates the only `admin` account from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (needs `SUPABASE_SERVICE_ROLE_KEY`). `SEED_ADMIN_USERNAME` is its login name. `PUT /admin/users/:id/role` grants `editor` only.

## Audio

`pronunciations.audio_asset_key` holds a ready-to-play HTTPS URL. Generated audio is voiced by ElevenLabs and stored in Cloudflare R2 at `tts/<voice>/<accent>/<sha256 of text>.mp3`, so URLs never contain the word (blind listening tasks reject URLs that do).

- `GET /admin/audio/status`: default-accent pronunciations with and without audio, and live publications whose snapshot misses the current audio.
- `POST /admin/audio/generate` `{ pronunciationIds? | wordIds?, overwrite?, limit? }`: voices up to 50 pronunciations per call (default 20, missing only). Call again until `remaining` is 0.
- `GET /admin/audio/missing?q=&limit=&offset=`: default-accent pronunciations without audio (`live` marks a type with a live meaning).
- Publications are immutable, so a live meaning plays new audio only in a new revision. `GET /admin/audio/stale-publications` lists live ones playing older audio; `POST /admin/audio/stale-publications/refresh` `{ publications?: [{ meaningId, locale }], limit? }` adds revisions that copy the live snapshot and change only `audioUrl`, so unpublished edits stay unpublished. Up to 200 per call; call again until `remaining` is 0.

## Tests

```sh
pnpm test
```

Runs unit tests plus REST integration tests against an embedded Postgres 17. Tests carry spec case IDs (C01–C62).
