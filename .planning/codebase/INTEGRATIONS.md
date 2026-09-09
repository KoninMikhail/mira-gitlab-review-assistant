# External Integrations

**Analysis Date:** 2026-09-09

## APIs & External Services

**Version control (GitLab self-hosted):**
- GitLab REST API v4 — MR discovery, context, diffs, clone auth, and optional MR write
  - SDK/Client: none; custom `GitLabClient` in `src/adapters/vcs/gitlab/client.ts` over global `fetch`
  - Auth: header `PRIVATE-TOKEN: {GITLAB_TOKEN}`; clone URL embeds token as `oauth2:<token>@` (`src/core/context/checkout.ts` `buildCloneUrl`)
  - Base: `{GITLAB_BASE_URL}/api/v4/…` (`GITLAB_BASE_URL` has no `/api/v4` suffix)
  - Pagination: `per_page` default 50, follow `x-next-page`
  - Rate limit: retry up to 2× on HTTP 429 (`Retry-After` or 1000 ms)
  - Read adapter: `GitLabReader` (`src/adapters/vcs/gitlab/reader.ts`) implements `VcsReader` + `VcsMrLister`
    - `GET projects/{id}/merge_requests?state=opened` — poller
    - `GET projects/{id}/merge_requests/{iid}` — MR metadata
    - `GET projects/{id}/merge_requests/{iid}/diffs` — changed-file list (unified diff is **not** taken from this API)
  - Write adapter: `GitLabWriter` (`src/adapters/vcs/gitlab/writer.ts`) implements `VcsWriter`
    - `GET/POST projects/{id}/merge_requests/{iid}/notes`
    - `PUT projects/{id}/merge_requests/{iid}/notes/{noteId}`
    - `GET/POST projects/{id}/merge_requests/{iid}/discussions` (inline `position` snake_case)
    - `PUT projects/{id}/merge_requests/{iid}/discussions/{discussionId}?resolved=`
  - Publisher: `GitLabPublisher` (`src/adapters/publisher/gitlab/gitlab-publisher.ts`) when `MIRA_PUBLISHER=gitlab`; default `LogPublisher` (`src/adapters/publisher/log/log-publisher.ts`) writes JSON logs only (dry-run)
  - Git clone (not REST): blobless `git clone --filter=blob:none` then `git diff origin/target...origin/source` (`src/core/context/checkout.ts`); optional bare mirror cache (`src/core/context/mirror-checkout.ts`, `MIRA_CHECKOUT=mirror`)
  - Bot account (ops): GitLab user `mira_review_bot` (id 30) — membership to pilot repos is required for live runs
  - Linking MR → Kaiten: card id from branch and/or MR title/description (`src/core/linking/`, defaults in `src/core/linking/config.ts`)

**Task tracker (Kaiten):**
- Kaiten REST — read card title, description, acceptance criteria
  - SDK/Client: none; `KaitenHttpClient` (`src/adapters/tracker/kaiten/http.ts`) + `KaitenTracker` (`src/adapters/tracker/kaiten/kaiten-tracker.ts`)
  - Auth: `Authorization: Bearer {KAITEN_TOKEN}`
  - Base: `{KAITEN_BASE_URL}/api/latest` (`src/adapters/tracker/kaiten/endpoints.ts` `API_BASE_PATH`)
  - Methods: **GET only**. Adapter MUST NOT POST/PUT/PATCH/DELETE.
  - Endpoint used: `GET /cards/{id}?additional_card_fields=checklists` (`kaitenEndpoints.card`)
  - Installation note (`ai-referent.kaiten.ru`): `GET /cards/:id/checklists` returns 405; do not add a separate checklists call
  - Optional in-process TTL cache: `CachingTaskTracker` (`src/adapters/cache/caching-tracker.ts`) when `MIRA_READ_CACHE=on`
  - Token is a personal user token, not a service account. Write-back (comments, links, status, checklists) is forbidden under this token (rule `.cursor/rules/kaiten-read-only.mdc`, ADR `docs/04-architecture/adr/008-kaiten-read-only.md`)

**Review engine (Cursor):**
- Cursor API via headless CLI — model inference on the MR checkout
  - Integration method: spawn `cursor-agent -p --output-format json --model <model> --force --trust` with prompt on stdin (`src/adapters/engine/cli/cli-headless-engine.ts`, spawn in `src/adapters/engine/cli/spawn.ts`)
  - Auth: env `CURSOR_API_KEY` passed into the child process
  - Model: policy `model` field, default `composer-2.5` (`src/core/policy/defaults.ts` / engine default)
  - Timeout: 600 s; one retry only when exit 0 but findings JSON fails schema
  - Output: `findings.json` in workspace or fenced JSON in stdout; validated by `src/core/findings/validateFindings.ts` against `schema/findings.schema.json`
  - Prompt template: `prompts/review.v1.md`; stack guidance from `profiles/<name>.md`
  - Egress of MR source to Cursor API is allowed (ADR `docs/04-architecture/adr/011-cursor-api-egress-allowed.md`)
  - `@cursor/sdk` is not used at runtime; there is no `src/adapters/engine/sdk/` implementation

