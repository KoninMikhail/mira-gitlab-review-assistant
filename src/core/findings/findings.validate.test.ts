import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings } from './index.ts';

void test('accepts a well-formed review result and maps to the domain shape', () => {
  const good = {
    verdict: 'risks',
    summary: 'One likely bug. Acceptance criteria mostly met.',
    requirements_coverage: [
      { criterion: 'User can sign in', status: 'met', evidence: 'src/auth.ts:12' },
      { criterion: 'Errors are shown', status: 'partial' },
    ],
    findings: [
      {
        severity: 'major',
        category: 'bug',
        file_path: 'src/users/service.ts',
        line_start: 42,
        line_end: 45,
        message: 'Possible null dereference',
        rationale: 'getUser() may return undefined; guard before accessing .id.',
        suggestion: 'Add an early return when the user is missing.',
        confidence: 'high',
      },
      {
        severity: 'minor',
        category: 'style',
        file_path: 'src/x.ts',
        message: 'Rename variable for clarity',
      },
    ],
    degradations: ['Could not open src/legacy.ts (outside the diff).'],
  };

  const result = validateFindings(good);

  assert.equal(result.verdict, 'risks');
  assert.equal(result.summary, good.summary);
  assert.equal(result.findings.length, 2);

  const first = result.findings[0];
  assert.equal(first?.severity, 'major');
  assert.equal(first?.category, 'bug');
  assert.equal(first?.filePath, 'src/users/service.ts');
  assert.equal(first?.lineStart, 42);
  assert.equal(first?.lineEnd, 45);
  assert.equal(first?.confidence, 'high');

  assert.equal(result.requirementsCoverage?.length, 2);
  assert.equal(result.requirementsCoverage?.[0]?.status, 'met');
  assert.deepEqual(result.degradations, good.degradations);
});

void test('accepts an empty findings list with an ok verdict', () => {
  const result = validateFindings({
    verdict: 'ok',
    findings: [],
    summary: 'Looks good; no issues found.',
  });
  assert.equal(result.verdict, 'ok');
  assert.deepEqual(result.findings, []);
  assert.equal(result.requirementsCoverage, undefined);
});

void test('rejects an unknown severity with a useful message', () => {
  const bad = {
    verdict: 'risks',
    summary: 'nope',
    findings: [{ severity: 'blocker', category: 'bug', file_path: 'a.ts', message: 'x' }],
  };

  assert.throws(
    () => validateFindings(bad),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Invalid review findings/);
      assert.match(err.message, /severity/);
      return true;
    },
  );
});

void test('rejects a finding missing required fields', () => {
  const bad = {
    verdict: 'risks',
    summary: 'incomplete finding',
    findings: [{ severity: 'minor', category: 'bug', file_path: 'a.ts' }],
  };

  assert.throws(
    () => validateFindings(bad),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /message/);
      return true;
    },
  );
});

void test('rejects a missing required verdict', () => {
  const bad = { summary: 'ok', findings: [] };
  assert.throws(() => validateFindings(bad), /verdict/);
});

void test('rejects extra top-level properties', () => {
  const bad = { verdict: 'ok', summary: 'ok', findings: [], surprise: true };
  assert.throws(() => validateFindings(bad), /Invalid review findings/);
});

void test('rejects a non-object input', () => {
  assert.throws(() => validateFindings(null), /Invalid review findings/);
});
