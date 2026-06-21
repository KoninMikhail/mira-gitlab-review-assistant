/**
 * Generic in-memory TTL cache with optional entry cap and injectable {@link Clock}
 * for deterministic expiry in tests.
 */
import type { Clock } from '../../core/ports/index.ts';

const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

export interface TtlCacheOptions {
  ttlMs: number;
  clock?: Clock;
  maxEntries?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** String-keyed in-memory cache; entries expire after {@link TtlCacheOptions.ttlMs}. */
export class TtlCache<V> {
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly maxEntries: number | undefined;
  private readonly entries = new Map<string, CacheEntry<V>>();

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.clock = options.clock ?? systemClock;
    this.maxEntries = options.maxEntries;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.clock.now().getTime() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    const isNew = !this.entries.has(key);
    const expiresAt = this.clock.now().getTime() + this.ttlMs;
    this.entries.set(key, { value, expiresAt });

    if (isNew && this.maxEntries !== undefined && this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