**Email/SMS:**
- Not applicable

**Payment Processing:**
- Not applicable

## Data Storage

**Databases:**
- SQLite (default) — idempotency + ignore list
  - Connection: filesystem path `MIRA_DB_PATH` (default `mira.db`; Docker `/data/mira.db`)
  - Client: Node built-in `node:sqlite` `DatabaseSync` (`src/adapters/store/sqlite/sqlite-store.ts`)
  - Migrations: `CREATE TABLE IF NOT EXISTS` in `src/adapters/store/sqlite/schema.ts` — `MR_REVIEW`, `FINDING_RECORD`, `MR_IGNORE`
- PostgreSQL 16 (optional, scale-out)
  - Connection: `DATABASE_URL` or `POSTGRES_URL` when `MIRA_STORE=postgres`
  - Client: `pg` Pool, lazy-imported from `src/entrypoints/main.ts`; store `src/adapters/store/postgres/postgres-store.ts`
  - Image: `postgres:16-alpine` in `deploy/docker-compose.prod.yml` (SCRAM-SHA-256; not published to host)
  - Migrations: `src/adapters/store/postgres/schema.ts` — `mr_review`, `finding_record`, `mr_ignore` (lazy on first use)
  - Backup/restore scripts: `scripts/tools/backup-db.sh`, `scripts/tools/restore-db.sh`, `scripts/tools/psql.sh`

**File Storage:**
- Local filesystem only
  - Ephemeral MR checkouts: `WORKSPACE_ROOT` (Docker `/work`, volume `mira-work` or host `${MIRA_BASE}/work`)
  - Optional git object mirror cache: `MIRA_CHECKOUT_CACHE_DIR` (default `<WORKSPACE_ROOT|tmpdir>/mira-mirror-cache`; prod `/cache/mirrors`)
  - Policy YAML mount: `/etc/mira/config.yml` (from `deploy/config.yml` or `${MIRA_BASE}/config/config.yml`)
  - Prompt + profiles shipped in the image: `prompts/review.v1.md`, `profiles/`

**Caching:**
- In-process Kaiten read cache — `TtlCache` (`src/adapters/cache/ttl-cache.ts`) wrapping `KaitenTracker` when `MIRA_READ_CACHE=on` (default TTL 300000 ms, max 256 entries)
- Redis 7 (optional job queue, not a general cache)
  - Connection: `REDIS_URL` when `MIRA_QUEUE=redis`
  - Client: `ioredis`, lazy-imported; adapter `src/adapters/queue/redis/redis-queue.ts`
  - Keys: `{prefix}:queue` (list) and `{prefix}:pending` (dedup set); prefix default `mira` (`MIRA_QUEUE_PREFIX`)
  - Image: `redis:7-alpine` with `--requirepass` and AOF (`deploy/docker-compose.prod.yml`); CLI helper `scripts/tools/redis-cli.sh`
- Default queue: in-process FIFO `InProcQueue` (`src/adapters/queue/inproc/queue.ts`) — no Redis

## Authentication & Identity

**Auth Provider:**
- None for end users. Mira is a headless bot. There is no login, JWT, session, or OAuth app for humans.
  - Implementation: service credentials in environment, validated by `loadConfig()` (`src/config/index.ts`)
  - Token storage: process env only; Compose `env_file: deploy/.env` (generated by `scripts/app/gen-secrets.sh`, chmod 600, gitignored)
  - Session management: Not applicable

**OAuth Integrations:**
- GitLab clone uses HTTPS username `oauth2` with the PAT as password (`buildCloneUrl` in `src/core/context/checkout.ts`). This is GitLab's token-in-URL convention, not an OAuth2 authorization-code flow. Credentials in clone URLs are redacted in logs (`src/observability/redact.ts`, `oauth2:***@`).

**Service identities:**
- GitLab: `GITLAB_TOKEN` (bot `mira_review_bot` in production; do not use developer PATs for the service)
- Kaiten: `KAITEN_TOKEN` (personal read-only token @dev.konin in current ops)
- Cursor: `CURSOR_API_KEY` (Composer 2.5 access)
- Incoming webhooks: shared secret `GITLAB_WEBHOOK_SECRET` compared to `X-Gitlab-Token` (`verifyToken` in `src/entrypoints/api/webhook.ts`; empty secret skips verification)

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry/Datadog APM). Failures are structured logs (`poller.error`, `worker.error`, `engine_errors_total`) plus process `fatal` JSON on stderr from `src/entrypoints/main.ts`

**Analytics:**
- None

