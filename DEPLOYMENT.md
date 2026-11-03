# Deployment

vocab-backend runs on the same OCI VM as money-space-backend and is served from
money-space's domain at **`https://<money-space domain>/service/vocab/`**.

```
push to develop ──> build arm64 image ──> OCIR (vocab-backend repo) ──> ssh to the VM
                                                                          │
   /opt/money-space (money-space)            <APP_DIR> (vocab)            │
   ├─ caddy :80/:443 ── edge network ──────> backend (alias vocab-backend)◄┘
   │   └─ routes/vocab.caddy  (written by this deploy)
   └─ backend, redis
```

- Caddy belongs to money-space. This deploy writes `routes/vocab.caddy` into
  money-space's directory and reloads Caddy; `handle_path` strips
  `/service/vocab`, so the app still serves `/v1`, `/health` and `/docs` at its root.
- Migrations (`node dist/db/migrate.js`, same journal as `drizzle-kit migrate`)
  run on every deploy **before** the restart. Tick *skip_migrations* on a manual
  run to skip them.
- The app port is published on `127.0.0.1` only; the public path goes through Caddy.

## One-time setup

1. **money-space first.** Deploy money-space with its shared-edge change
   (Caddyfile `import /etc/caddy/routes/*.caddy`, `routes/` mount, `edge`
   network). Until then this deploy stops at *Publish the Caddy route* with a
   clear error.
2. **OCIR repository.** Create `vocab-backend` in the same compartment as
   `money-space-backend` (Console → Developer Services → Container Registry, or a
   second `oci_artifacts_container_repository` in money-space's `terraform/`).
3. **App directory.** The `deploy` user has no sudo and only owns
   `/opt/money-space`, so pick a directory it owns, e.g. `/home/deploy/vocab-backend`.
   The workflow creates it.

## GitHub settings (this repo)

**Secrets** — the first five are the same values as in money-space:

| Secret | Value |
| --- | --- |
| `OCI_HOST` | same as money-space |
| `OCI_SSH_USER` | `deploy` |
| `OCI_SSH_PRIVATE_KEY` | same key as money-space (`~/.ssh/money_space_deploy`) |
| `OCIR_USERNAME` | same as money-space |
| `OCIR_TOKEN` | same as money-space |
| `APP_DIR` | `/home/deploy/vocab-backend` |
| `DATABASE_URL` | Supabase transaction pooler (6543) |
| `DIRECT_URL` | session/direct connection (5432), used by migrations |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | from `.env` |
| `AZURE_SPEECH_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` | optional; unset disables that provider |

**Variables**:

| Variable | Value |
| --- | --- |
| `OCIR_REGISTRY` | same as money-space, e.g. `ap-singapore-1.ocir.io` |
| `OCIR_NAMESPACE` | same as money-space |
| `OCIR_REPOSITORY` | `vocab-backend` |
| `DOMAIN_NAME` | money-space's `DOMAIN_NAME`; unset skips the Caddy route |
| `BUILD_PLATFORM` | `linux/arm64` (default) or `linux/amd64` |
| `APP_PORT` | loopback port on the VM, default `3001` (money-space uses 3000) |
| `EDGE_DIR` | money-space's `APP_DIR`, default `/opt/money-space` |
| optional | `AZURE_SPEECH_REGION`, `SUPABASE_AUDIO_BUCKET`, `LEXICAL_AI_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `DB_POOL_SIZE`, `JWT_AUDIENCE`, `ENABLE_CRON` |

An unset optional value is left out of the VM's `.env`, so the defaults in
`src/config/app-config.ts` apply.

**Registry pruning** (`prune-registry.yml`, weekly): needs the same
`OCI_CLI_*`, `OCI_COMPARTMENT_ID` secrets and `OCI_CLI_REGION` variable as
money-space. It only touches the repository named by `OCIR_REPOSITORY`.

## Operations

- Logs: Actions → *Fetch backend logs*.
- Rollback: on the VM set `BACKEND_IMAGE` in `$APP_DIR/.env` to an older
  `:<sha>` and run `docker compose up -d`. Migrations are not reversed.
- Local image: `docker build -t vocab-backend .`
