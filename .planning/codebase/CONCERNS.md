# Codebase Concerns

**Analysis Date:** 2026-09-09

## Tech Debt

**Publisher stays dry-run unless explicitly switched:**
- Issue: Live MR comments exist in `GitLabPublisher`, but composition root defaults to `LogPublisher`.
- Files: `src/entrypoints/main.ts` (`createPublisher`, `MIRA_PUBLISHER`), `src/adapters/publisher/log/log-publisher.ts`, `src/adapters/publisher/gitlab/gitlab-publisher.ts`, `.env.example`
- Why: Write access to pilot repos is still blocked (🔑P2); ops webhook (T2.6) is not done. Dry-run is the safe default.
- Impact: Reviews never appear on GitLab until `MIRA_PUBLISHER=gitlab` **and** the bot token can write notes. Operators can flip the flag too early and publish as whoever owns `GITLAB_TOKEN`.
- Fix approach: Keep default `log`. Gate `gitlab` on bot membership + webhook secret. Do not reuse a personal GitLab token for write.

**CLI engine instead of `@cursor/sdk`:**
- Issue: `@cursor/sdk` is a production dependency but no code imports it. Review runs `cursor-agent` via `CliHeadlessEngine`. SDK/cloud adapters are empty placeholders.
- Files: `package.json`, `src/adapters/engine/cli/cli-headless-engine.ts`, `src/adapters/engine/sdk/.gitkeep`, `src/adapters/engine/cloud/.gitkeep`
- Why: ADR 004: CLI for MVP, SDK local runtime in phase 3 (`tasks/phase-3-quality-scale.md` T3.1).
- Impact: Extra native optional packages in install; 10-minute CLI subprocess, stdout buffering, Windows wrapper issues. No SDK session/tooling control.
- Fix approach: Implement `SdkLocalEngine` behind `ReviewEngine` (T3.1). Move `@cursor/sdk` out of runtime deps until then, or keep it only when the adapter lands.

**TTL workspace GC is implemented but never scheduled:**
- Issue: `gcWorkspaces` exists and is tested, but `src/entrypoints/main.ts` never calls it. Cleanup is only `ContextBuilder` `finally` `rm`.
- Files: `src/core/context/workspace.ts`, `src/core/context/context-builder.ts`, `src/entrypoints/main.ts`
- Why: Per-job `cleanup()` was enough for the happy path; TTL GC was marked done in T1.6 without wiring a timer.
- Impact: Crash or failed `rm` leaves checkouts (and embedded GitLab tokens in `.git/config`) under `WORKSPACE_ROOT` / tmp until manual delete.
- Fix approach: Call `gcWorkspaces` on a timer from the composition root (same `WORKSPACE_ROOT`), log removed paths, alert on leftover dirs.

**Inline discussion positions are not wired:**
- Issue: `GitLabPublisher` only creates inline discussions when `resolvePosition` is passed. `createPublisher` never supplies it, so every finding is a general discussion.
- Files: `src/adapters/publisher/gitlab/gitlab-publisher.ts`, `src/entrypoints/main.ts`
- Why: Position mapping from finding `filePath`/`lineStart` to GitLab `diff_refs` was left optional.
- Impact: Comments are harder to act on; GitLab cannot anchor to the changed line.
- Fix approach: Resolve `base_sha`/`start_sha`/`head_sha` from MR `diff_refs` in the writer/reader path and pass a resolver into `GitLabPublisher`.

**Missing-card degradation is dropped:**
- Issue: Architecture says “no card → review by diff and mark degradation”. `resolveCard` returns `reason`, but `ContextBuilder.build` only attaches `card` when `found` is true and does not pass `reason` into the pipeline result.
- Files: `src/core/context/context-builder.ts`, `src/core/linking/resolve.ts`, `src/core/orchestrator/pipeline.ts`
- Why: Prompt placeholders already say “no linked card”; result-level `degradations` were left to the engine.
- Impact: Published summary/logs often omit that Kaiten lookup failed or the id was missing, so coverage looks complete when it is not.
- Fix approach: Map `cardResolution.reason` into `ReviewResult.degradations` in the pipeline (or on the context) before publish.

