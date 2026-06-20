/**
 * Unit tests for findings normalization: filters, strictness, dedup, and cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from '../src/core/domain/index.ts';
import { findingFingerprint } from '../src/core/idempotency/fingerprint.ts';
import { normalizeFindings } from '../src/core/normalize/normalize.ts';

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

void test('normalizeFindings: strict keeps all severities', () => {
  const findings = [
    finding({ severity: 'blocker', category: 'bug', filePath: 'a.ts', message: 'a' }),
    finding({ severity: 'major', category: 'bug', filePath: 'b.ts', message: 'b' }),
    finding({ severity: 'minor', category: 'bug', filePath: 'c.ts', message: 'c' }),
    finding({ severity: 'nit', category: 'style', filePath: 'd.ts', message: 'd' }),
  ];

  const result = normalizeFindings(findings, { strictness: 'strict', ignoredGlobs: [] });

  assert.equal(result.findings.length, 4);
  assert.equal(result.dropped.bySeverity, 0);
});

void test('normalizeFindings: balanced drops nit', () => {
  const findings = [
    finding({ severity: 'minor', category: 'bug', filePath: 'a.ts', message: 'a' }),
    finding({ severity: 'nit', category: 'style', filePath: 'b.ts', message: 'b' }),
  ];

  const result = normalizeFindings(findings, { strictness: 'balanced', ignoredGlobs: [] });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.finding.severity, 'minor');
  assert.equal(result.dropped.bySeverity, 1);
});

void test('normalizeFindings: lenient keeps only blocker and major', () => {
  const findings = [
    finding({ severity: 'blocker', category: 'bug', filePath: 'a.ts', message: 'a' }),
    finding({ severity: 'major', category: 'bug', filePath: 'b.ts', message: 'b' }),
    finding({ severity: 'minor', category: 'bug', filePath: 'c.ts', message: 'c' }),
    finding({ severity: 'nit', category: 'style', filePath: 'd.ts', message: 'd' }),
  ];

  const result = normalizeFindings(findings, { strictness: 'lenient', ignoredGlobs: [] });

  assert.deepEqual(
    result.findings.map((item) => item.finding.severity),
    ['blocker', 'major'],
  );
  assert.equal(result.dropped.bySeverity, 2);
});

void test('normalizeFindings: filters paths matching ignoredGlobs', () => {
  const findings = [
    finding({ severity: 'major', category: 'bug', filePath: 'src/app.ts', message: 'bug' }),
    finding({ severity: 'major', category: 'bug', filePath: 'package-lock.json', message: 'lock' }),
    finding({
      severity: 'major',
      category: 'bug',
      filePath: 'vendor/lib/foo.ts',
      message: 'vendor',
    }),
  ];

  const result = normalizeFindings(findings, {
    strictness: 'strict',
    ignoredGlobs: ['package-lock.json', 'vendor/**'],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.finding.filePath, 'src/app.ts');
  assert.equal(result.dropped.byGlob, 2);
});

void test('normalizeFindings: deduplicates by fingerprint, first wins', () => {
  const first = finding({
    severity: 'major',
    category: 'bug',
    filePath: 'src/a.ts',
    message: 'dup',
    lineStart: 1,
  });
  const duplicate = finding({
    severity: 'blocker',
    category: 'bug',
    filePath: 'src/a.ts',
    message: 'dup',
    lineStart: 50,
  });
  const unique = finding({
    severity: 'minor',
    category: 'style',
    filePath: 'src/b.ts',
    message: 'other',
  });

  const result = normalizeFindings([first, duplicate, unique], {
    strictness: 'strict',
    ignoredGlobs: [],
  });

  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]?.finding.severity, 'major');
  assert.equal(result.findings[0]?.finding.lineStart, 1);
  assert.equal(result.findings[0]?.fingerprint, findingFingerprint(first));
  assert.equal(result.dropped.byDedup, 1);
});

void test('normalizeFindings: caps to top-N by severity with stable tiebreak', () => {
  const findings = [
    finding({
      severity: 'minor',
      category: 'bug',
      filePath: 'src/z.ts',
      message: 'z',
      lineStart: 1,
    }),
    finding({
      severity: 'blocker',
      category: 'bug',
      filePath: 'src/a.ts',
      message: 'a',
      lineStart: 5,
    }),
    finding({
      severity: 'major',
      category: 'bug',
      filePath: 'src/m.ts',
      message: 'm',
    }),
    finding({
      severity: 'blocker',
      category: 'bug',
      filePath: 'src/b.ts',
      message: 'b',
      lineStart: 2,
    }),
  ];

  const result = normalizeFindings(findings, {
    strictness: 'strict',
    ignoredGlobs: [],
    maxFindings: 2,
  });

  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map(
      (item) => `${item.finding.severity}:${item.finding.filePath}:${item.finding.lineStart ?? 0}`,
    ),
    ['blocker:src/a.ts:5', 'blocker:src/b.ts:2'],
  );
  assert.equal(result.dropped.byCap, 2);
});

void test('normalizeFindings: deterministic sort severity then path then line', () => {
  const findings = [
    finding({
      severity: 'minor',
      category: 'bug',
      filePath: 'src/z.ts',
      message: 'z',
      lineStart: 9,
    }),
    finding({
      severity: 'minor',
      category: 'bug',
      filePath: 'src/a.ts',
      message: 'a2',
      lineStart: 20,
    }),
    finding({
      severity: 'minor',
      category: 'bug',
      filePath: 'src/a.ts',
      message: 'a1',
      lineStart: 5,
    }),
    finding({
      severity: 'major',
      category: 'bug',
      filePath: 'src/m.ts',
      message: 'm',
    }),
  ];

  const result = normalizeFindings(findings, { strictness: 'strict', ignoredGlobs: [] });

  assert.deepEqual(
    result.findings.map(
      (item) => `${item.finding.severity}:${item.finding.filePath}:${item.finding.lineStart ?? 0}`,
    ),
    ['major:src/m.ts:0', 'minor:src/a.ts:5', 'minor:src/a.ts:20', 'minor:src/z.ts:9'],
  );
});

void test('normalizeFindings: no cap when maxFindings omitted', () => {
  const findings = Array.from({ length: 5 }, (_, index) =>
    finding({
      severity: 'minor',
      category: 'bug',
      filePath: `src/f${index}.ts`,
      message: `m${index}`,
    }),
  );

  const result = normalizeFindings(findings, { strictness: 'strict', ignoredGlobs: [] });

  assert.equal(result.findings.length, 5);
  assert.equal(result.dropped.byCap, 0);
});
