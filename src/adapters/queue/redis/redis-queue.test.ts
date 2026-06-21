/**
 * Behavioral tests for {@link RedisQueue}: FIFO, dedup, blocking take, size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewJob } from '../../../core/domain/index.ts';
import { RedisQueue, type RedisLike } from './index.ts';

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

class FakeRedis implements RedisLike {
  private readonly lists = new Map<string, string[]>();
  private readonly sets = new Map<string, Set<string>>();
  quitCalled = false;

  private getList(key: string): string[] {
    let list = this.lists.get(key);
    if (list === undefined) {
      list = [];
      this.lists.set(key, list);
    }
    return list;
  }

  private getSet(key: string): Set<string> {
    let set = this.sets.get(key);
    if (set === undefined) {
      set = new Set();
      this.sets.set(key, set);
    }
    return set;
  }

  async sadd(key: string, member: string): Promise<number> {
    const set = this.getSet(key);
    if (set.has(member)) {
      return 0;
    }
    set.add(member);
    return 1;
  }

  async srem(key: string, member: string): Promise<number> {
    const set = this.getSet(key);
    if (!set.has(member)) {
      return 0;
    }
    set.delete(member);
    return 1;
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.getList(key);
    list.push(value);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.getList(key);
    const value = list.shift();
    return value ?? null;
  }

  async blpop(key: string, _timeoutSeconds: number): Promise<[string, string] | null> {
    const list = this.getList(key);
    const value = list.shift();
    if (value !== undefined) {
      return [key, value];
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return null;
  }

  async llen(key: string): Promise<number> {
    return this.getList(key).length;
  }

  async quit(): Promise<unknown> {
    this.quitCalled = true;
    return 'OK';
  }
}

function createQueue(keyPrefix?: string): { queue: RedisQueue; redis: FakeRedis } {
  const redis = new FakeRedis();
  const queue = new RedisQueue(
    keyPrefix === undefined ? { redis } : { redis, keyPrefix },
  );
  return { queue, redis };
}

void test('RedisQueue: FIFO order and dedup by job key', async () => {
  const { queue } = createQueue();

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

void test('RedisQueue: a key can be re-enqueued after it is consumed', async () => {
  const { queue } = createQueue();

  await queue.enqueue(makeJob('sha-a'));
  await queue.dequeue();
  assert.equal(await queue.enqueue(makeJob('sha-a')), true);
  assert.equal(await queue.size(), 1);
});

void test('RedisQueue: take resolves when a job is enqueued', async () => {
  const { queue } = createQueue();
  const takePromise = queue.take();

  await queue.enqueue(makeJob('sha-a'));
  const job = await takePromise;
  assert.equal(job?.headSha, 'sha-a');
  assert.equal(await queue.size(), 0);
});

void test('RedisQueue: take resolves undefined after close when drained', async () => {
  const { queue } = createQueue();
  const takePromise = queue.take();

  queue.close();
  assert.equal(await takePromise, undefined);
  assert.equal(await queue.take(), undefined);
});

void test('RedisQueue: size reflects list length', async () => {
  const { queue } = createQueue();

  assert.equal(await queue.size(), 0);
  await queue.enqueue(makeJob('sha-a'));
  await queue.enqueue(makeJob('sha-b'));
  assert.equal(await queue.size(), 2);
  await queue.dequeue();
  assert.equal(await queue.size(), 1);
});

void test('RedisQueue: quit delegates to the redis client', async () => {
  const { queue, redis } = createQueue();

  await queue.quit();
  assert.equal(redis.quitCalled, true);
});
