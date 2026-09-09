# Architecture

**Analysis Date:** 2026-09-09

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         entrypoints (composition root)                  │
│  `src/entrypoints/main.ts`  ROLE=all|api|poller|worker                  │
│  `src/entrypoints/poller/`  `src/entrypoints/api/`  `src/entrypoints/cli/`│
├──────────────┬──────────────────────────────┬───────────────────────────┤
│  Poller      │  HTTP `/healthz` + `/webhook`│  CLI `poc` (manual run)   │
│  discover MR │  ChatOps `@mira` notes       │  bypasses queue           │
└──────┬───────┴──────────────┬───────────────┴──────────────┬────────────┘
       │                      │                              │
       ▼                      ▼                              │
┌──────────────────────────────────────────┐                 │
│  Queue port                              │                 │
│  `InProcQueue` or `RedisQueue`           │                 │
│  `src/adapters/queue/{inproc,redis}/`    │                 │
└──────────────────┬───────────────────────┘                 │
                   ▼                                         │
┌──────────────────────────────────────────┐                 │
│  Worker loop  `src/core/orchestrator/    │                 │
│               worker.ts`                 │                 │
└──────────────────┬───────────────────────┘                 │
                   ▼                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Review pipeline  `src/core/orchestrator/pipeline.ts`                   │
