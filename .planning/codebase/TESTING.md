# Testing Patterns

**Analysis Date:** 2026-09-09

## Test Framework

**Runner:**
- Node.js built-in test runner (`node --test`), Node ≥24 (native TypeScript)
- No Jest/Vitest. Config is `package.json` script plus `tsconfig.test.json` (tests + `fakes.ts` typecheck only)
- Production `tsconfig.json` excludes `src/**/*.test.ts` and `src/**/fakes.ts`

**Assertion Library:**
- `node:assert/strict` — `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.match`, `assert.throws`, `assert.rejects`, `assert.doesNotMatch`, `assert.notEqual`

**Run Commands:**
```bash
npm test                                              # all tests: node --test "src/**/*.test.ts"
node --test src/core/orchestrator/pipeline.test.ts    # single file
node --test --watch src/core/policy/policy.test.ts    # watch one file (not a package.json script)
npm run typecheck                                     # tsc src + tsconfig.test.json
```

There is no `test:coverage` script and no c8/nyc config.

## Test File Organization

**Location:**
- Co-located under `src/`: `src/<area>/<module>.test.ts` beside the implementation
- Shared fakes: `src/core/ports/fakes.ts` (not a test file; loaded only via tests / `tsconfig.test.json`)

**Naming:**
- `<module>.test.ts` for the folder’s main module (`pipeline.test.ts`, `gitlab-reader.test.ts`, `sqlite-store.test.ts`)
- Exception: `src/core/findings/findings.validate.test.ts` tests `validateFindings.ts`
- No `*.integration.test.ts` / `*.e2e.test.ts` suffixes — isolation is done with fakes, not filename tags

**Structure:**
```
src/
  core/orchestrator/pipeline.ts
  core/orchestrator/pipeline.test.ts
  core/ports/index.ts
  core/ports/fakes.ts
  core/ports/ports.test.ts
  adapters/vcs/gitlab/reader.ts
  adapters/vcs/gitlab/gitlab-reader.test.ts
  adapters/store/sqlite/sqlite-store.test.ts
  entrypoints/api/webhook.test.ts
```

31 test files; ~110 TypeScript files in `src/` including tests.

## Test Structure

**Suite Organization:**
```typescript
/**
 * Unit tests for <module>. <What is faked>. No git, network, or engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewJob } from '../domain/index.ts';
import { createReviewPipeline } from './index.ts';
import { FakeClock, FakeReviewEngine, InMemoryStateStore } from '../ports/fakes.ts';

function makeJob(headSha: string, overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    projectId: 'group/app',
    mrIid: 7,
    headSha,
    trigger: 'poll',
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

void test('pipeline: second run on the same key is skipped (idempotency)', async () => {
  const store = new InMemoryStateStore();
  const handle = createReviewPipeline({ /* deps */ store, /* … */ });

  await handle(makeJob('sha-a'));
  await handle(makeJob('sha-a'));

  assert.equal(await store.seen({ /* key */ }), true);
});
```

**Patterns:**
- Wrap every `test()` in `void` so the returned `TestContext` is not a floating promise
- Title format: `'UnitOrFn: expected behavior'` (`'InMemoryQueue: FIFO order and dedup by job key'`)
- Import style is mixed (`import { test }` vs `import test`) — both are fine; prefer `import { test } from 'node:test'`
- Do **not** copy `describe`/`it` from `src/core/chatops/chatops.test.ts` — that is the only nested suite; new tests use flat `void test(...)`
- No `beforeEach`/`afterEach`; construct collaborators inside each test
- File-level JSDoc states the isolation claim: “NO network”, “NO git”, “fake fetch”

## Mocking

**Framework:**
- No `node:test` `mock.fn` / module mocking in this repo
- Dependency injection: pass `fetch`, `spawn`, `sleep`, `fs`, `clock`, logger `sink` into constructors/options

**Patterns:**
```typescript
const fakeFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : String(input);
  if (url.endsWith('/merge_requests/7')) {
    return Promise.resolve(
      new Response(JSON.stringify({ title: 'Add feature', sha: 'deadbeef' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.reject(new Error(`unexpected url: ${url}`));
};

const reader = GitLabReader.fromConfig(
  { baseUrl: 'https://gitlab.example.com', token: 'test-token' },
  { fetch: fakeFetch, perPage: 2, sleep: async () => {} },
);
```

Port-level fakes (`src/core/ports/fakes.ts`):

```typescript
const engine = new FakeReviewEngine(engineResult);
const store = new InMemoryStateStore();
const writer = new FakeVcsWriter();
writer.seedNote('group/app', 7, { id: 1, body: 'prior', system: false });
```

**What to Mock / Fake:**
- HTTP: injectable `fetch` / `FetchLike` (`gitlab-reader.test.ts`, `kaiten-tracker.test.ts`)
- Process: injectable `SpawnLike` (`cli-headless-engine.test.ts`)
- Git: injectable `GitRunner` (`mirror-checkout.test.ts`)
- Time: `FakeClock` or a frozen `now` (`() => new Date('2026-06-21T12:00:00.000Z')`)
- Redis/Postgres drivers: in-test `FakeRedis` / `createFakePool` implementing the adapter’s `RedisLike` / `PgPoolLike`
- Logger: collect lines via `createLogger({ sink: (line) => lines.push(line) })` or a silent `{ info() {}, warn() {}, error() {} }`
- Rate-limit `sleep`: no-op so tests do not wait

**What NOT to Mock:**
- Pure core helpers (`partitionReview`, `normalizeFindings`, `findingFingerprint`, `parseChatOps`, `parsePolicyConfig`)
- JSON Schema validation path (real `schema/findings.schema.json` via cwd)
- In-memory SQLite (`:memory:`) — use the real `node:sqlite` engine

