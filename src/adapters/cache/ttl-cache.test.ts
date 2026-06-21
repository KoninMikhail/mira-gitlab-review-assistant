/**
 * Behavioral tests for {@link TtlCache}: TTL expiry, delete/clear, maxEntries eviction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Clock } from '../../core/ports/index.ts';
import { TtlCache } from './index.ts';

function fakeClock(initialMs = 0): { clock: Clock; advance: (deltaMs: number) => void } {
  let ms = initialMs;
  return {
    clock: {
      now(): Date {
        return new Date(ms);
      },
    },
    advance(deltaMs: number): void {
      ms += deltaMs;
    },
  };
}

void test('TtlCache: returns value before TTL expires', () => {
  const { clock } = fakeClock(1_000);
  const cache = new TtlCache<string>({ ttlMs: 5_000, clock });

  cache.set('key', 'value');
  assert.equal(cache.get('key'), 'value');
  assert.equal(cache.size, 1);
});

void test('TtlCache: miss after TTL expiry deletes entry', () => {
  const { clock, advance } = fakeClock(0);
  const cache = new TtlCache<string>({ ttlMs: 1_000, clock });

  cache.set('key', 'value');
  advance(1_000);

  assert.equal(cache.get('key'), undefined);
  assert.equal(cache.size, 0);
});

void test('TtlCache: delete and clear remove entries', () => {
  const { clock } = fakeClock();
  const cache = new TtlCache<number>({ ttlMs: 60_000, clock });

  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.size, 2);

  cache.delete('a');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 1);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('b'), undefined);
});

void test('TtlCache: maxEntries evicts oldest inserted key', () => {
  const { clock } = fakeClock();
  const cache = new TtlCache<string>({ ttlMs: 60_000, clock, maxEntries: 2 });

  cache.set('first', '1');
  cache.set('second', '2');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('first'), '1');
  assert.equal(cache.get('second'), '2');

  cache.set('third', '3');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('first'), undefined);
  assert.equal(cache.get('second'), '2');
  assert.equal(cache.get('third'), '3');
});
