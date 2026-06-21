/**
 * Read-through cache decorator for {@link TaskTracker#getCard} backed by
 * {@link TtlCache}.
 */
import type { TaskCard } from '../../core/domain/index.ts';
import type { Clock, TaskTracker } from '../../core/ports/index.ts';
import { TtlCache } from './ttl-cache.ts';

export interface CachingTaskTrackerOptions {
  inner: TaskTracker;
  ttlMs: number;
  clock?: Clock;
  maxEntries?: number;
}

/** {@link TaskTracker} wrapper that caches {@link TaskCard} results by card id. */
export class CachingTaskTracker implements TaskTracker {
  private readonly inner: TaskTracker;
  private readonly cache: TtlCache<TaskCard>;

  constructor(options: CachingTaskTrackerOptions) {
    this.inner = options.inner;
    this.cache = new TtlCache({
      ttlMs: options.ttlMs,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    });
  }

  async getCard(cardId: string): Promise<TaskCard> {
    const cached = this.cache.get(cardId);
    if (cached !== undefined) {
      return cached;
    }
    const card = await this.inner.getCard(cardId);
    this.cache.set(cardId, card);
    return card;
  }
}
