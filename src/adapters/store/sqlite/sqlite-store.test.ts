/**
 * Unit tests for the SQLite `StateStore` adapter (`:memory:` and temp-file DBs).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { Finding, ReviewResult } from '../../../core/domain/index.ts';
import type { ReviewKey } from '../../../core/ports/index.ts';
import { findingFingerprint, SqliteStateStore } from './index.ts';

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

const finding: Finding = {
  severity: 'major',
  category: 'bug',
  filePath: 'src/a.ts',
  message: 'null dereference',
  lineStart: 10,
  lineEnd: 12,
};

void test('SqliteStateStore: seen flips only after record, per full key', async () => {
  const store = new SqliteStateStore({ path: ':memory:' });
  const key = makeReviewKey('sha-a');

  assert.equal(await store.seen(key), false);
  await store.record(key, sampleResult);
  assert.equal(await store.seen(key), true);

  assert.equal(await store.seen(makeReviewKey('sha-b')), false);
  assert.equal(await store.seen(makeReviewKey('sha-a', { promptVersion: 'review.v2' })), false);

  store.close();
});

void test('SqliteStateStore: double record with same data is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-sqlite-store-'));
  const dbPath = join(dir, 'state.db');

  try {
    const result: ReviewResult = {
      verdict: 'risks',
      summary: 'one issue',
      findings: [finding],
    };
    const key = makeReviewKey('sha-a');

    const store = new SqliteStateStore({ path: dbPath });
    await store.record(key, result);
    await store.record(key, result);
    store.close();

    const reopened = new SqliteStateStore({ path: dbPath });
    assert.equal(await reopened.seen(key), true);
    reopened.close();

    const inspect = new DatabaseSync(dbPath);
    const reviewCount = inspect.prepare('SELECT COUNT(*) AS n FROM MR_REVIEW').get() as {
      n: number;
    };
    const findingCount = inspect.prepare('SELECT COUNT(*) AS n FROM FINDING_RECORD').get() as {
      n: number;
    };
    inspect.close();

    assert.equal(reviewCount.n, 1);
    assert.equal(findingCount.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('findingFingerprint: stable for same anchor, ignores line numbers', () => {
  const base: Finding = {
    severity: 'minor',
    category: 'style',
    filePath: 'src/b.ts',
    message: 'prefer const',
    lineStart: 1,
    lineEnd: 1,
  };

  const sameAnchor: Finding = {
    ...base,
    lineStart: 99,
    lineEnd: 100,
  };
  const differentMessage: Finding = {
    ...base,
    message: 'use let instead',
  };

  assert.equal(findingFingerprint(base), findingFingerprint(sameAnchor));
  assert.notEqual(findingFingerprint(base), findingFingerprint(differentMessage));
});
