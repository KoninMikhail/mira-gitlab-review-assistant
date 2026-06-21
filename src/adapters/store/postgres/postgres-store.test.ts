/**
 * Unit tests for the Postgres `StateStore` adapter using a fake `PgPoolLike`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Finding, ReviewResult } from '../../../core/domain/index.ts';
import type { ReviewKey } from '../../../core/ports/index.ts';
import { findingFingerprint, PostgresStateStore } from './index.ts';
import type { PgPoolLike, PgQueryResult } from './postgres-store.ts';

interface CapturedQuery {
  text: string;
  params: readonly unknown[] | undefined;
}

interface FakePoolOptions {
  /** Canned row sets keyed by substring matched against SQL text. */
  selectResponses?: ReadonlyMap<string, unknown[]>;
}

function createFakePool(options: FakePoolOptions = {}): {
  pool: PgPoolLike;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];

  const pool: PgPoolLike = {
    async query<R = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult<R>> {
      queries.push({ text, params });

      if (options.selectResponses && /^\s*SELECT/i.test(text)) {
        for (const [needle, rows] of options.selectResponses) {
          if (text.includes(needle)) {
            return { rows: rows as R[] };
          }
        }
      }

      return { rows: [] };
    },
  };

  return { pool, queries };
}

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

const finding: Finding = {
  severity: 'major',
  category: 'bug',
  filePath: 'src/a.ts',
  message: 'null dereference',
  lineStart: 10,
  lineEnd: 12,
};

void test('PostgresStateStore: seen returns false when SELECT yields no rows', async () => {
  const { pool } = createFakePool();
  const store = new PostgresStateStore({ pool });
  const key = makeReviewKey('sha-a');

  assert.equal(await store.seen(key), false);
});

void test('PostgresStateStore: seen returns true when SELECT yields a row', async () => {
  const { pool } = createFakePool({
    selectResponses: new Map([['mr_review', [{ '1': 1 }]]]),
  });
  const store = new PostgresStateStore({ pool });
  const key = makeReviewKey('sha-a');

  assert.equal(await store.seen(key), true);
});

void test('PostgresStateStore: record upserts mr_review and inserts finding_record rows', async () => {
  const { pool, queries } = createFakePool();
  const store = new PostgresStateStore({ pool });
  const key = makeReviewKey('sha-a');
  const result: ReviewResult = {
    verdict: 'risks',
    summary: 'one issue',
    findings: [finding],
  };

  await store.record(key, result);

  const reviewUpsert = queries.find((q) => q.text.includes('mr_review') && q.text.includes('INSERT'));
  assert.ok(reviewUpsert, 'expected mr_review upsert');
  assert.deepEqual(reviewUpsert.params, [
    key.projectId,
    key.mrIid,
    key.headSha,
    key.promptVersion,
    key.partitionVersion,
    result.verdict,
    result.summary,
    reviewUpsert.params?.[7],
  ]);
  assert.match(String(reviewUpsert.params?.[7]), /^\d{4}-\d{2}-\d{2}T/);

  const findingInsert = queries.find(
    (q) => q.text.includes('finding_record') && q.text.includes('INSERT'),
  );
  assert.ok(findingInsert, 'expected finding_record insert');
  assert.deepEqual(findingInsert.params, [
    key.projectId,
    key.mrIid,
    key.headSha,
    key.promptVersion,
    key.partitionVersion,
    findingFingerprint(finding),
    finding.severity,
    finding.category,
    finding.filePath,
    finding.message,
    finding.lineStart,
    finding.lineEnd,
  ]);
});

void test('PostgresStateStore: record maps missing line numbers to null', async () => {
  const { pool, queries } = createFakePool();
  const store = new PostgresStateStore({ pool });
  const key = makeReviewKey('sha-b');
  const bareFinding: Finding = {
    severity: 'minor',
    category: 'style',
    filePath: 'src/b.ts',
    message: 'prefer const',
  };

  await store.record(key, { verdict: 'ok', summary: 'fine', findings: [bareFinding] });

  const findingInsert = queries.find(
    (q) => q.text.includes('finding_record') && q.text.includes('INSERT'),
  );
  assert.ok(findingInsert);
  assert.equal(findingInsert.params?.[10], null);
  assert.equal(findingInsert.params?.[11], null);
});

void test('PostgresStateStore: ignore inserts into mr_ignore', async () => {
  const { pool, queries } = createFakePool();
  const store = new PostgresStateStore({ pool });

  await store.ignore('group/app', 7, 'fp-abc');

  const ignoreInsert = queries.find((q) => q.text.includes('mr_ignore') && q.text.includes('INSERT'));
  assert.ok(ignoreInsert, 'expected mr_ignore insert');
  assert.deepEqual(ignoreInsert.params?.slice(0, 3), ['group/app', 7, 'fp-abc']);
  assert.match(String(ignoreInsert.params?.[3]), /^\d{4}-\d{2}-\d{2}T/);
});

void test('PostgresStateStore: ignored maps SELECT rows to Set<string>', async () => {
  const { pool } = createFakePool({
    selectResponses: new Map([
      [
        'mr_ignore',
        [{ fingerprint: 'fp-one' }, { fingerprint: 'fp-two' }],
      ],
    ]),
  });
  const store = new PostgresStateStore({ pool });

  const ignored = await store.ignored('group/app', 7);
  assert.deepEqual([...ignored].sort(), ['fp-one', 'fp-two']);
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
