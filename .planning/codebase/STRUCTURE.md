# Codebase Structure

**Analysis Date:** 2026-09-09

## Directory Layout

```
mira-review-bot/
├── src/                    # TypeScript ESM application (rootDir)
│   ├── entrypoints/        # Composition roots and process roles
│   ├── core/               # Domain, ports, review pipeline (no vendors)
│   ├── adapters/           # Port implementations (GitLab, Kaiten, …)
│   ├── config/             # ENV + YAML policy + profile loader
│   └── observability/      # JSON logger, metrics, redact
├── prompts/                # Versioned review prompt templates
├── profiles/               # Stack-profile Markdown (layer B guidance)
├── schema/                 # JSON Schema for agent findings
├── deploy/                 # Docker image, compose, example policy YAML
├── scripts/                # Host/app ops scripts (bash)
├── docs/                   # Numbered human docs + Memory Bank
├── tasks/                  # Phase plans and execution order
├── dist/                   # tsc emit (generated, gitignored)
├── .planning/              # GSD planning artifacts (this map)
├── .cursor/                # Cursor rules and repo skills
├── package.json            # Scripts, engines Node ≥24, deps
├── tsconfig.json           # App compile (excludes tests)
├── tsconfig.test.json      # Typecheck for tests + fakes
├── AGENTS.md               # Agent entry: Memory Bank + hexagon rules
└── README.md               # Repo landing
```

## Directory Purposes