**Composition root comment and Memory Bank lag the tree:**
- Issue: `src/entrypoints/main.ts` still says the api role is `/healthz` only. `docs/_ai/codebase-map.md` omits `adapters/publisher/gitlab`, `entrypoints/api`, `core/chatops`. `tasks/execution-order.md` still lists Redis/Postgres as phase-3 TODO though adapters exist.
- Files: `src/entrypoints/main.ts`, `docs/_ai/codebase-map.md`, `docs/_ai/integrations.md`, `tasks/execution-order.md`
- Why: Phase 2 and scaling adapters landed faster than docs/task checkboxes.
- Impact: Agents and humans miss webhook, ChatOps, and store/queue flags; they may re-implement existing ports.
- Fix approach: Refresh memory-bank map and task statuses to match `src/` (do not treat task files as runtime truth).

**Core test imports an adapter:**
- Issue: Production `src/core/**` does not import `adapters/`. `src/core/orchestrator/worker.test.ts` imports `InProcQueue` from `src/adapters/queue/inproc/`.
- Files: `src/core/orchestrator/worker.test.ts`, `src/core/ports/fakes.ts`
- Why: Convenient real queue for worker-loop tests.
- Impact: Core test graph depends on an adapter; a queue change can break “pure core” tests. Hexagon is intact for runtime.
- Fix approach: Drive `runWorker` tests with the local `FakeJobSource` already in that file (or a fake in `src/core/ports/fakes.ts`).

**`ContextBuilder` depends on `MiraConfig`:**
- Issue: `cloneUrlFromConfig` in core imports `MiraConfig` from `src/config/index.ts`.
- Files: `src/core/context/context-builder.ts`, `src/config/index.ts`
- Why: Convenience helper for the composition root/PoC.
- Impact: Core context module is coupled to env-config shape; swapping config layout touches core.
- Fix approach: Move `cloneUrlFromConfig` to `src/entrypoints/` (or `adapters/vcs/gitlab`) and keep core on `CloneUrlBuilder` only.

**Postgres `record` is not a single transaction:**
- Issue: `PostgresStateStore.record` runs sequential `pool.query` calls. The file notes a transaction would need a dedicated client. `finding_record` has no FK to `mr_review` (SQLite schema does).
- Files: `src/adapters/store/postgres/postgres-store.ts`, `src/adapters/store/postgres/schema.ts`, `src/adapters/store/sqlite/schema.ts`
- Why: `PgPoolLike` only exposes `query`, not `connect`/`BEGIN`.
- Impact: Crash mid-record can leave a review row without findings (or the reverse if insert order is ever changed). Multi-worker visibility of partial rows.
- Fix approach: Extend the pool port with a client/transaction and wrap `record` in `BEGIN`/`COMMIT`. Add FKs to match SQLite.

## Known Bugs

**Poller treats enqueue as “handled”, so failed reviews never retry:**
- Symptoms: After a checkout/engine/store error, the same open MR SHA is not enqueued again until process restart. Worker logs the error and continues (`runWorker` swallows handler errors).
- Trigger: Any thrown pipeline error after `queue.enqueue` succeeds. Poller `handled` Set is updated in `src/entrypoints/main.ts` when enqueue returns true, not when `store.record` succeeds.
- Files: `src/entrypoints/main.ts` (poller `handled` / `alreadyHandled`), `src/entrypoints/poller/poller.ts`, `src/core/orchestrator/worker.ts`, `src/core/orchestrator/pipeline.ts`
- Workaround: Restart the process (in-memory Set clears) or push a new SHA.
- Root cause: Dedup key lives in the poller, not in `StateStore.seen`. `InProcQueue` also drops the pending key on `take`, so the queue will not block a retry — the poller will.
- Blocked by: None (code fix). A durable “in-flight / failed” state belongs in the store (T3.2 dead-letter).

**`@mira review` / `--full` cannot re-review a recorded SHA:**
- Symptoms: ChatOps `review` enqueues a job, pipeline hits `store.seen` and logs `review.skip.seen`. `command.full` is only logged.
- Trigger: Comment `@mira review` or `@mira review --full` on an MR whose `(sha, promptVersion, partitionVersion)` is already in the store.
- Files: `src/entrypoints/main.ts` (`handleNote`), `src/core/chatops/parse.ts`, `src/core/orchestrator/pipeline.ts`
- Workaround: Change prompt/profile (new idempotency key) or delete the store row.
- Root cause: Parser supports `full`, pipeline has no bypass. Idempotency is unconditional.
- Fix: Honor `--full` (and/or `trigger: 'chatops'`) by skipping `seen` or recording a new run id.

