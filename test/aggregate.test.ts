/**
 * Unit tests for merging partial review results: finding dedup, worst verdict,
 * requirement status aggregation, and degradation notes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding, RequirementCoverage, ReviewResult } from '../src/core/domain/index.ts';
import { aggregateResults } from '../src/core/aggregate/index.ts';

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

function result(
  overrides: Partial<ReviewResult> & Pick<ReviewResult, 'verdict' | 'summary'>,
): ReviewResult {
  const merged: ReviewResult = {
    verdict: overrides.verdict,
    summary: overrides.summary,
    findings: overrides.findings ?? [],
  };
  if (overrides.requirementsCoverage !== undefined) {
    merged.requirementsCoverage = overrides.requirementsCoverage;
  }
  if (overrides.degradations !== undefined) {
    merged.degradations = overrides.degradations;
  }
  return merged;
}

void test('aggregateResults: deduplicates findings by category|filePath|message', () => {
  const duplicate = finding({
    severity: 'major',
    category: 'bug',
    filePath: 'src/a.ts',
    message: 'null deref',
    lineStart: 10,
  });
  const unique = finding({
    severity: 'minor',
    category: 'style',
    filePath: 'src/b.ts',
    message: 'naming',
  });

  const merged = aggregateResults({
    results: [
      result({ verdict: 'ok', summary: 'unit 1', findings: [duplicate] }),
      result({
        verdict: 'risks',
        summary: 'unit 2',
        findings: [{ ...duplicate, severity: 'blocker', lineStart: 99 }, unique],
      }),
    ],
  });

  assert.equal(merged.findings.length, 2);
  assert.equal(merged.findings[0]?.severity, 'major');
  assert.equal(merged.findings[0]?.lineStart, 10);
  assert.equal(merged.findings[1]?.filePath, 'src/b.ts');
});

void test('aggregateResults: orders findings by severity then path then line', () => {
  const merged = aggregateResults({
    results: [
      result({
        verdict: 'ok',
        summary: 's',
        findings: [
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
        ],
      }),
    ],
  });

  assert.deepEqual(
    merged.findings.map((item) => `${item.severity}:${item.filePath}:${item.lineStart}`),
    ['blocker:src/a.ts:5', 'minor:src/z.ts:1'],
  );
});

void test('aggregateResults: verdict is the worst across units', () => {
  const merged = aggregateResults({
    results: [
      result({ verdict: 'ok', summary: 'clean' }),
      result({ verdict: 'risks', summary: 'some risks' }),
      result({ verdict: 'blockers', summary: 'stop ship' }),
    ],
  });

  assert.equal(merged.verdict, 'blockers');
});

void test('aggregateResults: requirement coverage keeps worst status per criterion', () => {
  const coverage = (
    criterion: string,
    status: RequirementCoverage['status'],
  ): RequirementCoverage => ({
    criterion,
    status,
  });

  const merged = aggregateResults({
    results: [
      result({
        verdict: 'ok',
        summary: 'u1',
        requirementsCoverage: [coverage('Login works', 'met'), coverage('Edge case', 'partial')],
      }),
      result({
        verdict: 'ok',
        summary: 'u2',
        requirementsCoverage: [coverage('Login works', 'missing'), coverage('Edge case', 'met')],
      }),
    ],
  });

  const byCriterion = new Map(
    merged.requirementsCoverage?.map((entry) => [entry.criterion, entry.status]),
  );
  assert.equal(byCriterion.get('Edge case'), 'partial');
  assert.equal(byCriterion.get('Login works'), 'missing');
});

void test('aggregateResults: merges summaries and degradations with skipped unit notes', () => {
  const merged = aggregateResults({
    results: [
      result({
        verdict: 'ok',
        summary: 'First pass',
        degradations: ['partial context'],
      }),
      result({
        verdict: 'risks',
        summary: 'Second pass',
        degradations: ['partial context', 'timeout on tool read'],
      }),
    ],
    skippedUnitIds: ['unit-2', 'unit-0'],
    skippedContentNotes: ['3 files excluded by ignored_globs'],
  });

  assert.match(merged.summary, /\[Unit 1\] First pass/);
  assert.match(merged.summary, /\[Unit 2\] Second pass/);
  assert.deepEqual(merged.degradations, [
    'partial context',
    'timeout on tool read',
    '3 files excluded by ignored_globs',
    'Skipped review units: unit-0, unit-2',
  ]);
});

void test('aggregateResults: empty input returns ok with optional degradations only', () => {
  const merged = aggregateResults({
    results: [],
    skippedContentNotes: ['nothing reviewed'],
  });

  assert.equal(merged.verdict, 'ok');
  assert.deepEqual(merged.findings, []);
  assert.deepEqual(merged.degradations, ['nothing reviewed']);
});