**src/entrypoints/**
- Purpose: Process startup and wiring. Only place that constructs adapters for the live service.
- Contains: `*.ts` modules, co-located `*.test.ts`
- Key files: `src/entrypoints/main.ts` (service composition root), `src/entrypoints/cli/index.ts` (CLI dispatcher)
- Subdirectories: `poller/` (`runPoller`, `selectJobs`), `api/` (`runApiServer`, webhook parse, debounce), `cli/` (`poc` command), `worker/` (`.gitkeep` only — loop is `src/core/orchestrator/worker.ts`)

**src/core/**
- Purpose: Vendor-agnostic review logic and port contracts.
- Contains: One folder per concern, each with `index.ts` barrel + implementation + `*.test.ts`
- Key files: `src/core/domain/index.ts`, `src/core/ports/index.ts`, `src/core/ports/fakes.ts`, `src/core/orchestrator/pipeline.ts`
- Subdirectories: `domain/`, `ports/`, `orchestrator/`, `context/`, `partition/`, `aggregate/`, `normalize/`, `policy/`, `linking/`, `idempotency/`, `findings/`, `chatops/`

**src/adapters/**
- Purpose: Concrete ports. Grouped by capability then vendor.
- Contains: Adapter classes, thin HTTP/process clients, store schemas
- Key files: `src/adapters/vcs/gitlab/reader.ts`, `src/adapters/tracker/kaiten/kaiten-tracker.ts`, `src/adapters/engine/cli/cli-headless-engine.ts`
- Subdirectories: `vcs/gitlab/`, `tracker/kaiten/`, `engine/{cli,sdk,cloud}/` (sdk/cloud are placeholders), `store/{sqlite,postgres}/`, `queue/{inproc,redis}/`, `publisher/{log,gitlab}/`, `cache/`

**src/config/**
- Purpose: Typed configuration loaders (not domain policy merge — that is core).
- Contains: `index.ts`, `policy-config.ts`, `profiles.ts`, `profiles.test.ts`
- Key files: `src/config/index.ts` (`loadConfig`, `MiraConfig`), `src/config/policy-config.ts`, `src/config/profiles.ts`

**src/observability/**
- Purpose: Cross-cutting logs/metrics used by the composition root.
- Contains: `logger.ts`, `metrics.ts`, `redact.ts`, `observability.test.ts`
- Key files: `src/observability/index.ts`

**prompts/**
- Purpose: Versioned system prompt for `CliHeadlessEngine`.
- Contains: Markdown templates
- Key files: `prompts/review.v1.md` (constant `PROMPT_VERSION = 'review.v1'` in `src/entrypoints/main.ts`)

**profiles/**
- Purpose: Optional stack guidance injected at `{{profile_guidance}}`.
- Contains: `*.md` named after policy `profile` field
- Key files: `profiles/node.md`, `profiles/python.md`, `profiles/java.md`, `profiles/go.md`, `profiles/frontend.md`, `profiles/README.md`

**schema/**
- Purpose: On-the-wire findings contract (snake_case) for the agent.
- Contains: JSON Schema draft 2020-12
- Key files: `schema/findings.schema.json` (loaded at runtime from `src/core/findings/validateFindings.ts`)

**deploy/**
- Purpose: Container and compose packaging.
- Contains: `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`, `docker-compose.prod.yml`, `config.example.yml`
- Key files: `deploy/Dockerfile`, `deploy/config.example.yml` (policy YAML shape)

**scripts/**
- Purpose: Server bootstrap and day-2 ops (not application logic).
- Contains: bash scripts
- Key files: `scripts/README.md`
- Subdirectories: `scripts/root/` (host: user, firewall, docker, ssh), `scripts/app/` (build/up/down/restart/secrets), `scripts/tools/` (logs, health, backup, scale workers), `scripts/lib/common.sh`

**docs/**
- Purpose: Long-lived documentation in numbered sections; Memory Bank for agents.
- Contains: Markdown
- Key files: `docs/README.md`, `docs/_ai/README.md`, `docs/04-architecture/overview.md`
- Subdirectories: `docs/00-onboarding/`, `docs/01-concepts/`, `docs/02-guides/`, `docs/03-reference/`, `docs/04-architecture/` (+ `adr/`), `docs/05-operations/`, `docs/_ai/`

**tasks/**
- Purpose: Implementation phase checklists and status — not runtime code.
- Contains: `phase-*.md`, `execution-order.md`
- Key files: `tasks/README.md`, `tasks/execution-order.md`

**.cursor/**
- Purpose: Persistent agent rules and repo-local skills.
- Contains: `.mdc` rules, `skills/`
- Key files: `.cursor/rules/kaiten-read-only.mdc`, `.cursor/rules/memory-bank.mdc`, `.cursor/skills/parallel-composer/SKILL.md`

**.planning/codebase/**
- Purpose: GSD codebase maps consumed by plan/execute commands.
- Contains: `ARCHITECTURE.md`, `STRUCTURE.md` (and sibling maps from other focus areas)
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`

## Key File Locations

**Entry Points:**
- `src/entrypoints/main.ts`: Service composition root (`ROLE`)
- `src/entrypoints/cli/index.ts`: CLI `help` / `poc`
- `src/entrypoints/cli/poc.ts`: Manual one-MR review
- `src/entrypoints/poller/poller.ts`: Discovery loop
- `src/entrypoints/api/index.ts`: HTTP listen + debounce wiring
- `src/entrypoints/api/server.ts`: `/healthz` and `/webhook` transport
- `package.json` `start` / `start:ts` / `dev`

**Configuration:**
- `src/config/index.ts`: Required ENV (`CURSOR_API_KEY`, `GITLAB_*`, `KAITEN_*`)
- `src/config/policy-config.ts`: `MIRA_POLICY_CONFIG` YAML parse
- `src/config/profiles.ts`: `MIRA_PROFILES_DIR` (default `profiles/`)
- `.env.example`: Env var names (do not commit `.env`)
- `deploy/config.example.yml`: Example project policy
- `tsconfig.json`: App compile (`rootDir` `src`, `outDir` `dist`)
- `tsconfig.test.json`: Test typecheck
- `.oxlintrc.json` / `.oxfmtrc.json`: Lint / format

**Core Logic:**
- `src/core/domain/index.ts`: `ReviewJob`, `ReviewContext`, `Finding`, `ReviewResult`, …
- `src/core/ports/index.ts`: All port interfaces
- `src/core/orchestrator/pipeline.ts`: Job handler
- `src/core/orchestrator/worker.ts`: Concurrency loop
- `src/core/context/context-builder.ts`: Context + checkout
- `src/core/context/checkout.ts` / `mirror-checkout.ts` / `workspace.ts`: Git workspace
- `src/core/partition/partition.ts`: Units + glob helpers in `glob.ts`
- `src/core/aggregate/aggregate.ts`: Merge unit results
- `src/core/normalize/normalize.ts`: Filter/threshold/dedup/cap
- `src/core/policy/types.ts` / `defaults.ts` / `merge.ts`: `ProjectPolicy`
- `src/core/linking/resolve.ts`: MR ↔ card
- `src/core/idempotency/fingerprint.ts`: Finding fingerprint
- `src/core/findings/validateFindings.ts`: Schema validate + snake_case map
- `src/core/chatops/parse.ts`: `@mira` commands

**Adapters:**
- `src/adapters/vcs/gitlab/client.ts`: REST client + `GitLabApiError`
- `src/adapters/vcs/gitlab/reader.ts` / `writer.ts`
- `src/adapters/tracker/kaiten/http.ts` / `endpoints.ts` / `kaiten-tracker.ts`
- `src/adapters/engine/cli/cli-headless-engine.ts` / `spawn.ts`
- `src/adapters/store/sqlite/sqlite-store.ts` / `schema.ts`
- `src/adapters/store/postgres/postgres-store.ts` / `schema.ts`
- `src/adapters/queue/inproc/queue.ts` / `src/adapters/queue/redis/redis-queue.ts`
- `src/adapters/publisher/log/log-publisher.ts` / `src/adapters/publisher/gitlab/gitlab-publisher.ts`
- `src/adapters/cache/ttl-cache.ts` / `caching-tracker.ts`

**Testing:**
- Co-located `src/**/*.test.ts` next to the module under test
- `src/core/ports/fakes.ts`: In-memory ports for core tests (excluded from app `tsconfig.json`)
- Runner: `npm test` → `node --test "src/**/*.test.ts"` (no separate `test/` tree)

**Documentation:**
- `README.md`: Human landing
- `AGENTS.md`: Agent bootstrap
- `docs/_ai/`: Memory Bank (`architecture.md`, `codebase-map.md`, …)
- `docs/04-architecture/overview.md`: Full architecture + diagrams
- `docs/04-architecture/adr/`: Numbered ADRs (`001-hexagonal-architecture.md`, …)
- `docs/03-reference/ports.md`, `domain-types.md`, `policy-config.md`, `environment.md`

## Naming Conventions

**Files:**
- kebab-case `.ts` for modules: `context-builder.ts`, `cli-headless-engine.ts`, `gitlab-publisher.ts`
- `*.test.ts` immediately beside the unit: `pipeline.test.ts` next to `pipeline.ts`
- `index.ts` barrel in every module directory
- Classes in kebab files, PascalCase identifiers: `GitLabReader` in `reader.ts`
- Markdown docs: kebab-case; ADR files `NNN-slug.md`; Cursor rules `kebab-case.mdc`

**Directories:**
- kebab-case everywhere under `src/`
- Adapters: `capability/vendor/` (`vcs/gitlab`, `tracker/kaiten`, `engine/cli`, `store/sqlite`)
- Docs sections: `NN-kebab-case/` (`04-architecture`)
- Scripts grouped by privilege: `scripts/root/`, `scripts/app/`, `scripts/tools/`

**Special Patterns:**
- Barrel `index.ts` re-exports public API; import from the folder (`../ports/index.ts`) with `.ts` extension
- Fakes: `src/core/ports/fakes.ts` (not a `*.test.ts`, excluded from production compile)
- Placeholders: `.gitkeep` in `src/adapters/engine/sdk/`, `src/adapters/engine/cloud/`, `src/entrypoints/worker/`
- Domain types live in `src/core/domain/index.ts` (no per-type files)
- Ports live in `src/core/ports/index.ts` (single contract file)
- Env-selected backends: same port, different folder (`queue/inproc` vs `queue/redis`)

## Where to Add New Code

**New review behavior (verdict, filters, decomposition, linking):**
- Primary code: `src/core/<concern>/` (new folder or existing `partition/`, `normalize/`, `policy/`, …)
- Port if new IO is required: add interface to `src/core/ports/index.ts` + fake in `src/core/ports/fakes.ts`
- Tests: `src/core/<concern>/<name>.test.ts`
- Do not put this in adapters or `main.ts`

**New external system / swap vendor:**
- Implementation: `src/adapters/<capability>/<vendor>/` with `index.ts` barrel
- Class implements the existing port; keep HTTP client separate (`client.ts` / `http.ts`)
- Tests: `src/adapters/<capability>/<vendor>/*.test.ts` with injectable `fetch`/`spawn`
- Wire in `src/entrypoints/main.ts` behind an env flag (see `MIRA_QUEUE`, `MIRA_STORE`, `MIRA_PUBLISHER`)

**New process role or HTTP route:**
- Role: extend `parseRole` and the `tasks` array in `src/entrypoints/main.ts`
- HTTP: `src/entrypoints/api/server.ts` (transport) + pure parse in `src/entrypoints/api/webhook.ts` (or sibling)
- Tests: `src/entrypoints/api/*.test.ts`

**New CLI command:**
- Definition: switch in `src/entrypoints/cli/index.ts`
- Handler: `src/entrypoints/cli/<command>.ts`
- Tests: `src/entrypoints/cli/<command>.test.ts`
- Prefer calling `createReviewPipeline` over duplicating `poc.ts` orchestration

**New stack profile:**
- File: `profiles/<name>.md`
- Reference from policy YAML `profile:` field; loader is `src/config/profiles.ts` (no core change)

**New prompt version:**
- File: `prompts/review.vN.md`
- Bump `PROMPT_VERSION` in `src/entrypoints/main.ts` so `ReviewKey` changes

**Policy / ENV:**
- Domain fields: `src/core/policy/types.ts` + `defaults.ts` + tests in `src/core/policy/policy.test.ts`
- YAML parse: `src/config/policy-config.ts`
- New required ENV: `src/config/index.ts` + `.env.example` + `docs/03-reference/environment.md`

**Utilities:**
- Core-pure helpers stay next to the concern (`src/core/partition/glob.ts`, `src/core/idempotency/fingerprint.ts`)
- Logging/redact: `src/observability/`
- Do not add a generic `src/utils/` dump; follow an existing module

**Documentation:**
- Concepts/guides/reference/architecture/ops: numbered `docs/NN-*/` (rule `.cursor/rules/docs-structure.mdc`)
- Decisions: `docs/04-architecture/adr/NNN-slug.md` + ADR README table
- Agent snapshot: `docs/_ai/` (short; link to `docs/`)
- Update `docs/_ai/codebase-map.md` / `docs/_ai/architecture.md` when layout or layers change

## Special Directories

**dist/**
- Purpose: `tsc` JavaScript + declarations + source maps
- Source: `npm run build` (`tsconfig.json` `outDir`)
- Committed: No (`.gitignore`)

**node_modules/**
- Purpose: npm packages
- Source: `npm install`
- Committed: No

**.mira/** and `*.log`
- Purpose: Runtime workspace leftovers / logs
- Source: Context builder writes `.mira/context.json` inside each checkout; cleanup removes the workspace
- Committed: No

**.env**
- Purpose: Local secrets
- Source: Copied from `.env.example`
- Committed: No (file exists locally; never read/quote in docs)

**graphify-out/**
- Purpose: Local knowledge-graph cache from the Graphify skill (not part of the bot runtime)
- Source: Generated by Graphify tooling
- Committed: Treat as generated; do not import from application code

**src/adapters/engine/sdk/** and **src/adapters/engine/cloud/**
- Purpose: Reserved for future `ReviewEngine` adapters (ADR 004)
- Source: `.gitkeep` placeholders
- Committed: Yes (empty dirs)

**src/entrypoints/worker/**
- Purpose: Historical placeholder for a worker role folder
- Source: `.gitkeep`; real loop is `src/core/orchestrator/worker.ts`
- Committed: Yes; do not add a second worker implementation here — extend `runWorker`

**docs/_ai/**
- Purpose: Memory Bank for agents
- Source: Maintained by hand when architecture/stack/layout changes
- Committed: Yes

**.planning/**
- Purpose: GSD plans, maps, research
- Source: GSD commands / mappers
- Committed: Yes when the team tracks planning in-repo

---

*Structure analysis: 2026-09-09*
*Update when directory structure changes*