**Webhook and ChatOps enqueue errors are discarded:**
- Symptoms: Redis/queue failures on webhook flush or ChatOps do not fail the HTTP handler; jobs vanish with no error log from `enqueue`.
- Trigger: `POST /webhook` while Redis is down, or `handleNote` throws (store `ignore` failure).
- Files: `src/entrypoints/main.ts` (`void queue.enqueue`, `void handleNote`), `src/entrypoints/api/index.ts`
- Workaround: Watch queue depth / Redis; replay the webhook.
- Root cause: Fire-and-forget `void` plus `runApiServer` `onFlush: enqueue` with a sync `enqueue` wrapper that does not await.
- Fix: Await enqueue, log failures, return 503 from `/webhook` when the queue rejects (or retry). Catch `handleNote`.

**Queue pending-set is released on `take`, so two workers can review the same SHA:**
- Symptoms: Duplicate CLI runs and duplicate publish attempts for one JobKey while the first job is still in the pipeline (`seen` is still false until `record` at the end).
- Trigger: Webhook + poller, ChatOps + poller, or `MAX_CONCURRENCY` > 1 / multiple Redis workers, for the same `(projectId, mrIid, headSha)`.
- Files: `src/adapters/queue/inproc/queue.ts`, `src/adapters/queue/redis/redis-queue.ts`, `src/core/orchestrator/pipeline.ts`
- Workaround: Default `MAX_CONCURRENCY=1` and single process reduce races; `GitLabPublisher` is somewhat idempotent by markers.
- Root cause: Pending dedup tracks “in the queue”, not “in flight”. `seen`/`record` is not an atomic claim.
- Fix: Keep JobKey in pending until handler success/failure; or `INSERT` a claim row before work (Postgres `ON CONFLICT`).

**Redis queue can lose or stuck-dedup jobs on crash:**
- Symptoms: Job never runs, and later enqueue of the same key returns `false`; or job disappears after `blpop` with no review.
- Trigger: Process crash between `sadd` and `rpush` (`src/adapters/queue/redis/redis-queue.ts`), or after `blpop` before `srem` / before `store.record`.
- Files: `src/adapters/queue/redis/redis-queue.ts`
- Workaround: Manually `SREM` the pending member / use inproc for single-node MVP.
- Root cause: No Lua atomicity, no visibility timeout, no ACK.
- Blocked by: Durability work (T3.2). Do not treat Redis as safe multi-worker until this is fixed.

**CLI timeout can reject twice:**
- Symptoms: After `timeoutMs`, logs may show `spawn aborted` as an unhandled rejection in addition to the timeout error.
- Trigger: Agent run exceeding `timeoutMs` (default 600_000 in `src/adapters/engine/cli/cli-headless-engine.ts`).
- Files: `src/adapters/engine/cli/cli-headless-engine.ts` (`Promise.race`), `src/adapters/engine/cli/spawn.ts` (abort → `reject`)
- Workaround: None needed for functional outcome (job still fails); noisy process warnings.
- Root cause: `Promise.race` does not attach a catch to the loser; abort rejects the spawn promise later.
- Fix: `AbortSignal` kill without rejecting twice, or `.catch` the raced spawn.

## Security Considerations

**Kaiten token is a personal read credential in a long-running service:**
- Risk: Compromise of the Mira host or logs exposes `@dev.konin` Kaiten access. Any future write call would run as that user. Workspace rule and ADR 008 forbid writes under this token.
- Files: `src/adapters/tracker/kaiten/http.ts` (GET only), `src/adapters/tracker/kaiten/kaiten-tracker.ts`, `src/config/index.ts`, `.cursor/rules/kaiten-read-only.mdc`
- Current mitigation: `KaitenHttpClient` implements only `get`. No POST/PUT/PATCH/DELETE in `src/adapters/tracker/`. Startup requires `KAITEN_TOKEN` but does not use it for write.
- Recommendations: Keep the adapter read-only. Do not add write helpers “for later”. Replace with a Kaiten **service** token when write-back is designed (phase 3+). Never call MCP `kaiten_create_*` / `kaiten_update_*` with this token.

