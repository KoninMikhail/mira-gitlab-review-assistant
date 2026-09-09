# Technology Stack

**Analysis Date:** 2026-09-09

## Languages

**Primary:**
- TypeScript 6.0.3 (strict ESM) — all application code under `src/`. `"type": "module"` in `package.json`. Compiler target `ES2022`, lib `ES2023`, `module`/`moduleResolution` `NodeNext` in `tsconfig.json`. Relative imports MUST use the `.ts` extension (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).

**Secondary:**
- Bash — host/ops scripts under `scripts/` (`scripts/root/`, `scripts/app/`, `scripts/tools/`, `scripts/lib/common.sh`) and `deploy/entrypoint.sh`
- YAML — review policy (`deploy/config.example.yml`, `MIRA_POLICY_CONFIG`) and Compose files (`deploy/docker-compose.yml`, `deploy/docker-compose.prod.yml`)
- Markdown — engine prompt `prompts/review.v1.md` and stack profiles `profiles/*.md` (go, java, node, python, frontend)
- JSON Schema (draft 2020-12) — wire contract `schema/findings.schema.json`
- SQL DDL — inline in `src/adapters/store/sqlite/schema.ts` and `src/adapters/store/postgres/schema.ts`

## Runtime

**Environment:**
- Node.js ≥24 (`engines.node` in `package.json`; Docker base `node:24-bookworm-slim` in `deploy/Dockerfile`)
- Native `.ts` execution (`node src/entrypoints/main.ts`) — no ts-node/tsx
- Built-in modules used as first-class infrastructure: `node:http`, `node:sqlite` (`DatabaseSync`), `node:child_process`, `node:fs`, `node:os`, `node:path`
- System `git` required for MR checkout (`src/core/context/checkout.ts`, `src/core/context/mirror-checkout.ts`)
- Cursor CLI binary `cursor-agent` required for the review engine (`src/adapters/engine/cli/cli-headless-engine.ts`); override path with `CURSOR_AGENT_BIN`
- No `.nvmrc` / `.node-version` — rely on `package.json` `engines` and the Docker image

**Package Manager:**
- npm (lockfileVersion 3)
- Lockfile: `package-lock.json` present; Docker install is `npm ci`

## Frameworks

**Core:**
- None. Vanilla Node.js process (hexagonal modular monolith). HTTP is `node:http` in `src/entrypoints/api/server.ts` — not Express/Fastify/Koa.
- Review engine: Cursor `cursor-agent` CLI headless (`CliHeadlessEngine` in `src/adapters/engine/cli/cli-headless-engine.ts`). Default model slug `composer-2.5`.
- `@cursor/sdk` `^1.0.19` is a production dependency in `package.json` but is **not imported** anywhere under `src/`. Do not wire new engine code through the SDK until an adapter exists; keep using the CLI port.

**Testing:**
- Node.js built-in test runner: `node --test "src/**/*.test.ts"` (`package.json` script `test`)
- Assertions: `node:assert` / `node:assert/strict` (co-located `src/**/*.test.ts`)
- No Jest, Vitest, Playwright, or coverage tool

**Build/Dev:**
- TypeScript 6.0.3 — `tsc -p tsconfig.json` emits `dist/` (`.js` + `.d.ts` + source maps)
- `tsconfig.test.json` — typecheck-only for `src/**/*.test.ts` and `src/**/fakes.ts`
- oxlint 1.70.0 — lint (`npm run lint` / `lint:fix`); config `.oxlintrc.json` (plugins `typescript`, `import`; `correctness` as error)
- oxfmt 0.55.0 — format (`npm run format` / `format:check`); config `.oxfmtrc.json` (semicolons, single quotes, trailing commas, printWidth 100, LF)
- `@types/node` 24.13.2 — Node typings

## Key Dependencies

**Critical:**
- `ajv` 8.20.0 — validates engine output against `schema/findings.schema.json` via `Ajv2020` in `src/core/findings/validateFindings.ts`
- `yaml` 2.9.0 — parses policy YAML in `src/config/policy-config.ts`
- `@cursor/sdk` 1.0.19 — declared for a future local-runtime engine adapter; current runtime path is CLI-only (`src/adapters/engine/cli/`)

**Infrastructure:**
- `node:sqlite` — default `StateStore` / `IgnoreStore` (`src/adapters/store/sqlite/sqlite-store.ts`)
- `node:http` — `/healthz` and `POST /webhook` (`src/entrypoints/api/server.ts`)
- `pg` `^8.13.1` (`optionalDependencies`) — Postgres `StateStore` when `MIRA_STORE=postgres` (`src/adapters/store/postgres/postgres-store.ts`); lazy-imported in `src/entrypoints/main.ts`
- `ioredis` `^5.4.1` (`optionalDependencies`) — Redis queue when `MIRA_QUEUE=redis` (`src/adapters/queue/redis/redis-queue.ts`); lazy-imported in `src/entrypoints/main.ts`
- Global `fetch` — GitLab REST client (`src/adapters/vcs/gitlab/client.ts`) and Kaiten HTTP client (`src/adapters/tracker/kaiten/http.ts`)
- No dotenv package — config is `process.env` via `loadConfig()` in `src/config/index.ts`

