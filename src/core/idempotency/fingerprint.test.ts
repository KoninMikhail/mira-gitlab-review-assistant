/**
 * Unit tests for canonical finding fingerprints (`core/idempotency`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from '../domain/index.ts';
import { findingFingerprint } from './fingerprint.ts';

function finding(
  overrides: Partial<Finding> & Pick<Finding, 'severity' | 'category' | 'filePath' | 'message'>,
): Finding {
  const merged: Finding = {
    severity: overrides.severity,
    category: overrides.category,
    filePath: overrides.filePath,
    message: overrides.message,
  };
  if (overrides.lineStart !== undefined) merged.lineStart = overrides.lineStart;
  if (overrides.lineEnd !== undefined) merged.lineEnd = overrides.lineEnd;
  if (overrides.rationale !== undefined) merged.rationale = overrides.rationale;
  if (overrides.suggestion !== undefined) merged.suggestion = overrides.suggestion;
  if (overrides.confidence !== undefined) merged.confidence = overrides.confidence;
  return merged;
}

void test('findingFingerprint: stable for identical anchor content', () => {
  const first = finding({
    severity: 'major',
    category: 'bug',
    filePath: 'src/a.ts',
    message: 'null deref',
    lineStart: 10,
  });
  const second = finding({
    severity: 'critical',
    category: 'bug',
    filePath: 'src/a.ts',
    message: 'null deref',
    lineStart: 99,
    lineEnd: 100,
  });

  assert.equal(findingFingerprint(first), findingFingerprint(second));
});

void test('findingFingerprint: different message yields different digest', () => {
  const base = finding({
    severity: 'minor',
    category: 'style',
    filePath: 'src/b.ts',
    message: 'prefer const',
    lineStart: 1,
  });
  const other = finding({
    severity: 'minor',
    category: 'style',
    filePath: 'src/b.ts',
    message: 'use let instead',
    lineStart: 1,
  });

  assert.notEqual(findingFingerprint(base), findingFingerprint(other));
});

void test('findingFingerprint: matches sqlite adapter delegate', async () => {
  const sample = finding({
    severity: 'major',
    category: 'security',
    filePath: 'src/auth.ts',
    message: 'missing validation',
  });

  const { findingFingerprint: sqliteFingerprint } =
    await import('../../adapters/store/sqlite/fingerprint.ts');

  assert.equal(findingFingerprint(sample), sqliteFingerprint(sample));
});
