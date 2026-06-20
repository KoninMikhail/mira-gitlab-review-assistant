/**
 * Unit tests for the review pipeline (orchestrator brain) using in-memory fakes:
 * full happy path (build → partition → engine → aggregate → normalize → publish
 * → record), idempotency skip on the second run, strictness-driven normalization
 * (default `balanced` drops `nit`), engine-error degradation, and workspace
 * cleanup. No git, network, engine, or fs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewContext, ReviewJob, ReviewResult } from '../src/core/domain/index.ts';
import type { ContextBuildResult } from '../src/core/context/index.ts';
import type { PublishInput, Publisher } from '../src/core/ports/index.ts';
import { createReviewPipeline } from '../src/core/orchestrator/index.ts';
import { defaultProjectPolicy } from '../src/core/policy/index.ts';
import { FakeClock, FakeReviewEngine, InMemoryStateStore } from './fakes.ts';

const job: ReviewJob = {
  projectId: 'group/app',
  mrIid: 7,
  headSha: 'sha-a',
  trigger: 'manual',
  enqueuedAt: '2026-01-01T00:00:00.000Z',
};

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' export { a };',
  '',
].join('\n');

function makeContext(): ReviewContext {
  return {
    job: { projectId: job.projectId, mrIid: job.mrIid, headSha: job.headSha },
    title: 'Add b',
    description: 'body',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    changedFiles: [{ path: 'src/app.ts', isBinary: false, isNew: false, isDeleted: false }],
    diff: DIFF,
  };
}

class CapturingPublisher implements Publisher {
  readonly published: PublishInput[] = [];
  publish(input: PublishInput): Promise<void> {
    this.published.push(input);
    return Promise.resolve();
  }
}

/** Context builder fake: returns a canned context + a cleanup spy. */
function fakeContextBuilder(cleanupCalls: { count: number }): {
  build(j: ReviewJob): Promise<ContextBuildResult>;
} {
  return {
    build(_j: ReviewJob): Promise<ContextBuildResult> {
      return Promise.resolve({
        context: makeContext(),
        workspaceDir: '/tmp/ws',
        cleanup: () => {
          cleanupCalls.count += 1;
          return Promise.resolve();
        },
      });
    },
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const engineResult: ReviewResult = {
  verdict: 'risks',
  summary: 'found things',
  findings: [
    { severity: 'major', category: 'bug', filePath: 'src/app.ts', message: 'off by one' },
    { severity: 'nit', category: 'style', filePath: 'src/app.ts', message: 'spacing' },
  ],
};

void test('pipeline: reviews, normalizes (balanced drops nit), publishes and records', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder(cleanup),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine,
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
  });

  await handle(job);

  assert.equal(publisher.published.length, 1);
  const result = publisher.published[0]?.result;
  assert.equal(result?.verdict, 'risks');
  // balanced strictness drops the `nit`, keeps the `major`.
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0]?.severity, 'major');
  assert.equal(engine.reviewed.length, 1);
  assert.equal(cleanup.count, 1);
  assert.equal(
    await store.seen({
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: 'review.v1',
      partitionVersion: 'single.v1',
    }),
    true,
  );
});

void test('pipeline: second run on the same key is skipped (idempotency)', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);

  const deps = {
    contextBuilder: fakeContextBuilder(cleanup),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine,
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
  };
  const handle = createReviewPipeline(deps);

  await handle(job);
  await handle(job);

  // Engine ran only once; the second call short-circuited on `seen`.
  assert.equal(engine.reviewed.length, 1);
  assert.equal(publisher.published.length, 1);
});

void test('pipeline: guidance version folds into the idempotency key', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);
  let enginePolicyProfile: string | undefined = 'unset';

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder(cleanup),
    resolvePolicy: () => ({ ...defaultProjectPolicy, profile: 'python' }),
    createEngine: (_dir, policy) => {
      enginePolicyProfile = policy.profile;
      return engine;
    },
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    resolveGuidanceVersion: (policy) =>
      policy.profile !== undefined ? `${policy.profile}@abc12345` : undefined,
  });

  await handle(job);

  // Policy (incl. profile) reached the engine factory.
  assert.equal(enginePolicyProfile, 'python');

  // The composed prompt version is what got recorded; the base version is NOT seen.
  assert.equal(
    await store.seen({
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: 'review.v1+python@abc12345',
      partitionVersion: 'single.v1',
    }),
    true,
  );
  assert.equal(
    await store.seen({
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: 'review.v1',
      partitionVersion: 'single.v1',
    }),
    false,
  );
});

void test('pipeline: engine failure degrades instead of throwing', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const failingEngine = {
    review: () => Promise.reject(new Error('cursor-agent boom')),
  };
  let engineErrors = 0;

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder(cleanup),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => failingEngine,
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    hooks: {
      onEngineError: () => {
        engineErrors += 1;
      },
    },
  });

  await handle(job);

  assert.equal(engineErrors, 1);
  assert.equal(publisher.published.length, 1);
  // Aggregated result still published (degraded, no findings), workspace cleaned.
  assert.equal(publisher.published[0]?.result.findings.length, 0);
  assert.equal(cleanup.count, 1);
});