## Configuration

**Environment:**
- Loaded at startup from process environment (`src/config/index.ts`, `src/entrypoints/main.ts`). Missing required vars throw `ConfigError`.
- Template file `.env.example` exists (gitignored runtime `.env` / `deploy/.env`). Do not commit secrets.
- Required: `CURSOR_API_KEY`, `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `KAITEN_BASE_URL`, `KAITEN_TOKEN`
- Optional (see `src/config/index.ts` + `src/entrypoints/main.ts` + `docs/03-reference/environment.md` + `docs/02-guides/performance-scaling.md`):
  - `GITLAB_WEBHOOK_SECRET` — empty disables webhook verification
  - `ROLE` — `all` | `api` | `poller` | `worker` (default `all`)
  - `MIRA_POLICY_CONFIG` — path to policy YAML
  - `MIRA_PROFILES_DIR` — default `profiles`
  - `MIRA_DB_PATH` — default `mira.db`
  - `WORKSPACE_ROOT`, `MAX_CONCURRENCY` (default `1`), `POLL_INTERVAL_MS` (default `60000`), `HEALTH_PORT` (default `8080`)
  - `CURSOR_AGENT_BIN` — default `cursor-agent`
  - `MIRA_PUBLISHER` — `log` (default, dry-run) | `gitlab`
  - `MIRA_QUEUE` — `inproc` (default) | `redis` (+ `REDIS_URL`, `MIRA_QUEUE_PREFIX`)
  - `MIRA_STORE` — `sqlite` (default) | `postgres` (+ `DATABASE_URL` or `POSTGRES_URL`)
  - `MIRA_CHECKOUT` — `fresh` (default) | `mirror` (+ `MIRA_CHECKOUT_CACHE_DIR`)
  - `MIRA_READ_CACHE` — `off` (default) | `on` (+ `MIRA_READ_CACHE_TTL_MS`, default 300000)
- Policy YAML (not secrets): `defaults`, `discovery.projects`, per-project overrides — parsed in `src/config/policy-config.ts`. Example: `deploy/config.example.yml`.
- Composition-root constants (not env): `PROMPT_VERSION = review.v1`, `PARTITION_VERSION = single.v1` in `src/entrypoints/main.ts`

**Build:**
- `tsconfig.json` — emit to `dist/`, exclude tests and `fakes.ts`
- `tsconfig.test.json` — `noEmit` for tests
- `.oxlintrc.json` — lint
- `.oxfmtrc.json` — format
- `deploy/Dockerfile` — `npm ci` → `npm run build` → `npm prune --omit=dev`
- `schema/findings.schema.json` is loaded from disk at runtime (outside `rootDir: src`); do not import it into `tsc` emit

## Platform Requirements

**Development:**
- Node.js ≥24, npm, git
- Cursor CLI (`cursor-agent`) on PATH, or set `CURSOR_AGENT_BIN` (Windows: prefer the versioned `.cmd` under `versions/`, not the broken root wrapper)
- Any OS with Node 24; Windows, Linux, and macOS are supported for local runs (`npm run start:ts`, `npm run dev` for CLI watch)
- Optional local Redis/Postgres only when enabling `MIRA_QUEUE=redis` / `MIRA_STORE=postgres`
- Commands (`package.json`):
  ```bash
  npm run typecheck   # tsc src + tests
  npm run lint        # oxlint
  npm run format      # oxfmt
  npm test            # node --test src/**/*.test.ts
  npm run build       # tsc → dist/
  npm start           # node dist/entrypoints/main.js
  npm run start:ts    # node src/entrypoints/main.ts
  npm run dev         # node --watch src/entrypoints/cli/index.ts
  ```
- Before commit: `typecheck` + `lint` + `test`

**Production:**
- Dedicated Ubuntu Server (24.04+) running Docker Engine + Compose
- Image: `mira-review-bot:latest` from `deploy/Dockerfile` (`node:24-bookworm-slim` + git + curl + Cursor CLI installer)
- MVP compose: `deploy/docker-compose.yml` — single service `ROLE=all`, SQLite volume, in-process queue
- Split compose: `deploy/docker-compose.prod.yml` — `postgres:16-alpine`, `redis:7-alpine`, roles `api` / `poller` / `worker` (scale workers)
- Host layout and ops: `scripts/` (`MIRA_BASE` default `/opt/mira`)
- Ingress: `HEALTH_PORT` 8080 (`GET /healthz`, `POST /webhook`); prod API binds loopback by default (`HEALTH_PUBLISH`)
- Egress required: GitLab, Kaiten, Cursor API (see INTEGRATIONS.md)
- Alternative without Docker: systemd + `node dist/entrypoints/main.js` with the same ENV

---

*Stack analysis: 2026-09-09*
*Update after major dependency changes*
