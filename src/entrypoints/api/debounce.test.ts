/**
 * Unit tests for ingress debounce and dedup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewJob } from '../../core/domain/index.ts';
import { Debouncer } from './debounce.ts';

const NOW = '2026-06-21T12:00:00.000Z';

function job(overrides: Partial<ReviewJob> & Pick<ReviewJob, 'mrIid' | 'headSha'>): ReviewJob {
  return {
    projectId: 'group/app',
    trigger: 'push',
    enqueuedAt: NOW,
    ...overrides,
  };
}

interface FakeTimer {
  fn: () => void;
  ms: number;
}

function fakeScheduler() {
  const timers: FakeTimer[] = [];
  let nextId = 1;
  const handles = new Map<number, FakeTimer>();

  return {
    timers,
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId;
      nextId += 1;
      const entry = { fn, ms };
      timers.push(entry);
      handles.set(id, entry);
      return id;
    },
    cancel: (handle: unknown): void => {
      handles.delete(handle as number);
    },
    fireAllPending: (): void => {
      for (const entry of handles.values()) {
        entry.fn();
      }
    },
    pendingHandles: (): number => handles.size,
  };
}

void test('burst of pushes for same MR flushes only the latest job once', () => {
  const flushed: ReviewJob[] = [];
  const sched = fakeScheduler();
  const debouncer = new Debouncer({
    windowMs: 1000,
    onFlush: (j) => flushed.push(j),
    schedule: sched.schedule,
    cancel: sched.cancel,
  });

  assert.equal(debouncer.submit(job({ mrIid: 1, headSha: 'sha1' })), 'scheduled');
  assert.equal(debouncer.submit(job({ mrIid: 1, headSha: 'sha2' })), 'replaced');
  assert.equal(debouncer.submit(job({ mrIid: 1, headSha: 'sha3' })), 'replaced');
  assert.equal(debouncer.pending(), 1);

  sched.fireAllPending();

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.headSha, 'sha3');
  assert.equal(debouncer.pending(), 0);
});

void test('duplicate delivery returns duplicate without extra flush', () => {
  const flushed: ReviewJob[] = [];
  const sched = fakeScheduler();
  const debouncer = new Debouncer({
    windowMs: 1000,
    onFlush: (j) => flushed.push(j),
    schedule: sched.schedule,
    cancel: sched.cancel,
  });

  const j = job({ mrIid: 2, headSha: 'dup-sha', trigger: 'open' });
  assert.equal(debouncer.submit(j), 'scheduled');
  assert.equal(debouncer.submit(j), 'duplicate');

  sched.fireAllPending();
  assert.equal(flushed.length, 1);
});

void test('two different MRs get independent timers', () => {
  const flushed: ReviewJob[] = [];
  const sched = fakeScheduler();
  const debouncer = new Debouncer({
    windowMs: 500,
    onFlush: (j) => flushed.push(j),
    schedule: sched.schedule,
    cancel: sched.cancel,
  });

  assert.equal(debouncer.submit(job({ mrIid: 10, headSha: 'a' })), 'scheduled');
  assert.equal(debouncer.submit(job({ mrIid: 11, headSha: 'b' })), 'scheduled');
  assert.equal(debouncer.pending(), 2);

  sched.fireAllPending();

  assert.equal(flushed.length, 2);
  const shas = flushed.map((j) => j.headSha).sort();
  assert.deepEqual(shas, ['a', 'b']);
});
