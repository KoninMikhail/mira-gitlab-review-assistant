/**
 * Unit tests for the review pipeline (orchestrator brain) using in-memory fakes:
 * full happy path (build → partition → engine → aggregate → normalize → publish
 * → record), idempotency skip on the second run, strictness-driven normalization
 * (`lenient` drops `minor`), engine-error degradation, and workspace
 * cleanup. No git, network, engine, or fs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewContext, ReviewJob, ReviewResult } from '../domain/index.ts';
import type { ContextBuildResult } from '../context/index.ts';
import type { PublishInput, Publisher } from '../ports/index.ts';
import { createReviewPipeline } from './index.ts';
import { defaultProjectPolicy } from '../policy/index.ts';
import { FakeClock, FakeReviewEngine, FakeVcsCiReader, InMemoryStateStore } from '../ports/fakes.ts';
import { PRESENCE_ACK_NOTE } from '../presence/index.ts';

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
    { severity: 'minor', category: 'style', filePath: 'src/app.ts', message: 'spacing' },
  ],
};

void test('pipeline: reviews, normalizes (lenient drops minor), publishes and records', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder(cleanup),
    resolvePolicy: () => ({ ...defaultProjectPolicy, strictness: 'lenient' }),
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
  // lenient strictness drops `minor`, keeps `major`.
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

void test('pipeline: second automatic run on the same key is skipped (idempotency)', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);
  const autoJob: ReviewJob = { ...job, trigger: 'open' };

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

  await handle(autoJob);
  await handle(autoJob);

  // Engine ran only once; the second call short-circuited on `seen`.
  assert.equal(engine.reviewed.length, 1);
  assert.equal(publisher.published.length, 1);
});

void test('pipeline: @mira review re-runs an already seen SHA', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);
  const chatopsJob: ReviewJob = { ...job, trigger: 'chatops' };

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

  await handle(chatopsJob);
  await handle(chatopsJob);

  assert.equal(engine.reviewed.length, 2);
  assert.equal(publisher.published.length, 3);
  const rereviewAck = publisher.published[1]?.result;
  assert.deepEqual(rereviewAck?.degradations, [PRESENCE_ACK_NOTE, 'presence-kind:rereview']);
  assert.ok((rereviewAck?.summary ?? '').length > 0);
  assert.equal(cleanup.count, 2);
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
  const unavailableSummary =
    'Псс, я тут. Хотела всё как следует проревьюить, но ключи меня предали.';

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
    pickUnavailableSummary: () => unavailableSummary,
    hooks: {
      onEngineError: () => {
        engineErrors += 1;
      },
    },
  });

  await handle(job);

  assert.equal(engineErrors, 1);
  assert.equal(publisher.published.length, 1);
  const result = publisher.published[0]?.result;
  assert.equal(result?.findings.length, 0);
  assert.equal(result?.summary, unavailableSummary);
  assert.deepEqual(result?.degradations, ['engine-unavailable']);
  assert.equal(cleanup.count, 1);
});

void test('pipeline: waits on required CI without checkout, record, or engine', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);
  const ci = new FakeVcsCiReader();
  ci.snapshot = {
    description: 'See https://kaiten.example.com/cards/1',
    jobs: [{ id: 1, name: 'test', status: 'running', when: 'on_success', allowFailure: false }],
  };
  const waiting: ReviewJob[] = [];

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
    ciReader: ci,
    onWaiting: (j) => {
      waiting.push(j);
    },
    pickPresenceSummary: (kind) => `presence:${kind}`,
  });

  await handle({ ...job, trigger: 'open' });

  assert.equal(engine.reviewed.length, 0);
  assert.equal(cleanup.count, 0);
  assert.equal(waiting.length, 1);
  assert.equal(publisher.published.length, 1);
  assert.equal(publisher.published[0]?.result.summary, 'presence:wait');
  assert.deepEqual(publisher.published[0]?.result.degradations, [
    PRESENCE_ACK_NOTE,
    'presence-kind:wait',
  ]);
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

void test('pipeline: green required CI posts start ack then reviews', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const cleanup = { count: 0 };
  const engine = new FakeReviewEngine(engineResult);
  const ci = new FakeVcsCiReader();
  ci.snapshot = {
    description: 'https://kaiten.example.com/cards/1',
    jobs: [
      { id: 1, name: 'test', status: 'success', when: 'on_success', allowFailure: false },
      { id: 2, name: 'deploy', status: 'manual', when: 'manual', allowFailure: true },
    ],
  };

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
    ciReader: ci,
    pickPresenceSummary: (kind, description) => `${kind}|${description}`,
  });

  await handle({ ...job, trigger: 'open' });

  assert.equal(engine.reviewed.length, 1);
  assert.equal(engine.reviewed[0]?.ci?.status, 'green');
  assert.deepEqual(engine.reviewed[0]?.ci?.failures, []);
  assert.equal(publisher.published.length, 2);
  assert.equal(publisher.published[0]?.result.summary, 'green|https://kaiten.example.com/cards/1');
  assert.equal(publisher.published[1]?.result.verdict, 'risks');
  assert.equal(cleanup.count, 1);
  assert.equal(
    await store.seen({
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: 'review.v1+ci.green',
      partitionVersion: 'single.v1',
    }),
    true,
  );
});

void test('pipeline: red CI still reviews; manual trigger skips wait', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const engine = new FakeReviewEngine(engineResult);
  const ci = new FakeVcsCiReader();
  ci.snapshot = {
    description: '',
    jobs: [{ id: 10, name: 'test', status: 'failed', when: 'on_success', allowFailure: false }],
  };
  ci.traces.set(10, 'FAIL src/app.ts: AssertionError: expected 2');

  const released: ReviewJob[] = [];
  const redHandle = createReviewPipeline({
    contextBuilder: fakeContextBuilder({ count: 0 }),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine,
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    ciReader: ci,
    onCiMayChange: (j) => {
      released.push(j);
    },
    pickPresenceSummary: (kind) => kind,
  });
  await redHandle({ ...job, trigger: 'open' });
  assert.equal(publisher.published[0]?.result.summary, 'red');
  assert.equal(engine.reviewed.length, 1);
  assert.equal(engine.reviewed[0]?.ci?.status, 'red');
  assert.equal(engine.reviewed[0]?.ci?.failures[0]?.jobName, 'test');
  assert.match(engine.reviewed[0]?.ci?.failures[0]?.excerpt ?? '', /AssertionError/);
  assert.equal(released.length, 1);
  assert.equal(
    await store.seen({
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: 'review.v1+ci.red',
      partitionVersion: 'single.v1',
    }),
    true,
  );

  const skipped = new CapturingPublisher();
  const engine2 = new FakeReviewEngine(engineResult);
  const skipHandle = createReviewPipeline({
    contextBuilder: fakeContextBuilder({ count: 0 }),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine2,
    publisher: skipped,
    store: new InMemoryStateStore(),
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    ciReader: ci,
    pickPresenceSummary: (kind) => kind,
  });
  await skipHandle(job); // trigger: manual
  assert.equal(skipped.published.length, 1);
  assert.equal(skipped.published[0]?.result.verdict, 'risks');
  assert.equal(engine2.reviewed.length, 1);
});

void test('pipeline: CI reader errors degrade to immediate review', async () => {
  const publisher = new CapturingPublisher();
  const engine = new FakeReviewEngine(engineResult);
  const ci = new FakeVcsCiReader();
  ci.fail = new Error('gitlab 500');

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder({ count: 0 }),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine,
    publisher,
    store: new InMemoryStateStore(),
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    ciReader: ci,
  });

  await handle({ ...job, trigger: 'open' });
  assert.equal(engine.reviewed.length, 1);
  assert.equal(publisher.published.length, 1);
  assert.equal(publisher.published[0]?.result.verdict, 'risks');
});

void test('pipeline: red then green on the same SHA is a new review', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const engine = new FakeReviewEngine(engineResult);
  const ci = new FakeVcsCiReader();
  ci.snapshot = {
    description: '',
    jobs: [{ id: 10, name: 'test', status: 'failed', when: 'on_success', allowFailure: false }],
  };
  ci.traces.set(10, 'FAIL boom');
  const released: string[] = [];

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder({ count: 0 }),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine,
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    ciReader: ci,
    onCiMayChange: () => {
      released.push('change');
    },
    pickPresenceSummary: (kind) => kind,
  });

  await handle({ ...job, trigger: 'open' });
  assert.equal(engine.reviewed.length, 1);
  assert.equal(engine.reviewed[0]?.ci?.status, 'red');
  assert.equal(released.length, 1);

  ci.snapshot = {
    description: '',
    jobs: [{ id: 10, name: 'test', status: 'success', when: 'on_success', allowFailure: false }],
  };
  await handle({ ...job, trigger: 'open' });
  assert.equal(engine.reviewed.length, 2);
  assert.equal(engine.reviewed[1]?.ci?.status, 'green');
  assert.equal(publisher.published.filter((p) => p.result.summary === 'green').length, 1);
  assert.equal(
    await store.seen({
      projectId: job.projectId,
      mrIid: job.mrIid,
      headSha: job.headSha,
      promptVersion: 'review.v1+ci.green',
      partitionVersion: 'single.v1',
    }),
    true,
  );
});

void test('pipeline: second red on the same SHA skips without a new ack', async () => {
  const store = new InMemoryStateStore();
  const publisher = new CapturingPublisher();
  const engine = new FakeReviewEngine(engineResult);
  const ci = new FakeVcsCiReader();
  ci.snapshot = {
    description: '',
    jobs: [{ id: 10, name: 'test', status: 'failed', when: 'on_success', allowFailure: false }],
  };
  const released: number[] = [];

  const handle = createReviewPipeline({
    contextBuilder: fakeContextBuilder({ count: 0 }),
    resolvePolicy: () => defaultProjectPolicy,
    createEngine: () => engine,
    publisher,
    store,
    logger: silentLogger,
    clock: new FakeClock(),
    promptVersion: 'review.v1',
    partitionVersion: 'single.v1',
    ciReader: ci,
    onCiMayChange: () => {
      released.push(1);
    },
    pickPresenceSummary: (kind) => kind,
  });

  await handle({ ...job, trigger: 'open' });
  await handle({ ...job, trigger: 'open' });

  assert.equal(engine.reviewed.length, 1);
  assert.equal(publisher.published.length, 2); // red ack + review
  assert.equal(released.length, 2); // after record, then again on seen-skip
});