**`cursor-agent` inherits the full process environment:**
- Risk: Prompt injection or agent tools in the MR checkout can read `GITLAB_TOKEN`, `KAITEN_TOKEN`, `DATABASE_URL`, `REDIS_URL`, not only `CURSOR_API_KEY`. `docs/05-operations/security.md` §4 claims only `CURSOR_API_KEY` is passed; the code merges `process.env`.
- Files: `src/adapters/engine/cli/cli-headless-engine.ts` (`this.#env = { ...process.env, ...options.env }`), `src/entrypoints/main.ts` (`engineOptions`), `docs/05-operations/security.md`
- Current mitigation: `--force --trust` is still used; publisher write is a separate Node process. Findings are schema-validated. Redaction applies to Mira logs, not to the child env.
- Recommendations: Spawn with an explicit allowlist env (`CURSOR_API_KEY`, `PATH`, `HOME`, locale). Do not spread `process.env`. Treat security.md as the target, not the current behavior.

**GitLab token is embedded in clone URLs and persisted on disk:**
- Risk: `oauth2:<token>@` is written to `.git/config` of every checkout. Mirror mode (`MIRA_CHECKOUT=mirror`) persists a bare repo under `MIRA_CHECKOUT_CACHE_DIR`, so the token survives process restart. Failed `cleanup()` leaves ephemeral clones too.
- Files: `src/core/context/checkout.ts` (`buildCloneUrl`), `src/core/context/mirror-checkout.ts`, `src/core/context/context-builder.ts`
- Current mitigation: Errors redact `oauth2:` credentials. Workspaces are deleted on the success path. Clone uses `GIT_TERMINAL_PROMPT=0`.
- Recommendations: Use `insteadOf` / credential helper / `GIT_ASKPASS` so the remote URL is token-free. Restrict `WORKSPACE_ROOT` and mirror cache permissions. Wire `gcWorkspaces`.

**CLI runs `--force --trust` on untrusted MR trees:**
- Risk: The agent may execute repo hooks/tools from attacker-controlled files in the checkout.
- Files: `src/adapters/engine/cli/cli-headless-engine.ts` (args `-p --output-format json --model … --force --trust`)
- Current mitigation: Ephemeral workspace; no GitLab write tools in the agent; findings JSON is validated by `src/core/findings/validateFindings.ts`.
- Recommendations: Drop `--trust` if the CLI allows; network-isolate the child; run the agent as a non-root user without GitLab/Kaiten tokens in env (see above).

**Webhook secret may be empty (verification off):**
- Risk: Anyone who can reach `POST /webhook` can enqueue reviews and drive ChatOps (`@mira ignore` mutes findings for the MR; `@mira review` spends Cursor quota).
- Files: `src/config/index.ts` (`webhookSecret: env['GITLAB_WEBHOOK_SECRET'] ?? ''`), `src/entrypoints/api/webhook.ts` (`verifyToken` returns true when `secret === ''`), `src/entrypoints/api/server.ts`
- Current mitigation: Constant-time compare when a secret is set. Unrecognized events return 204. Policy `enabled` / `reviewOn` still apply to MR hooks.
- Recommendations: Fail startup if `ROLE` is `api`/`all` and `GITLAB_WEBHOOK_SECRET` is empty. Add reverse-proxy IP allowlist and TLS (called out in `docs/05-operations/security.md` §6, not implemented in Node). Cap `readBody` size.

**ChatOps has no author allowlist:**
- Risk: Any GitLab user who can comment can mute fingerprints (`IgnoreStore`) or enqueue work. `NoteWebhookEvent.author` is parsed and unused.
- Files: `src/entrypoints/api/webhook.ts`, `src/entrypoints/main.ts` (`handleNote`), `src/core/chatops/parse.ts`
- Current mitigation: Commands must match `@mira …`. Ignore is per MR fingerprint, not global.
- Recommendations: Restrict to maintainers / a configured username list; ignore unknown authors.

