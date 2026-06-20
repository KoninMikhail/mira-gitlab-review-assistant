/**
 * Tests for the generic {@link runWorker} loop: ordering, concurrency cap,
 * handler error isolation, and clean shutdown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewJob } from '../domain/index.ts';
import type { JobSource } from './index.ts';
import { runWorker } from './index.ts';
import { InProcQueue } from '../../adapters/queue/inproc/index.ts';

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Minimal {@link JobSource} for worker tests without the full queue adapter. */
class FakeJobSource implements JobSource {
  private readonly jobs: ReviewJob[] = [];
  private readonly waiters: Array<(job: ReviewJob | undefined) => void> = [];
  private closed = false;

  push(job: ReviewJob): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(job);
      return;
    }
    this.jobs.push(job);
  }

  close(): void {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter(undefined);
    }
  }

  take(signal?: AbortSignal): Promise<ReviewJob | undefined> {
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }

    const job = this.jobs.shift();
    if (job !== undefined) {
      return Promise.resolve(job);
    }

    if (this.closed) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(resolve);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve(undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(resolve);
    });
  }
}

void test('runWorker: processes jobs in FIFO order at concurrency 1', async () => {
  const queue = new InProcQueue();
  const order: string[] = [];

  await queue.enqueue(makeJob('sha-a'));
  await queue.enqueue(makeJob('sha-b'));
  await queue.enqueue(makeJob('sha-c'));
  queue.close();

  await runWorker({
    queue,
    concurrency: 1,
    handler: async (job) => {
      order.push(job.headSha);
    },
  });

  assert.deepEqual(order, ['sha-a', 'sha-b', 'sha-c']);
});

void test('runWorker: never exceeds concurrency limit', async () => {
  const queue = new InProcQueue();
  const jobCount = 5;
  const concurrency = 2;
  let active = 0;
  let peak = 0;
  let releaseAll!: () => void;
  const blockAll = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });

  for (let i = 0; i < jobCount; i++) {
    await queue.enqueue(makeJob(`sha-${String(i)}`));
  }
  queue.close();

  const workerPromise = runWorker({
    queue,
    concurrency,
    handler: async () => {
      active++;
      peak = Math.max(peak, active);
      await blockAll;
      active--;
    },
  });

  while (peak < concurrency) {
    await Promise.resolve();
  }
  assert.equal(peak, concurrency);

  releaseAll();
  await workerPromise;
  assert.equal(active, 0);
});

void test('runWorker: handler errors do not stop subsequent jobs', async () => {
  const queue = new InProcQueue();
  const processed: string[] = [];
  const errors: string[] = [];

  await queue.enqueue(makeJob('sha-fail'));
  await queue.enqueue(makeJob('sha-ok'));
  queue.close();

  await runWorker({
    queue,
    concurrency: 1,
    handler: async (job) => {
      if (job.headSha === 'sha-fail') {
        throw new Error('boom');
      }
      processed.push(job.headSha);
    },
    logger: { error: (msg) => errors.push(msg) },
  });

  assert.deepEqual(processed, ['sha-ok']);
  assert.deepEqual(errors, ['boom']);
});

void test('runWorker: stops on abort signal and drains in-flight work', async () => {
  const source = new FakeJobSource();
  const started = deferred<void>();
  const finishFirst = deferred<void>();
  const processed: string[] = [];

  source.push(makeJob('sha-a'));
  source.push(makeJob('sha-b'));

  const controller = new AbortController();

  const workerPromise = runWorker({
    queue: source,
    concurrency: 1,
    signal: controller.signal,
    handler: async (job) => {
      processed.push(job.headSha);
      if (job.headSha === 'sha-a') {
        started.resolve(undefined);
        await finishFirst.promise;
      }
    },
  });

  await started.promise;
  controller.abort();
  source.close();
  finishFirst.resolve(undefined);

  await workerPromise;
  assert.deepEqual(processed, ['sha-a']);
});

void test('runWorker: works with FakeJobSource', async () => {
  const source = new FakeJobSource();
  const order: string[] = [];

  source.push(makeJob('sha-a'));
  source.push(makeJob('sha-b'));
  source.close();

  await runWorker({
    queue: source,
    concurrency: 2,
    handler: async (job) => {
      order.push(job.headSha);
    },
  });

  assert.deepEqual(order, ['sha-a', 'sha-b']);
});
