/**
 * Behavioral tests for {@link InProcQueue}: FIFO, dedup, blocking take, size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewJob } from '../../../core/domain/index.ts';
import { InProcQueue } from './index.ts';

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

void test('InProcQueue: FIFO order and dedup by job key', async () => {
  const queue = new InProcQueue();

  assert.equal(await queue.enqueue(makeJob('sha-a')), true);
  assert.equal(await queue.enqueue(makeJob('sha-b')), true);
  assert.equal(await queue.enqueue(makeJob('sha-a', { trigger: 'push' })), false);
  assert.equal(await queue.size(), 2);

  const first = await queue.dequeue();
  assert.equal(first?.headSha, 'sha-a');
  const second = await queue.dequeue();
  assert.equal(second?.headSha, 'sha-b');
  assert.equal(await queue.dequeue(), undefined);
});

void test('InProcQueue: a key can be re-enqueued after it is consumed', async () => {
  const queue = new InProcQueue();

  await queue.enqueue(makeJob('sha-a'));
  await queue.dequeue();
  assert.equal(await queue.enqueue(makeJob('sha-a')), true);
  assert.equal(await queue.size(), 1);
});

void test('InProcQueue: take resolves when a job is enqueued', async () => {
  const queue = new InProcQueue();
  const takePromise = queue.take();

  await queue.enqueue(makeJob('sha-a'));
  const job = await takePromise;
  assert.equal(job?.headSha, 'sha-a');
  assert.equal(await queue.size(), 0);
});

void test('InProcQueue: take resolves undefined after close when drained', async () => {
  const queue = new InProcQueue();
  const takePromise = queue.take();

  queue.close();
  assert.equal(await takePromise, undefined);
  assert.equal(await queue.take(), undefined);
});

void test('InProcQueue: close rejects new enqueues', async () => {
  const queue = new InProcQueue();
  queue.close();
  assert.equal(await queue.enqueue(makeJob('sha-a')), false);
});

void test('InProcQueue: take aborts via signal', async () => {
  const queue = new InProcQueue();
  const controller = new AbortController();
  const takePromise = queue.take(controller.signal);

  controller.abort();
  assert.equal(await takePromise, undefined);
});