│  policy → seen? → ContextBuilder → partition → ReviewEngine             │
│  → aggregate → normalize → Publisher → StateStore.record → cleanup      │
├──────────────┬──────────────────┬──────────────────┬────────────────────┤
│  core/*      │  ports           │  adapters        │  observability     │
│  domain,     │  `core/ports/`   │  gitlab, kaiten, │  `src/observability/`│
│  policy,     │  interfaces only │  cli engine,     │  JSON log + metrics│
│  linking, …  │                  │  store, publisher│                    │
└──────────────┴──────────────────┴──────────────────┴────────────────────┘
         │                  ▲
         │ depends on       │ implements
         ▼                  │
┌─────────────────────────────────────────────────────────────────────────┐
│  External: GitLab REST  |  Kaiten REST (read-only)  |  Cursor CLI/API   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Pattern Overview

**Overall:** Hexagonal (ports & adapters) modular monolith — one deployable Node image, multiple process roles selected by `ROLE`.

**Key Characteristics:**
- Dependencies point inward: `core` never imports GitLab/Kaiten/Cursor SDKs; adapters implement ports from `src/core/ports/index.ts`.
- Single composition root for the service: `src/entrypoints/main.ts` wires adapters by env (`MIRA_QUEUE`, `MIRA_STORE`, `MIRA_PUBLISHER`, `MIRA_CHECKOUT`, `MIRA_READ_CACHE`).
- Stateless workers: durable state lives in `StateStore` (SQLite or Postgres); MR checkouts are ephemeral under `WORKSPACE_ROOT` / tmp.
- Degradation over abort: missing Kaiten card or a failed review unit continues the job with notes, not a hard fail.
- Behavior is versioned: `promptVersion` (`review.v1` plus optional profile fingerprint) and `partitionVersion` (`single.v1`) are part of the idempotency `ReviewKey`.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Composition root | Load config/policy/profiles, construct adapters, start roles, shutdown | `src/entrypoints/main.ts` |
| Poller | List open MRs for explicit discovery projects, enqueue jobs matching `review_on` | `src/entrypoints/poller/poller.ts` |
| API / webhook | `GET /healthz`, `POST /webhook` (GitLab MR + note hooks), ChatOps dispatch | `src/entrypoints/api/server.ts`, `src/entrypoints/api/webhook.ts` |
| Debouncer | Collapse webhook bursts per MR; drop exact job-key replays | `src/entrypoints/api/debounce.ts` |
| Worker loop | Bounded-concurrency `take` → handler; log handler errors, keep looping | `src/core/orchestrator/worker.ts` |
| Review pipeline | One `ReviewJob` through seen → context → partition → engine → aggregate → normalize → publish → record | `src/core/orchestrator/pipeline.ts` |
| Context builder | MR metadata + ephemeral checkout diff + optional Kaiten card | `src/core/context/context-builder.ts` |
| Linking | Extract card id from MR title/description/branch; degrade if lookup fails | `src/core/linking/resolve.ts` |
| Partitioner | Filter ignored/binary files; chunk by byte/token budget at file boundaries | `src/core/partition/partition.ts` |
| Aggregator | Merge unit results: worst verdict, dedup findings, worst requirement status | `src/core/aggregate/aggregate.ts` |
| Normalizer | Glob filter → strictness threshold → fingerprint dedup → cap | `src/core/normalize/normalize.ts` |
| Policy | Defaults, per-project merge, `resolvePolicy(projectId)` | `src/core/policy/merge.ts` |
| ChatOps parser | Pure `@mira review` / `@mira ignore <fp>` parser | `src/core/chatops/parse.ts` |
| GitLab reader | `VcsReader` + `VcsMrLister` over REST v4 (metadata + changed files, not unified diff) | `src/adapters/vcs/gitlab/reader.ts` |
| GitLab writer | `VcsWriter` note/discussion primitives for the publisher | `src/adapters/vcs/gitlab/writer.ts` |
| Kaiten tracker | Read-only `TaskTracker.getCard` | `src/adapters/tracker/kaiten/kaiten-tracker.ts` |
| CLI engine | Spawn `cursor-agent -p`, render `prompts/review.v1.md`, validate findings schema | `src/adapters/engine/cli/cli-headless-engine.ts` |
| Log publisher | Dry-run: structured log only | `src/adapters/publisher/log/log-publisher.ts` |
| GitLab publisher | Idempotent summary note + per-finding discussions (HTML comment markers) | `src/adapters/publisher/gitlab/gitlab-publisher.ts` |
| SQLite / Postgres store | `StateStore` + `IgnoreStore` | `src/adapters/store/sqlite/sqlite-store.ts`, `src/adapters/store/postgres/postgres-store.ts` |
| In-proc / Redis queue | Pending-job dedup by `JobKey` | `src/adapters/queue/inproc/queue.ts`, `src/adapters/queue/redis/redis-queue.ts` |
| Caching tracker | Optional TTL decorator over `TaskTracker` | `src/adapters/cache/caching-tracker.ts` |
| PoC CLI | Second composition root: one MR, no queue | `src/entrypoints/cli/poc.ts` |

## Layers

**Entrypoints:**
- Purpose: Composition root and process roles. Parse `ROLE`, construct adapters, start poller/worker/HTTP, handle signals. No review business logic.
- Location: `src/entrypoints/`
- Contains: `main.ts`, `poller/`, `api/` (HTTP + webhook parse + debounce), `cli/` (PoC). `entrypoints/worker/` is a placeholder; the loop lives in core.
- Depends on: `src/config/`, `src/core/*`, `src/adapters/*`, `src/observability/`
- Used by: `package.json` scripts `start` / `start:ts` / `dev`

**Core (domain + application):**
- Purpose: Review semantics independent of GitLab/Kaiten/Cursor. Orchestrate a job, build context, partition, aggregate, normalize, resolve policy and card links.
- Location: `src/core/`
- Contains: `domain/`, `ports/`, `orchestrator/`, `context/`, `partition/`, `aggregate/`, `normalize/`, `policy/`, `linking/`, `idempotency/`, `findings/`, `chatops/`
- Depends on: `src/core/domain`, `src/core/ports`, other `core` modules. Type-only leak: `src/core/context/context-builder.ts` imports `MiraConfig` from `src/config/index.ts` for `cloneUrlFromConfig`.
- Used by: entrypoints and adapters (adapters import domain types + port interfaces only)

**Ports:**
- Purpose: The only contracts core uses for IO. Adapters implement these.
- Location: `src/core/ports/index.ts`
- Contains: `VcsReader`, `VcsMrLister`, `VcsWriter`, `TaskTracker`, `ReviewEngine`, `Publisher`, `Queue`, `StateStore`, `IgnoreStore`, `Clock`, plus DTOs (`MrContext`, `ReviewKey`, …)
- Depends on: `src/core/domain/index.ts` types
- Used by: core orchestrator/context; every adapter; fakes in `src/core/ports/fakes.ts`

**Adapters:**
- Purpose: Thin translations of external APIs into ports. No pipeline policy, no aggregation.
- Location: `src/adapters/`
- Contains: `vcs/gitlab/`, `tracker/kaiten/`, `engine/cli/` (SDK/cloud are `.gitkeep` placeholders), `store/{sqlite,postgres}/`, `queue/{inproc,redis}/`, `publisher/{log,gitlab}/`, `cache/`
- Depends on: `src/core/ports/index.ts`, `src/core/domain/index.ts`, and for the engine `src/core/findings/` (schema validation)
- Used by: `src/entrypoints/main.ts` and `src/entrypoints/cli/poc.ts` only

**Config:**
- Purpose: Fail-fast typed ENV (`loadConfig`), YAML policy file, stack-profile Markdown loader.
- Location: `src/config/`
- Contains: `index.ts` (`MiraConfig`), `policy-config.ts`, `profiles.ts`
- Depends on: `src/core/policy/` types for `PolicyConfig` / `ProjectPolicy`
- Used by: entrypoints (and the type-only helper in context builder)

**Observability:**
- Purpose: JSON logger with secret/diff redaction, in-process metric registry, redaction helper.
- Location: `src/observability/`
- Contains: `logger.ts`, `metrics.ts`, `redact.ts`
- Depends on: Node stdio only (injected into pipeline as a structural `PipelineLogger`)
- Used by: composition root; pipeline via hooks/logger interface

**Guidance resources (not TypeScript layers):**
- Purpose: What the reviewer looks for — not mechanism.
- Location: `prompts/review.v1.md` (layer A), `profiles/<name>.md` (layer B); repo-local `.cursor/rules` / `AGENTS.md` in the MR checkout (layer C, read by the engine)

## Data Flow

### Primary Request Path (queued review)

1. Trigger produces a `ReviewJob` (`src/core/domain/index.ts`): poller `selectJobs` (`src/entrypoints/poller/poller.ts`), webhook `mrEventToJob` (`src/entrypoints/api/webhook.ts`), or ChatOps `handleNote` (`src/entrypoints/main.ts`).
2. `Queue.enqueue` dedups by `(projectId, mrIid, headSha)` while pending (`src/adapters/queue/inproc/queue.ts` or `src/adapters/queue/redis/redis-queue.ts`). Webhook jobs pass `Debouncer` first (`src/entrypoints/api/index.ts`).
3. `runWorker` pulls via `JobSource.take` (not the `Queue.dequeue` port method) and calls the pipeline handler (`src/core/orchestrator/worker.ts`).
4. `createReviewPipeline` resolves policy, folds profile fingerprint into `promptVersion`, builds `ReviewKey`, skips if `StateStore.seen` (`src/core/orchestrator/pipeline.ts`).
5. `ContextBuilder.build` loads MR via `VcsReader`, clones/checkouts, resolves Kaiten card, writes `.mira/context.json`, returns `{ context, workspaceDir, cleanup }` (`src/core/context/context-builder.ts`).
6. `partitionReview` yields `ReviewUnit[]` (`src/core/partition/partition.ts`). Empty units → ok result with no engine call.
7. `createEngine(workspaceDir, policy)` → `CliHeadlessEngine.review` per unit (`src/adapters/engine/cli/cli-headless-engine.ts`). Unit throw → `onEngineError` + skip that unit.
8. `aggregateResults` then `normalizeFindings` (`src/core/aggregate/aggregate.ts`, `src/core/normalize/normalize.ts`).
9. `Publisher.publish` then `StateStore.record`; `cleanup()` always runs in `finally`.

### Poller Discovery

1. `runPoller` ticks every `POLL_INTERVAL_MS` (`src/entrypoints/poller/poller.ts`).
2. `VcsMrLister.listOpenMergeRequests` per `policyConfig.discovery.projects`.
3. `selectJobs` skips drafts, non-opened, already-handled SHA, and projects with neither `reviewOn.open` nor `reviewOn.ready`.
4. Enqueue with trigger `open` or `ready`. Push/reopen are webhook-only.

### Webhook + ChatOps

1. `POST /webhook` verifies `X-Gitlab-Token` (`src/entrypoints/api/server.ts`).
2. `parseWebhookEvent` maps Merge Request / Note hooks (`src/entrypoints/api/webhook.ts`).
3. MR events → `mrEventToJob` → debounce → enqueue. Note events → `onNote` → `parseChatOps` (`src/core/chatops/parse.ts`): `review` enqueues `trigger: 'chatops'`; `ignore` writes `IgnoreStore`.

### PoC CLI (no queue)

1. `node src/entrypoints/cli/index.ts poc --project … --mr …` (`src/entrypoints/cli/poc.ts`).
2. Wires `GitLabReader` + `KaitenTracker` + checkout + `CliHeadlessEngine` directly; prints a summary. Does not call `createReviewPipeline` or persist `StateStore`.

**State Management:**
- Pending jobs: in-process memory (`InProcQueue`) or Redis (`RedisQueue`). In-proc cannot be shared across processes.
- Completed reviews + ignore list: `SqliteStateStore` (`MIRA_DB_PATH`, default `mira.db`) or `PostgresStateStore` (`DATABASE_URL`).
- Workspaces: ephemeral directories; optional bare mirror cache when `MIRA_CHECKOUT=mirror` (`src/core/context/mirror-checkout.ts`).
- Optional in-memory TTL cache around Kaiten reads (`src/adapters/cache/ttl-cache.ts`).
- No module-level mutable singletons in core; adapters hold client/db instances constructed in `main.ts`.

## Key Abstractions

**Port (interface):**
- Purpose: IO contract so core stays free of vendors.
- Examples: `VcsReader`, `ReviewEngine`, `Publisher`, `Queue`, `StateStore` in `src/core/ports/index.ts`
- Pattern: TypeScript interfaces + adapter classes; tests use `src/core/ports/fakes.ts`

**ReviewJob / JobKey / ReviewKey:**
- Purpose: Identity of work. `JobKey` is `(projectId, mrIid, headSha)`. `ReviewJob` adds `trigger` + `enqueuedAt`. `ReviewKey` adds `promptVersion` + `partitionVersion` for idempotency.
- Examples: `src/core/domain/index.ts`, `src/core/ports/index.ts`
- Pattern: Frozen identity types passed through queue and store

**ReviewPipeline factory:**
- Purpose: Close over deps and return `(job) => Promise<void>` for the worker.
- Examples: `createReviewPipeline` in `src/core/orchestrator/pipeline.ts`
- Pattern: Factory + structural logger/hooks (no observability import in core)

**ContextBuilder:**
- Purpose: Assemble `ReviewContext` (MR + diff + optional `TaskCard`) and an isolated checkout.
- Examples: `src/core/context/context-builder.ts`, `checkout.ts`, `workspace.ts`
- Pattern: Injectable `VcsReader`, `TaskTracker`, `CloneUrlBuilder`, `prepareCheckout`, `fs`, `Clock`

**Adapter class per system:**
- Purpose: Implement one or more ports; expose `fromConfig` / constructor options with injectable `fetch`/`spawn` for tests.
- Examples: `GitLabReader` (`src/adapters/vcs/gitlab/reader.ts`), `KaitenTracker` (`src/adapters/tracker/kaiten/kaiten-tracker.ts`), `CliHeadlessEngine` (`src/adapters/engine/cli/cli-headless-engine.ts`)
- Pattern: Thin HTTP/process wrapper; map vendor JSON → domain types

**Decorator adapter:**
- Purpose: Optional behavior without changing the port.
- Examples: `CachingTaskTracker` wrapping `KaitenTracker` (`src/adapters/cache/caching-tracker.ts`)
- Pattern: Decorator implementing the same port

**Policy merge:**
- Purpose: YAML defaults + per-project overrides → effective `ProjectPolicy`.
- Examples: `src/core/policy/defaults.ts`, `src/core/policy/merge.ts`, loader `src/config/policy-config.ts`
- Pattern: Pure merge; file IO stays in config layer

**Three-layer guidance:**
- Purpose: Separate “how to run” (YAML policy) from “what to look for” (Markdown).
- Examples: `prompts/review.v1.md`, `profiles/*.md`, `src/config/profiles.ts` (`name@sha8` folded into `ReviewKey`)
- Pattern: Template placeholders (`{{profile_guidance}}`); layer C is the MR checkout’s own Cursor rules

## Entry Points

**Service (`ROLE`):**
- Location: `src/entrypoints/main.ts` (`npm start` → `dist/entrypoints/main.js`, `npm run start:ts` → `src/entrypoints/main.ts`)
- Triggers: Process start. `ROLE` = `all` (default: poller + worker + HTTP), `api`, `poller`, `worker`.
- Responsibilities: `loadConfig` / policy / profiles, wire adapters, `createReviewPipeline`, `runWorker` / `runPoller` / `runApiServer`, SIGINT/SIGTERM abort + `queue.close()`.

**HTTP API:**
- Location: `src/entrypoints/api/server.ts` via `runApiServer` in `src/entrypoints/api/index.ts`
- Triggers: `GET /healthz`, `POST /webhook` with GitLab headers
- Responsibilities: Token check, JSON parse, event normalize, debounce enqueue, note callback for ChatOps. Default port `HEALTH_PORT` or 8080.

**Poller:**
- Location: `src/entrypoints/poller/poller.ts`
- Triggers: Interval loop (`POLL_INTERVAL_MS`, default 60s)
- Responsibilities: List open MRs for explicit discovery list; `selectJobs`; enqueue.

**CLI PoC:**
- Location: `src/entrypoints/cli/index.ts` → `src/entrypoints/cli/poc.ts` (`npm run dev` watches the CLI)
- Triggers: `mira poc --project <id> --mr <iid>` (plus `--no-engine`, `--keep`, …)
- Responsibilities: One-shot review for debugging; own wiring, not the service pipeline.

## Architectural Constraints

- **Threading:** Single-threaded Node event loop. Worker concurrency is N async handlers (`MAX_CONCURRENCY`, default 1), not OS threads. Units of one MR run sequentially inside the pipeline `for` loop.
- **Global state:** None in core. Composition root holds `AbortController`, queue, store. `InProcQueue` state is process-local. SQLite file is process-local unless switched to Postgres.
- **Circular imports:** Not present as a required cycle. Allowed direction: entrypoints → core + adapters; adapters → core ports/domain; config → policy types. Forbidden: core → adapters; adapters → entrypoints.
- **Queue port vs worker pull:** `Queue` in `src/core/ports/index.ts` is `enqueue`/`dequeue`/`size`. The worker requires `take(signal)` (`JobSource` in `src/core/orchestrator/worker.ts`). Composition root types this as `AppQueue`. New queue adapters must implement `take` + `close` (and optional `quit` for Redis).
- **Store surface:** Pipeline uses `StateStore`. ChatOps ignore and `GitLabPublisher` need `IgnoreStore`. Both SQLite and Postgres adapters implement both. New stores must implement both if ChatOps/GitLab publish stay enabled.
- **Kaiten write:** Forbidden under the personal token. `TaskTracker` is get-only. Do not add Kaiten write adapters without a bot token (see `.cursor/rules/kaiten-read-only.mdc`).
- **ESM imports:** Relative imports include the `.ts` extension (`tsconfig.json` `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`). No path aliases.

## Anti-Patterns

### Business logic in an adapter

**What happens:** GitLab/Kaiten/CLI modules start deciding verdicts, `review_on`, or finding caps.
**Why it's wrong:** Swapping CLI → SDK or GitLab → another VCS would fork the pipeline.
**Do this instead:** Keep mapping in `src/adapters/*`; put rules in `src/core/policy/`, `src/core/normalize/`, `src/core/orchestrator/pipeline.ts`.

### Importing adapters from `core`

**What happens:** `src/core/**` (except tests) imports `src/adapters/**`.
**Why it's wrong:** Breaks the hexagonal invariant and forces network into unit tests.
**Do this instead:** Depend on ports; inject fakes from `src/core/ports/fakes.ts`. Tests may import adapters (e.g. `src/core/orchestrator/worker.test.ts` uses `InProcQueue`) — production core must not.

### Wiring adapters outside the composition root

**What happens:** `new GitLabReader(...)` or `loadConfig()` inside `core` or a random adapter.
**Why it's wrong:** Multiple implicit composition roots; env/config scatter; hard to swap Redis/Postgres.
**Do this instead:** Construct in `src/entrypoints/main.ts` (service) or `src/entrypoints/cli/poc.ts` (PoC only). Prefer extending the pipeline rather than growing PoC into a third orchestrator.

### Skipping idempotency versions

**What happens:** Recording reviews by SHA only, ignoring `promptVersion` / `partitionVersion` / profile hash.
**Why it's wrong:** Prompt or profile edits would never re-review; stale findings stick.
**Do this instead:** Build `ReviewKey` as `createReviewPipeline` does (`src/core/orchestrator/pipeline.ts`) and persist all five fields in the store schema.

### Hard-fail on missing task card

**What happens:** Throwing when Kaiten lookup fails or no id is found.
**Why it's wrong:** Reviews of MRs without a card (or with a bad id) would never run.
**Do this instead:** `resolveCard` returns `{ found: false, reason }` (`src/core/linking/resolve.ts`); review the diff without `context.card`.

### Publishing from core

**What happens:** Core calling GitLab note APIs or logging “the” publication format.
**Why it's wrong:** Dry-run vs live publish is an adapter choice (`MIRA_PUBLISHER`).
**Do this instead:** Call `Publisher.publish` only. Default `LogPublisher`; `GitLabPublisher` when explicitly selected.

## Error Handling

**Strategy:** Fail fast at process start for config/profile/optional-backend wiring. During a job, degrade for expected gaps; throw for infrastructural failures so the worker can log and continue with the next job.

**Patterns:**
- Startup: `ConfigError` / `PolicyConfigError` / `ProfileError` / unknown `ROLE` / missing `REDIS_URL` or `DATABASE_URL` when those backends are selected — `main().catch` writes JSON to stderr and `process.exitCode = 1` (`src/entrypoints/main.ts`).
- Pipeline: `store.seen` skip is success. Engine per-unit `try/catch` → skip unit + `hooks.onEngineError`. Checkout/store failures propagate. `cleanup()` in `finally`.
- Worker: handler exceptions logged; loop does not stop (`src/core/orchestrator/worker.ts`).
- Poller: per-project list errors logged in `pollOnce`; other projects continue (`src/entrypoints/poller/poller.ts`).
- HTTP: 401 bad token, 400 bad JSON, 404 unknown path; parse functions return `undefined` rather than throw (`src/entrypoints/api/webhook.ts`).
- Vendor HTTP: `GitLabApiError` (`src/adapters/vcs/gitlab/client.ts`), `KaitenHttpError` (`src/adapters/tracker/kaiten/http.ts`). CLI PoC: `PocArgsError` for usage (`src/entrypoints/cli/poc.ts`).
- Findings: invalid agent JSON retried once then thrown (`src/adapters/engine/cli/cli-headless-engine.ts`); `validateFindings` in `src/core/findings/validateFindings.ts`.

## Cross-Cutting Concerns

**Logging:**
- `createLogger` in `src/observability/logger.ts`: JSON lines, `ts`/`level`/`msg`, `child()` fields, `redact` on every emit (`src/observability/redact.ts`). Pipeline takes a structural `PipelineLogger` so core does not import observability.

**Validation:**
- ENV via `loadConfig` (`src/config/index.ts`). Policy YAML via `parsePolicyConfig` (`src/config/policy-config.ts`). Agent output via AJV against `schema/findings.schema.json` (`src/core/findings/validateFindings.ts`). Webhook token compared in constant time (`verifyToken` in `src/entrypoints/api/webhook.ts`). Profiles must exist for every name referenced in policy (`assertProfilesResolvable` in `src/config/profiles.ts`).

**Authentication:**
- No end-user auth. Service uses GitLab `PRIVATE-TOKEN`, Kaiten token, `CURSOR_API_KEY`, optional `GITLAB_WEBHOOK_SECRET`. Tokens live in ENV (`.env` present locally; template `.env.example`). Never log raw tokens — rely on redact.

**Metrics:**
- In-process registry `src/observability/metrics.ts`. Pipeline hooks increment `reviewsTotal`, `reviewDurationSeconds`, `reviewUnitsTotal`, `engineErrorsTotal` from `src/entrypoints/main.ts`.

**Idempotency:**
- Queue: pending `JobKey`. Store: completed `ReviewKey`. Publisher: HTML markers `<!-- mira:summary -->` / `<!-- mira:finding:<fp> -->` in `src/adapters/publisher/gitlab/gitlab-publisher.ts`. Finding fingerprints: `src/core/idempotency/fingerprint.ts` (duplicated in store adapters for SQL rows).

---

*Architecture analysis: 2026-09-09*
*Update when major patterns change*