**Dockerfile installs Cursor CLI via `curl | bash`:**
- Risk: Supply-chain execution at image build as root.
- Files: `deploy/Dockerfile`
- Current mitigation: Documented in `docs/05-operations/security.md` §9 as pin/verify at build time; the Dockerfile does not pin a checksum.
- Recommendations: Pin installer URL + hash or copy a known `cursor-agent` binary.

**Same `GITLAB_TOKEN` for read, clone, and write:**
- Risk: Turning `MIRA_PUBLISHER=gitlab` publishes as that token’s identity. A personal token would comment as a human.
- Files: `src/config/index.ts`, `src/entrypoints/main.ts` (`GitLabReader.fromConfig`, `GitLabWriter.fromConfig`)
- Current mitigation: Default publisher is `log`. Bot account `mira_review_bot` (id=30) is the intended writer; 🔑P2 membership is still missing.
- Recommendations: Separate read vs write tokens if GitLab allows; never enable `gitlab` publisher on a personal PAT.

## Performance Bottlenecks

**Serial `cursor-agent` is the cost of a review:**
- Problem: Pipeline reviews units in a `for` loop (no parallel engine). Each call defaults to 10 minutes timeout. Spawn captures unbounded stdout/stderr in memory.
- Files: `src/core/orchestrator/pipeline.ts`, `src/adapters/engine/cli/cli-headless-engine.ts`, `src/adapters/engine/cli/spawn.ts`
- Measurement: No in-repo p95. `docs/02-guides/performance-scaling.md` states cost is almost entirely the agent run (**minutes**), not Redis/SQLite.
- Cause: CLI subprocess + Composer 2.5; partition mode `single` still fans out extra units when the diff exceeds `contextBudget.maxChunkTokens` (default 60_000 **bytes** in `src/core/policy/defaults.ts`).
- Improvement path: Mirror checkout (`MIRA_CHECKOUT=mirror`), raise `MAX_CONCURRENCY` only with Postgres + Redis after in-flight dedup is fixed, then SdkLocalEngine (T3.1). Cap spawn output size.

**Fresh blobless clone per job:**
- Problem: Every review clones the repo (`--filter=blob:none`), fetches two branches, checks out, diffs.
- Files: `src/core/context/checkout.ts`, `src/entrypoints/main.ts` (default `MIRA_CHECKOUT=fresh`)
- Measurement: Not instrumented (no histogram around checkout). Expected to dominate non-agent wall time on large repos.
- Cause: Isolation over reuse.
- Improvement path: `MIRA_CHECKOUT=mirror` (`src/core/context/mirror-checkout.ts`) with a persistent volume. Token-free remotes (security) before sharing mirrors across hosts.

**GitLab HTTP has no timeout; poller is sequential per project:**
- Problem: `GitLabClient` and `KaitenHttpClient` use `fetch` without `AbortSignal`. Hung API stalls the poller tick or context build. `pollOnce` lists projects one-by-one; `getMrContext` also pages `/diffs`.
- Files: `src/adapters/vcs/gitlab/client.ts`, `src/adapters/tracker/kaiten/http.ts`, `src/entrypoints/poller/poller.ts`, `src/adapters/vcs/gitlab/reader.ts`
- Measurement: Not collected. 429 retries: max 2 with 1s default backoff (`GitLabClient`).
- Cause: Thin clients; MVP assumed a fast internal GitLab.
- Improvement path: Per-request timeouts; parallelize project listing; reuse local diff only (diffs API is already not used for the unified diff).

**Webhook body is unbounded:**
- Problem: `readBody` concatenates the entire request into a Buffer.
- Files: `src/entrypoints/api/server.ts`
- Measurement: Not applicable until abused; memory grows with payload size.
- Cause: No `Content-Length` cap.
- Improvement path: Reject bodies over a few hundred KB; 413.

**SQLite `DatabaseSync` on the event loop:**
- Problem: `node:sqlite` `DatabaseSync` runs migrate/`seen`/`record` synchronously. No WAL/`busy_timeout`.
- Files: `src/adapters/store/sqlite/sqlite-store.ts`, `src/adapters/store/sqlite/schema.ts`
- Measurement: Fine for one worker and tiny rows; will stall the loop under multi-worker lock contention (called out in `docs/02-guides/performance-scaling.md`).
- Cause: MVP single-node store.
- Improvement path: `MIRA_STORE=postgres` for >1 worker; enable WAL if SQLite remains.

