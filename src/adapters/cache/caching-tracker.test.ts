/**
 * Behavioral tests for {@link CachingTaskTracker}: cache hit, TTL refresh, per-id keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TaskCard } from '../../core/domain/index.ts';
import type { Clock, TaskTracker } from '../../core/ports/index.ts';
import { CachingTaskTracker } from './index.ts';

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

function makeCard(id: string): TaskCard {
  return {
    id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    acceptanceCriteria: [`AC ${id}`],
  };
}

function countingTracker(cards: Record<string, TaskCard>): TaskTracker & { callCount: () => number } {
  let calls = 0;
  return {
    callCount(): number {
      return calls;
    },
    async getCard(cardId: string): Promise<TaskCard> {
      calls += 1;
      const card = cards[cardId];
      if (card === undefined) {
        throw new Error(`unknown card: ${cardId}`);
      }
      return card;
    },
  };
}

void test('CachingTaskTracker: second getCard with same id is served from cache', async () => {
  const inner = countingTracker({ '42': makeCard('42') });
  const tracker = new CachingTaskTracker({ inner, ttlMs: 60_000 });

  const first = await tracker.getCard('42');
  const second = await tracker.getCard('42');

  assert.deepEqual(second, first);
  assert.equal(inner.callCount(), 1);
});

void test('CachingTaskTracker: after TTL expiry inner is called again', async () => {
  const { clock, advance } = fakeClock();
  const inner = countingTracker({ '42': makeCard('42') });
  const tracker = new CachingTaskTracker({ inner, ttlMs: 1_000, clock });

  await tracker.getCard('42');
  advance(1_000);
  await tracker.getCard('42');

  assert.equal(inner.callCount(), 2);
});

void test('CachingTaskTracker: different ids are cached independently', async () => {
  const inner = countingTracker({
    '1': makeCard('1'),
    '2': makeCard('2'),
  });
  const tracker = new CachingTaskTracker({ inner, ttlMs: 60_000 });

  await tracker.getCard('1');
  await tracker.getCard('2');
  await tracker.getCard('1');
  await tracker.getCard('2');

  assert.equal(inner.callCount(), 2);
});
