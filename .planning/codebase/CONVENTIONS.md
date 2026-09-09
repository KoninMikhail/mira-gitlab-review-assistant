# Coding Conventions

**Analysis Date:** 2026-09-09

## Naming Patterns

**Files:**
- Use kebab-case `.ts` for modules: `gitlab-publisher.ts`, `context-builder.ts`, `ttl-cache.ts`
- Co-locate tests as `<module>.test.ts` next to the source (`pipeline.test.ts` beside `pipeline.ts`)
- Use `index.ts` as the public barrel for each folder (`src/core/policy/index.ts`, `src/adapters/vcs/gitlab/index.ts`)
- One existing camelCase source file: `src/core/findings/validateFindings.ts` — do not copy; new files stay kebab-case
- Adapter folders: `src/adapters/<system>/<impl>/` (`vcs/gitlab`, `tracker/kaiten`, `store/sqlite`)

**Functions:**
- Use camelCase: `loadConfig`, `createReviewPipeline`, `resolveCard`, `validateFindings`
- No `async` prefix; async is visible from the `Promise` return type
- Factories: `create*` for constructors/builders (`createLogger`, `createReviewPipeline`, `createWebhookServer`); `make*` / `with*` in tests
- Handlers: `handle` / `handleRequest` at process boundaries (`src/core/orchestrator/pipeline.ts`, `src/entrypoints/api/server.ts`)

**Variables:**
- camelCase for locals and object fields in the TypeScript domain (`projectId`, `mrIid`, `headSha`)
- `UPPER_SNAKE_CASE` for module constants (`DEFAULT_MAX_FINDINGS`, `PROMPT_VERSION`, `API_PREFIX`)
- Numeric literals with separators: `60_000`, `1_000`
- Unused parameters: `_` prefix (`_j`, `_timeoutSeconds`) — required by oxlint `argsIgnorePattern`
- No underscore-prefix private fields; use `#` private or the `private` keyword (see Module Design)

**Types:**
- PascalCase interfaces, no `I` prefix: `ReviewJob`, `MiraConfig`, `GitLabClientOptions`
- PascalCase type aliases: `Verdict`, `FetchLike`, `ResolveResult`
- Closed string unions instead of enums: `type Severity = 'blocker' | 'major' | 'minor' | 'nit'` in `src/core/domain/index.ts`
- Options bags: `*Options` (`CreateLoggerOptions`, `ReviewPipelineDeps`, `PocDeps`)
- Port fakes: `Fake*` for collaborators (`FakeVcsReader`); `InMemory*` for in-process stores/queues (`src/core/ports/fakes.ts`)
- Errors: `*Error` extending `Error` (`GitLabApiError`, `KaitenHttpError`, `PolicyConfigError`, `PocArgsError`)

## Code Style

**Formatting:**
- oxfmt via `.oxfmtrc.json` — run `npm run format` / `npm run format:check`
- `printWidth` 100, `tabWidth` 2, spaces, LF, semicolons required, single quotes, trailing commas `all`
- Markdown is excluded from format scripts (`"!**/*.md"`)

**Linting:**
- oxlint via `.oxlintrc.json` — plugins `typescript` + `import`; `correctness` as error
- `typescript/consistent-type-imports`: error — use `import type { X }` for types
- `no-unused-vars` ignores `_` prefixed args/vars
- TypeScript `strict` plus `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`
- Run: `npm run lint` / `npm run lint:fix`; typecheck: `npm run typecheck`

**TypeScript / ESM:**
- `"type": "module"`; Node ≥24 native `.ts` execution
- Relative imports always include the `.ts` extension: `from './pipeline.ts'`
- `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` in `tsconfig.json`

## Import Organization

**Order:**
1. Node builtins (`node:fs`, `node:path`, `node:test`, `node:assert/strict`)
2. External packages (`ajv`, `yaml`) when present
3. Internal modules via relative paths (domain/ports first, then sibling modules, then adapters only from entrypoints)
4. `import type` for type-only symbols (may sit next to value imports from the same barrel)

**Grouping:**
- Blank line between node builtins and project imports
- Blank line between type-heavy barrels and the value import they support, when it aids readability (`src/entrypoints/main.ts`)
- Import from the folder barrel (`../policy/index.ts`) rather than a deep file, unless the symbol is not re-exported

**Path Aliases:**
- None. Always relative paths with `.ts` extensions. Do not add `@/` aliases.

## Error Handling

**Patterns:**
- Throw on invalid config, schema, and HTTP non-2xx; catch at process/worker boundaries
- Typed errors: `class XError extends Error {}`; HTTP/CLI errors set `this.name` and extra fields (`status`, `url`, `body`) in `src/adapters/vcs/gitlab/client.ts` and `src/adapters/tracker/kaiten/http.ts`
- Expected degradations: discriminated unions, not throws — `ResolveResult` in `src/core/linking/types.ts` (`{ found: true, … } | { found: false, reason }`)
- Pipeline: engine failures become `degradations` on the result; checkout/store failures throw so the worker can log/retry (`src/core/orchestrator/pipeline.ts`)
- Worker: handler errors are caught, logged, and do not stop the loop (`src/core/orchestrator/worker.ts`)
- Map `unknown` with `err instanceof Error ? err.message : String(err)` (`src/core/linking/resolve.ts`)