## Fragile Areas

**Idempotency key vs ChatOps / profile edits:**
- Why fragile: Skip is keyed by SHA + `promptVersion` + `partitionVersion` (+ profile fingerprint). Constants `PROMPT_VERSION = 'review.v1'` and `PARTITION_VERSION = 'single.v1'` live only in `src/entrypoints/main.ts`.
- Common failures: Bumping the prompt file without bumping `PROMPT_VERSION` skips re-review; bumping the constant re-reviews every open SHA (comment storms if publisher is `gitlab`).
- Safe modification: Change prompt and version together; document in ADR/pipeline docs. Add `--full` before relying on ChatOps.
- Test coverage: Pipeline skip is tested in `src/core/orchestrator/pipeline.test.ts`. Composition-root version wiring is untested.

**Ingress debounce `seenKeys` never shrinks:**
- Why fragile: `Debouncer` stores every `(project, mr, sha, trigger)` for process lifetime (`src/entrypoints/api/debounce.ts`). ChatOps path bypasses the debouncer (`onNote` → `handleNote`).
- Common failures: Long-running api process grows memory; ChatOps `review` can race a debounced push for the same SHA.
- Safe modification: Bound/TTL the set; run ChatOps through the same queue key as MR jobs.
- Test coverage: Unit tests in `src/entrypoints/api/debounce.test.ts`. `runApiServer` wiring is not integration-tested.

**Publisher markers and ignore list:**
- Why fragile: Idempotency depends on HTML comments `<!-- mira:summary -->` / `<!-- mira:finding:… -->` surviving GitLab Markdown. `@mira ignore` keys `MR_IGNORE` by fingerprint across SHAs with no undo and no author check.
- Files: `src/adapters/publisher/gitlab/gitlab-publisher.ts`, `src/adapters/store/sqlite/schema.ts`
- Common failures: Humans editing the summary note break updates; wrong fingerprint mutes a finding forever on that MR.
- Safe modification: Keep markers on the first line; add `unignore` ChatOps before encouraging ignore in prod.
- Test coverage: `src/adapters/publisher/gitlab/gitlab-publisher.test.ts` covers create/update/resolve/mute with fakes. No live GitLab tests (🔑P2).

**Windows `cursor-agent` + `shell: true`:**
- Why fragile: Root `cursor-agent.cmd` is documented as broken; `spawn.ts` uses `shell: true` on win32. `CURSOR_AGENT_BIN` is unsanitized.
- Files: `src/adapters/engine/cli/spawn.ts`, `src/adapters/engine/cli/cli-headless-engine.ts`, `docs/_ai/tech-stack.md`
- Common failures: Engine cannot start; shell metacharacters in `CURSOR_AGENT_BIN` become command injection.
- Safe modification: Pass versioned `.cmd` via env; keep `shell: false` with `windowsVerbatimArguments` if possible.
- Test coverage: Spawn real process is not tested; engine tests inject `spawn`.

**`ROLE=all` vs Redis/Postgres:**
- Why fragile: One process can mix inproc queue + sqlite (correct MVP) or redis + sqlite (documented as unsafe). Poller’s `handled` Set is per process — two poller replicas duplicate enqueue (queue dedup only while pending).
- Files: `src/entrypoints/main.ts`, `docs/02-guides/performance-scaling.md`
- Common failures: Duplicate reviews; SQLite lock errors.
- Safe modification: One poller replica; `MIRA_STORE=postgres` with `MIRA_QUEUE=redis`; never scale sqlite.
- Test coverage: No multi-process tests.

**Partition oversized files:**
- Why fragile: A single file larger than `maxChunkTokens` becomes one unit anyway (`src/core/partition/partition.ts`). Engine may truncate or fail schema validation (one retry).
- Common failures: Huge generated files not in `ignoredGlobs` blow the budget; binary detection via empty GitLab diff can mis-label (`src/adapters/vcs/gitlab/reader.ts`).
- Safe modification: Extend `ignoredGlobs` / strictness; add hunk-level split only with a `partitionVersion` bump.
- Test coverage: `src/core/partition/partition.test.ts` covers budget splits. GitLab `too_large`/`collapsed` is not treated as skip.