**Logs:**
- stdout JSON lines from `src/observability/logger.ts` (`createLogger`); every line passes `redact()` in `src/observability/redact.ts`
- Correlation fields: `service`, `role`, `project_id`, `mr_iid`, `head_sha`
- Production collection: Docker logging driver → optional Fluent Bit/Vector/Filebeat → Loki/ELK (documented in `docs/05-operations/observability.md`; not wired in-repo)

**Metrics:**
- In-process registry `src/observability/metrics.ts` (`createMetricRegistry`, `snapshot()`)
- Wired counters/histograms in `src/entrypoints/main.ts`: `reviews_total`, `review_duration_seconds`, `engine_errors_total`, `review_units_total`
- No Prometheus `/metrics` endpoint; `GET /healthz` is liveness only (`{"status":"ok"}`) and does not probe GitLab/Kaiten/Cursor/DB

## CI/CD & Deployment

**Hosting:**
- Dedicated server + Docker Compose (not Vercel/AWS Lambda)
  - MVP: `deploy/docker-compose.yml` one container `ROLE=all`
  - Production split: `deploy/docker-compose.prod.yml` (`api`, `poller`, `worker`, `postgres`, `redis`)
  - Image build: `deploy/Dockerfile`; entrypoint `deploy/entrypoint.sh` → `node dist/entrypoints/main.js`
  - Environment vars: host `.env` / `deploy/.env` / orchestrator secrets — never policy YAML
  - Ops wrappers: `scripts/app/up.sh`, `down.sh`, `build.sh`, `restart.sh`; `scripts/tools/health.sh`, `logs.sh`, `scale-workers.sh`, `update.sh`

**CI Pipeline:**
- None in-repo. No `.github/workflows/`, no `.gitlab-ci.yml`. GitLab CI is not used to deploy Mira (`docs/05-operations/deployment.md`).
- Quality gates are local npm scripts (`typecheck`, `lint`, `test`, `build`)

## Environment Configuration

**Development:**
- Required env vars: `CURSOR_API_KEY`, `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `KAITEN_BASE_URL`, `KAITEN_TOKEN`
- Secrets location: local `.env` (gitignored); names documented in `docs/03-reference/environment.md` and template `.env.example`
- Mock/stub services: unit tests inject fake `fetch` / git runner / spawn (`src/adapters/vcs/gitlab/gitlab-reader.test.ts`, `src/adapters/tracker/kaiten/kaiten-tracker.test.ts`, `src/adapters/engine/cli/cli-headless-engine.test.ts`). SQLite `:memory:` in store tests. No Stripe/local SaaS stubs.
- Single-MR PoC: `npm run dev` / CLI `poc` (`src/entrypoints/cli/poc.ts`) uses the same `loadConfig()` required vars

**Staging:**
- Not detected as a separate named environment. Same image and ENV contract as production; use a distinct `deploy/.env` and policy YAML if a staging host exists.

**Production:**
- Secrets management: `deploy/.env` on the server (generated passwords for Postgres/Redis; human-filled Cursor/GitLab/Kaiten tokens). Optional Vault/Docker secrets per `docs/05-operations/security.md`
- Failover/redundancy: single-host Compose; workers scale with `--scale worker=N` sharing Redis + Postgres. SQLite path is single-writer — do not run multiple workers on `MIRA_STORE=sqlite`
- Health: Compose `healthcheck` hits `http://localhost:8080/healthz`

## Webhooks & Callbacks

**Incoming:**
- GitLab → Mira `POST /webhook` (`src/entrypoints/api/server.ts`, parser `src/entrypoints/api/webhook.ts`)
  - Verification: `X-Gitlab-Token` vs `GITLAB_WEBHOOK_SECRET` (constant-time compare; empty secret = accept all)
  - Event header: `X-Gitlab-Event`
  - Events: `Merge Request Hook` (`object_kind=merge_request`) → enqueue `ReviewJob` when policy `reviewOn` matches (`open` / `ready` / `push` / `reopen`); `Note Hook` on MR notes → ChatOps (`src/core/chatops/parse.ts`: `@mira review`, `@mira ignore <fingerprint>`)
  - Responses: `401` bad secret, `400` bad JSON, `204` ignored event, `202` accepted
  - Debounce: 5 s window (`src/entrypoints/api/debounce.ts`) before `queue.enqueue`
  - Also served: `GET /healthz` on the same `node:http` server
  - Poller remains an independent trigger (`src/entrypoints/poller/poller.ts`) even when webhooks are enabled

**Outgoing:**
- GitLab MR notes/discussions when `MIRA_PUBLISHER=gitlab` (`GitLabPublisher` via `GitLabWriter`) — summary note marker `<!-- mira:summary -->` and per-finding discussion markers `<!-- mira:finding:<fingerprint> -->`
- No outbound webhooks to third parties
- Kaiten: no outbound writes
- Cursor: outbound only as the spawned `cursor-agent` process calling Cursor API

---

*Integration audit: 2026-09-09*
*Update when adding/removing external services*
