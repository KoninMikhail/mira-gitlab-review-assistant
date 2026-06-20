/**
 * Contract tests for the in-memory port fakes (test/fakes.ts). They double as a
 * compile-time check that the fakes satisfy the `core` port interfaces and as a
 * behavioral spec for the bits `core` relies on: queue dedup/FIFO, state-store
 * idempotency keyed by prompt/partition version, and a deterministic clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MrContext, ReviewKey } from '../src/core/ports/index.ts';
import type { ReviewJob, ReviewResult, TaskCard } from '../src/core/domain/index.ts';
import {
  FakeClock,
  FakeIgnoreStore,
  FakeReviewEngine,
  FakeTaskTracker,
  FakeVcsReader,
  FakeVcsWriter,
  InMemoryQueue,
  InMemoryStateStore,
} from './fakes.ts';

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

const sampleResult: ReviewResult = {
  verdict: 'ok',
  summary: 'looks good',
  findings: [],
};

void test('InMemoryQueue: FIFO order and dedup by job key', async () => {
  const queue = new InMemoryQueue();

  assert.equal(await queue.enqueue(makeJob('sha-a')), true);
  assert.equal(await queue.enqueue(makeJob('sha-b')), true);
  // Same (project, mr, sha) as the first pending job → deduped.
  assert.equal(await queue.enqueue(makeJob('sha-a', { trigger: 'push' })), false);
  assert.equal(await queue.size(), 2);

  const first = await queue.dequeue();
  assert.equal(first?.headSha, 'sha-a');
  const second = await queue.dequeue();
  assert.equal(second?.headSha, 'sha-b');
  assert.equal(await queue.dequeue(), undefined);
});

void test('InMemoryQueue: a key can be re-enqueued after it is dequeued', async () => {
  const queue = new InMemoryQueue();

  await queue.enqueue(makeJob('sha-a'));
  await queue.dequeue();
  // No longer pending → accepted again.
  assert.equal(await queue.enqueue(makeJob('sha-a')), true);
  assert.equal(await queue.size(), 1);
});

void test('InMemoryStateStore: seen flips only after record, per full key', async () => {
  const store = new InMemoryStateStore();
  const key = makeReviewKey('sha-a');

  assert.equal(await store.seen(key), false);
  await store.record(key, sampleResult);
  assert.equal(await store.seen(key), true);

  // A different SHA is independent.
  assert.equal(await store.seen(makeReviewKey('sha-b')), false);
  // Same SHA but a newer prompt version must re-trigger (not seen).
  assert.equal(await store.seen(makeReviewKey('sha-a', { promptVersion: 'review.v2' })), false);
});

void test('FakeVcsReader: returns seeded MRs and rejects unknown ones', async () => {
  const mr: MrContext = {
    projectId: 'group/app',
    mrIid: 7,
    title: 'Add feature',
    description: 'body',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    headSha: 'sha-a',
    changedFiles: [],
  };
  const reader = new FakeVcsReader([mr]);

  assert.deepEqual(await reader.getMrContext('group/app', 7), mr);
  await assert.rejects(() => reader.getMrContext('group/app', 99), /not found/);
  assert.equal(reader.requested.length, 2);
});

void test('FakeVcsWriter: creates, lists, and updates notes', async () => {
  const writer = new FakeVcsWriter();
  const created = await writer.createNote('group/app', 7, 'summary body');
  assert.equal(created.id, 1);

  const notes = await writer.listNotes('group/app', 7);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.body, 'summary body');

  await writer.updateNote('group/app', 7, created.id, 'edited body');
  const after = await writer.listNotes('group/app', 7);
  assert.equal(after[0]?.body, 'edited body');
});

void test('FakeVcsWriter: creates and resolves discussions', async () => {
  const writer = new FakeVcsWriter();
  const position = {
    baseSha: 'base',
    startSha: 'start',
    headSha: 'head',
    newPath: 'src/a.ts',
    newLine: 12,
  };
  const discussion = await writer.createDiscussion('group/app', 7, 'inline finding', position);
  assert.equal(discussion.resolved, false);
  assert.deepEqual(writer.positions.get(discussion.id), position);

  await writer.resolveDiscussion('group/app', 7, discussion.id, true);
  const [stored] = await writer.listDiscussions('group/app', 7);
  assert.equal(stored?.resolved, true);
});

void test('FakeIgnoreStore: records and returns ignored fingerprints', async () => {
  const store = new FakeIgnoreStore();
  await store.ignore('group/app', 7, 'fp-1');
  await store.ignore('group/app', 7, 'fp-1');
  await store.ignore('group/app', 7, 'fp-2');

  const ignored = await store.ignored('group/app', 7);
  assert.deepEqual([...ignored].sort(), ['fp-1', 'fp-2']);
  assert.equal((await store.ignored('group/app', 8)).size, 0);
});

void test('FakeTaskTracker: resolves seeded cards, rejects unknown ids', async () => {
  const card: TaskCard = { id: '4567', title: 'Card', description: 'd', acceptanceCriteria: [] };
  const tracker = new FakeTaskTracker({ '4567': card });

  assert.deepEqual(await tracker.getCard('4567'), card);
  await assert.rejects(() => tracker.getCard('0000'), /not found/);
  assert.deepEqual(tracker.requested, ['4567', '0000']);
});

void test('FakeReviewEngine: returns the canned result and records contexts', async () => {
  const engine = new FakeReviewEngine(sampleResult);
  const context = {
    job: { projectId: 'group/app', mrIid: 7, headSha: 'sha-a' },
    title: 'Add feature',
    description: 'body',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    changedFiles: [],
    diff: '',
  };

  const result = await engine.review(context);
  assert.equal(result, sampleResult);
  assert.equal(engine.reviewed.length, 1);
  assert.equal(engine.reviewed[0]?.job.headSha, 'sha-a');
});

void test('FakeClock: is deterministic and advances on demand', () => {
  const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(clock.now().toISOString(), '2026-01-01T00:00:00.000Z');

  clock.advance(1500);
  assert.equal(clock.now().toISOString(), '2026-01-01T00:00:01.500Z');
  // now() returns a copy: mutating it must not affect the clock.
  clock.now().setFullYear(2000);
  assert.equal(clock.now().toISOString(), '2026-01-01T00:00:01.500Z');
});