## Scaling Limits

**Single-process in-memory queue + SQLite:**
- Current capacity: Default `MAX_CONCURRENCY=1`, `POLL_INTERVAL_MS=60_000`, `ROLE=all`. Throughput ≈ 1 in-flight review per process.
- Limit: SQLite one writer; `InProcQueue` does not share across processes. Agent timeout 10 min/unit.
- Symptoms at limit: Jobs wait in memory; process restart drops the inproc queue; poller Set forgets failures (see bugs).
- Scaling path: `MIRA_QUEUE=redis` + `MIRA_STORE=postgres` **after** in-flight dedup, Redis ACK, and Postgres transactions. Documented in `docs/02-guides/performance-scaling.md`.

**Kaiten read cache:**
- Current capacity: Default off. When `MIRA_READ_CACHE=on`: TTL 300_000 ms, max 256 entries (`src/entrypoints/main.ts`).
- Limit: Stale acceptance criteria for up to TTL; 256 cards then eviction.
- Symptoms at limit: Reviews use outdated checklists; or cache miss storm if off.
- Scaling path: Keep TTL short; cache is optional.

**Metrics are in-process only:**
- Current capacity: Counters/histograms in `src/observability/metrics.ts`; hooks in `createReviewPipeline`.
- Limit: No `/metrics` scrape endpoint; `tokens_used_total` is named but unused. `/healthz` always `{"status":"ok"}` without store/queue/GitLab checks.
- Symptoms at limit: Cannot alert on engine errors or queue depth from outside.
- Scaling path: Expose Prometheus snapshot; make `/healthz` check store + optional Redis PING (T3.7).

**Debounce window:**
- Current capacity: 5s default (`src/entrypoints/api/index.ts`).
- Limit: Burst of pushes collapses to latest SHA (good); ChatOps bypasses it.
- Symptoms at limit: Rapid ChatOps + webhook can double-enqueue (queue pending may collapse one).
- Scaling path: Route all ingress through one JobKey + in-flight claim.

## Dependencies at Risk

**`@cursor/sdk` ^1.0.19:**
- Risk: Declared runtime dependency, unused. Pulls platform optional binaries. Version will drift from the CLI `cursor-agent` actually invoked.
- Impact: Larger image/install; false sense that SDK local runtime is live.
- Migration plan: Implement `src/adapters/engine/sdk/` (T3.1) or demote to a commented/optional dep until then.

**`cursor-agent` CLI (not an npm package):**
- Risk: Installed in Docker via `curl https://cursor.com/install | bash` (`deploy/Dockerfile`). Windows root wrapper is broken (need versioned `.cmd`). Headless JSON envelope parsing is defensive/best-effort (`parseFindingsFromStdout`).
- Impact: Image builds and reviews fail when Cursor changes CLI flags or output shape. Findings retry once on schema failure only.
- Migration plan: Pin CLI version in the image; golden-test envelope fixtures; switch default engine to SDK.

**`ioredis` and `pg` optionalDependencies:**
- Risk: Default `npm ci` may omit them depending on install flags; `createQueue`/`createStore` dynamic `import('ioredis')` / `import('pg')` fail at runtime if missing. Redis/Postgres adapters are ahead of the phase-3 task list.
- Impact: Setting `MIRA_QUEUE=redis` without the package crashes startup.
- Migration plan: Document `npm install ioredis pg` on worker images; add startup check with a clear error (partially present for missing URLs).

**Node ≥24 + `node:sqlite`:**
- Risk: `DatabaseSync` API is still young; engines field is `>=24`. TypeScript 6 / oxlint 1.x are current but fast-moving.
- Impact: Cannot run on Node 22 despite `KaitenHttpClient` comments saying “Node 22”.
- Migration plan: Keep engines in lockstep with `deploy/Dockerfile` (`node:24-bookworm-slim`).

## Missing Critical Features