**Error Types:**
- Throw: missing env (`ConfigError` in `src/config/index.ts`), bad YAML (`PolicyConfigError`), invalid findings JSON (`validateFindings`), GitLab/Kaiten HTTP errors, bad CLI flags (`PocArgsError`)
- Return: chatops parse miss (`undefined` from `parseChatOps`), webhook skip (`undefined` from `mrEventToJob`), linking miss (`found: false`)
- Do not use a `Result<T, E>` monad; use throw vs discriminated union vs `undefined`

## Logging

**Framework:**
- `createLogger` in `src/observability/logger.ts` — JSON lines to stdout, levels `debug | info | warn | error`
- Structural logger interfaces in core (`PipelineLogger`) so `core` does not import `observability`
- CLI PoC may use `console.log` / `console.error` (`src/entrypoints/cli/poc.ts`); service code uses the logger

**Patterns:**
- Dotted event names as `msg`: `'review.skip.seen'`, `'review.summary'`, `'engine.start'`
- Correlation fields in **snake_case** (log/metrics/SQL): `project_id`, `mr_iid`, `head_sha`, `review_id`
- Domain objects stay **camelCase**; map at the log/SQL/HTTP boundary
- `logger.child({ … })` for per-job context (`src/adapters/publisher/log/log-publisher.ts`)
- Automatic redaction of tokens, diffs, prompts (`src/observability/redact.ts`) — never log raw diffs or secrets
- Injectable `sink` in tests; production sink writes to `process.stdout`

## Comments

**When to Comment:**
- File-level JSDoc explaining the module’s job and hexagonal boundary (every adapter/core module)
- Why: precedence, degradations, idempotency, dry-run policy — not restating the next line
- Point at docs: `docs/04-architecture/review-pipeline.md §2.3`, ADRs
- Inline comments for non-obvious branches (policy folded into the idempotency key before `seen`)

**JSDoc/TSDoc:**
- Public exports get a short JSDoc; use `{@link Symbol}` for intra-code links
- `@throws {Error}` when the contract throws (`validateFindings` in `src/core/findings/validateFindings.ts`)
- Ports in `src/core/ports/index.ts` document each method’s role (read vs write, idempotency)

**TODO Comments:**
- None in `src/` today. Prefer a Kaiten card / docs note over `TODO` in code

## Function Design

**Size:**
- Keep functions focused; extract helpers in the same file (`formatErrors`, `toReviewResult`, `fail`)
- Pipeline orchestration lives in `createReviewPipeline` as a returned `handle` closure, not a god class

**Parameters:**
- Prefer an options object once past ~3 args: `createLogger(options)`, `runWorker(options)`, `GitLabClient(config, options)`
- Inject I/O: `fetch`, `spawn`, `sleep`, `fs`, `clock` — never hard-wire network/git in testable units
- Destructure options inside the function when a subset is used (`runWorker`)

**Return Values:**
- Explicit returns; early return for skip/guard (`store.seen` → skip; chatops miss → `undefined`)
- `Promise<void>` for fire-and-forget pipeline/publish; typed domain objects for pure helpers
- Optional properties: assign only when defined (required by `exactOptionalPropertyTypes`) — see `toFinding` in `src/core/findings/validateFindings.ts`. Do not spread `undefined` into optional fields

## Module Design

**Exports:**
- Named exports only — no `export default` anywhere in `src/`
- Re-export the public surface from `index.ts`; keep helpers unexported
- Classes implement ports: `export class GitLabReader implements VcsReader`

**Barrel Files:**
- Every feature folder has `index.ts` (core modules, each adapter, `observability`, `config`)
- Import the barrel from other packages of the hexagon; composition root `src/entrypoints/main.ts` is the only place that wires adapters to core

**Hexagon (enforced):**
- `src/core/**` must not import `src/adapters/**` (production code). Ports live in `src/core/ports/index.ts`
- Adapters import domain + ports only
- Entrypoints own composition (`src/entrypoints/main.ts`, `src/entrypoints/cli/poc.ts`)
- Observability is an adapter-like seam: core takes structural logger/hooks, not `createLogger`

**Privacy:**
- Prefer `private` members (`ContextBuilder`, stores, queues)
- `#` private fields appear in `src/adapters/vcs/gitlab/client.ts`, `src/adapters/engine/cli/cli-headless-engine.ts`, `src/adapters/publisher/log/log-publisher.ts` — match the file you edit

**Casing at boundaries:**
- Wire JSON/YAML/SQL: snake_case (`file_path`, `requirements_coverage`, `project_id`)
- TypeScript domain: camelCase (`filePath`, `requirementsCoverage`, `projectId`)
- Map in the adapter or validator (`validateFindings`, `parsePolicyConfig`)

---

*Convention analysis: 2026-09-09*
*Update when patterns change*