**Isolation rule:** tests must not call live GitLab, Kaiten, Cursor, Redis, or Postgres. `worker.test.ts` is the only core test that imports an adapter (`InProcQueue`); prefer `FakeJobSource` / `InMemoryQueue` from `fakes.ts` for new core tests.

## Fixtures and Factories

**Test Data:**
```typescript
function makeReviewKey(headSha: string, overrides: Partial<ReviewKey> = {}): ReviewKey {
  return {
    projectId: 'group/app',
    mrIid: 7,
    headSha,
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    ...overrides,
  };
}

function withTempWorkspace(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-cli-engine-'));
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
```

Stable sample identities used across suites: `projectId: 'group/app'`, `mrIid: 7`, `headSha: 'sha-a'`, `enqueuedAt: '2026-01-01T00:00:00.000Z'`.

**Location:**
- Factories live in the test file (`makeJob`, `makeContext`, `testPolicy`, `mrPayload`)
- Shared port fakes: `src/core/ports/fakes.ts` — `FakeVcsReader`, `FakeVcsWriter`, `FakeTaskTracker`, `FakeReviewEngine`, `FakeIgnoreStore`, `FakeClock`, `InMemoryQueue`, `InMemoryStateStore`
- Tiny local fakes are OK when the surface is one method (`FakeTracker` in `linking.test.ts`, `CapturingPublisher` in `pipeline.test.ts`)
- Optional-field factories must respect `exactOptionalPropertyTypes` (assign `lineStart` only if defined) — see `finding()` in `src/adapters/publisher/gitlab/gitlab-publisher.test.ts`
- Temp dirs: prefix `mira-<area>-` under `os.tmpdir()`, always `rmSync` in `finally`

No `tests/fixtures/` directory.

## Coverage

**Requirements:**
- None enforced — no coverage reporter, no CI gate in-repo
- `npm test` + `npm run typecheck` + `npm run lint` is the documented pre-commit bar (`docs/02-guides/local-development.md`)

**Configuration:**
- Not applicable

**View Coverage:**
```bash
# Not configured. Do not add a coverage script unless the phase asks for it.
```

## Test Types

**Unit Tests:**
- Default for this repo: one module, injected fakes, no I/O
- Examples: `src/core/partition/partition.test.ts`, `src/core/normalize/normalize.test.ts`, `src/core/policy/policy.test.ts`, `src/core/findings/findings.validate.test.ts`
- `src/core/ports/ports.test.ts` is a **contract suite** for the fakes themselves (FIFO, `seen`/record, clock)

**Adapter tests (still unit, fake transport):**
- GitLab/Kaiten: fake `fetch` (`gitlab-reader.test.ts`, `gitlab-writer.test.ts`, `kaiten-tracker.test.ts`)
- Engine: fake `spawn` + temp workspace (`cli-headless-engine.test.ts`) — requires **cwd = repo root** so `schema/findings.schema.json` and `prompts/review.v1.md` resolve
- Publisher: `FakeVcsWriter` + `FakeIgnoreStore` (`gitlab-publisher.test.ts`)
- SQLite: real `node:sqlite` with `:memory:` or a temp file (`sqlite-store.test.ts`)
- Postgres/Redis: fake client interfaces only (`postgres-store.test.ts`, `redis-queue.test.ts`)

**Entrypoint tests:**
- Poller job selection with frozen `now` (`src/entrypoints/poller/poller.test.ts`)
- Webhook parse + real Node HTTP server on `listen(0)` and `fetch` to `127.0.0.1` (`webhook.test.ts`) — loopback only, no GitLab
- CLI PoC with injected `PocDeps` (`poc.test.ts`)

**E2E Tests:**
- Not used. Live GitLab/Kaiten/Cursor runs are manual (`docs/02-guides/run-review-poc.md`)

## Common Patterns

**Async Testing:**
```typescript
void test('getMrContext maps metadata and paginates diffs', async () => {
  const ctx = await reader.getMrContext('group/sub/proj', 7);
  assert.equal(ctx.headSha, 'deadbeefcafe');
});
```

**Error Testing:**
```typescript
void test('parsePolicyConfig throws on invalid strictness with a clear message', () => {
  assert.throws(
    () => parsePolicyConfig(yaml),
    (err: unknown) => {
      assert.ok(err instanceof PolicyConfigError);
      assert.match(err.message, /config\.defaults\.strictness/);
      return true;
    },
  );
});

void test('FakeVcsReader: rejects unknown MRs', async () => {
  await assert.rejects(() => reader.getMrContext('group/app', 99), /not found/);
});
```

**HTTP server (loopback):**
```typescript
const server = createWebhookServer({ secret: 'top-secret', policyFor, enqueue, now });
await new Promise<void>((resolve) => server.listen(0, resolve));
try {
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${String(port)}/webhook`, { method: 'POST', /* … */ });
  assert.equal(res.status, 401);
} finally {
  server.close();
}
```

**Deterministic time:** freeze `now` to a `Date`; do not use real `setInterval` in poller tests (they assert `pollOnce` / `selectJobs` directly).

**Snapshot Testing:**
- Not used. Assert field-by-field or `assert.deepEqual` on small objects

**Adding tests for new code:**
1. Co-locate `<module>.test.ts`
2. Inject I/O; reuse `src/core/ports/fakes.ts` for core/orchestrator
3. Use `void test('module: behavior', …)` and `node:assert/strict`
4. Document isolation in the file JSDoc
5. Run `node --test path/to/file.test.ts` then `npm test` + `npm run typecheck`

---

*Testing analysis: 2026-09-09*
*Update when test patterns change*