**No retry / dead-letter after handler failure:**
- Problem: Failed jobs are logged and dropped (`runWorker`). Poller will not re-offer the same SHA (in-memory handled). Redis has no ACK.
- Current workaround: Restart + new SHA, or manual queue surgery.
- Blocks: Reliable production reviews; multi-worker Redis.
- Implementation complexity: Medium (T3.2: error classes, retry budget, DLQ).

**No SdkLocalEngine:**
- Problem: Production path is CLI-only; `src/adapters/engine/sdk/` is empty.
- Current workaround: `CURSOR_AGENT_BIN` + CLI.
- Blocks: Phase-3 quality/latency targets; tighter env/sandbox control.
- Implementation complexity: Large (T3.1).

**No live publish in ops (🔑P2 + T2.6):**
- Problem: Bot has no pilot membership; group webhook not configured. Code for writer/publisher/webhook is present.
- Current workaround: `MIRA_PUBLISHER=log` and logs.
- Blocks: End-to-end “comment on MR” gate of phase 2.
- Implementation complexity: Ops, not code. Then switch `MIRA_PUBLISHER=gitlab` under the bot token.

**Health/metrics not production-grade:**
- Problem: `/healthz` is liveness-only; metrics registry is never scraped; no alerting.
- Current workaround: JSON logs (`src/observability/logger.ts`).
- Blocks: SLO/alerting in T3.7.
- Implementation complexity: Small for `/metrics` + dependency checks; larger for dashboards.

**ChatOps `ignore` has no undo; `review --full` not implemented:**
- Problem: Operators cannot restore a muted fingerprint or force a second pass on the same SHA.
- Current workaround: Edit SQLite/Postgres `MR_IGNORE` / `mr_review` by hand.
- Blocks: Supportable ChatOps in production.
- Implementation complexity: Small–medium (`unignore` + seen bypass).

## Test Coverage Gaps

**Composition root and `runApiServer`:**
- What's not tested: `src/entrypoints/main.ts` publisher/queue/store switching, poller `handled` coupling, ChatOps `handleNote`, debounce wiring, env allowlist for the engine.
- Risk: Default dry-run or Redis/SQLite mis-combos regress silently; ChatOps `--full` stays dead.
- Priority: High
- Difficulty to test: Extract `createPublisher` / poller helpers and test with fakes (no need for a full process).

**GitLab/Kaiten HTTP timeouts and live I/O:**
- What's not tested: Real `fetch` hang, 429 beyond two retries, Kaiten 405 checklist path (only documented), writer against GitLab (unit fakes only in `src/adapters/vcs/gitlab/gitlab-writer.test.ts`).
- Risk: Production stalls or write API mismatches (🔑P2 blocks live tests).
- Priority: Medium
- Difficulty to test: Inject fake fetch with delayed promises; live tests wait on bot access.

**`spawn.ts`, engine env, and timeout race:**
- What's not tested: Real `node:child_process` abort, `shell: true`, env inheritance, unhandled rejection on timeout.
- Risk: Token leak via child env; zombie `cursor-agent` processes.
- Priority: High
- Difficulty to test: Small fixture process; assert `env` keys.

**Redis crash semantics and Postgres transactions:**
- What's not tested: Mid-`enqueue` crash, lost `blpop`, concurrent `seen`/`record`. Tests use in-memory fakes (`src/adapters/queue/redis/redis-queue.test.ts`, `src/adapters/store/postgres/postgres-store.test.ts`).
- Risk: Stuck pending keys and duplicate reviews when scaling.
- Priority: High before enabling `MIRA_QUEUE=redis`
- Difficulty to test: Need fault-injection Redis or Lua-level tests.

**`gcWorkspaces` production wiring and leftover `.git/config`:**
- What's not tested: Timer GC from `main`; token residual after failed cleanup.
- Risk: Credential files accumulate on the review host.
- Priority: High
- Difficulty to test: Low for scheduling; use a temp dir with a fake token URL.

**PoC vs service parity:**
- What's not tested: `src/entrypoints/cli/poc.ts` `--keep` leaving tokenized clones; no engine vs service pipeline differences.
- Risk: Operators debug with PoC and assume service behavior matches.
- Priority: Low
- Difficulty to test: Document the gap; keep PoC on the same `ContextBuilder`.

---

*Concerns audit: 2026-09-09*
*Update as issues are fixed or new ones discovered*
