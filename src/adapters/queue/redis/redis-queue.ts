/**
 * Redis-backed FIFO job queue with {@link JobKey} dedup while pending. Blocking
 * consumers via {@link RedisQueue.take}; inject a {@link RedisLike} client
 * (e.g. ioredis) from the composition root.
 */
import type { Queue } from '../../../core/ports/index.ts';
import type { JobKey, ReviewJob } from '../../../core/domain/index.ts';

function jobKeyOf(key: JobKey): string {
  return `${key.projectId}\u0000${String(key.mrIid)}\u0000${key.headSha}`;
}

/** Minimal Redis command surface used by {@link RedisQueue}. */
export interface RedisLike {
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  rpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  blpop(key: string, timeoutSeconds: number): Promise<[string, string] | null>;
  llen(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

export interface RedisQueueOptions {
  redis: RedisLike;
  keyPrefix?: string;
}

/** Redis FIFO queue implementing {@link Queue} plus blocking {@link take}. */
export class RedisQueue implements Queue {
  private readonly redis: RedisLike;
  private readonly listKey: string;
  private readonly pendingSet: string;
  private closed = false;

  constructor(options: RedisQueueOptions) {
    this.redis = options.redis;
    const prefix = options.keyPrefix ?? 'mira';
    this.listKey = `${prefix}:queue`;
    this.pendingSet = `${prefix}:pending`;
  }

  async enqueue(job: ReviewJob): Promise<boolean> {
    const key = jobKeyOf(job);
    const added = await this.redis.sadd(this.pendingSet, key);
    if (added === 0) {
      return false;
    }
    await this.redis.rpush(this.listKey, JSON.stringify(job));
    return true;
  }

  async dequeue(): Promise<ReviewJob | undefined> {
    const raw = await this.redis.lpop(this.listKey);
    if (raw === null) {
      return undefined;
    }
    const job = JSON.parse(raw) as ReviewJob;
    await this.redis.srem(this.pendingSet, jobKeyOf(job));
    return job;
  }

  async size(): Promise<number> {
    return this.redis.llen(this.listKey);
  }

  /**
   * Remove and return the next job, blocking until one is available. Resolves
   * `undefined` when the queue is closed and drained, or when `signal` aborts.
   */
  async take(signal?: AbortSignal): Promise<ReviewJob | undefined> {
    while (true) {
      if (signal?.aborted) {
        return undefined;
      }

      const res = await this.redis.blpop(this.listKey, 1);
      if (res === null) {
        if (this.closed) {
          return undefined;
        }
        continue;
      }

      const job = JSON.parse(res[1]) as ReviewJob;
      await this.redis.srem(this.pendingSet, jobKeyOf(job));
      return job;
    }
  }

  /** Stop blocking {@link take} once the list is drained. */
  close(): void {
    this.closed = true;
  }

  async quit(): Promise<unknown> {
    return this.redis.quit();
  }
}
