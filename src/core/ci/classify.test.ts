import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CiJob } from '../ports/index.ts';
import {
  CI_GRACE_MS,
  CI_WAIT_TIMEOUT_MS,
  ciOutcomeMayChange,
  classifyRequiredCi,
  foldCiIntoPromptVersion,
  isExplicitReview,
  isOptionalManualJob,
  resolvePresenceKind,
  skipsCiWait,
} from './classify.ts';

function job(overrides: Partial<CiJob> & Pick<CiJob, 'status'>): CiJob {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'test',
    status: overrides.status,
    when: overrides.when ?? 'on_success',
    allowFailure: overrides.allowFailure ?? false,
  };
}

void test('classifyRequiredCi: ignores when:manual even if failed or pending', () => {
  assert.equal(
    classifyRequiredCi([
      job({ name: 'test', status: 'success' }),
      job({ name: 'deploy', status: 'manual', when: 'manual' }),
    ]),
    'green',
  );
  assert.equal(
    classifyRequiredCi([
      job({ name: 'test', status: 'success' }),
      job({ name: 'deploy', status: 'failed', when: 'manual' }),
    ]),
    'green',
  );
  assert.equal(classifyRequiredCi([job({ status: 'pending', when: 'manual' })]), 'none');
  assert.equal(isOptionalManualJob(job({ status: 'manual', when: 'manual' })), true);
});

void test('classifyRequiredCi: running / green / red / none', () => {
  assert.equal(classifyRequiredCi([]), 'none');
  assert.equal(classifyRequiredCi([job({ status: 'running' })]), 'running');
  assert.equal(classifyRequiredCi([job({ status: 'pending' })]), 'running');
  assert.equal(classifyRequiredCi([job({ status: 'success' })]), 'green');
  assert.equal(classifyRequiredCi([job({ status: 'skipped' })]), 'green');
  assert.equal(classifyRequiredCi([job({ status: 'failed' })]), 'red');
  assert.equal(classifyRequiredCi([job({ status: 'canceled' })]), 'red');
});

void test('classifyRequiredCi: allow_failure failure does not paint the wait red', () => {
  assert.equal(
    classifyRequiredCi([
      job({ name: 'test', status: 'success' }),
      job({ name: 'flaky', status: 'failed', allowFailure: true }),
    ]),
    'green',
  );
  assert.equal(
    classifyRequiredCi([
      job({ name: 'test', status: 'failed' }),
      job({ name: 'flaky', status: 'failed', allowFailure: true }),
    ]),
    'red',
  );
});

void test('resolvePresenceKind: grace treats missing pipelines as wait, then none', () => {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(
    resolvePresenceKind({ jobs: [], nowMs: t0, enqueuedAtMs: t0, graceMs: CI_GRACE_MS }),
    'wait',
  );
  assert.equal(
    resolvePresenceKind({
      jobs: [],
      nowMs: t0 + CI_GRACE_MS,
      enqueuedAtMs: t0,
      graceMs: CI_GRACE_MS,
    }),
    'none',
  );
});

void test('resolvePresenceKind: stuck required jobs become timeout', () => {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(
    resolvePresenceKind({
      jobs: [job({ status: 'running' })],
      nowMs: t0 + CI_WAIT_TIMEOUT_MS - 1,
      enqueuedAtMs: t0,
    }),
    'wait',
  );
  assert.equal(
    resolvePresenceKind({
      jobs: [job({ status: 'running' })],
      nowMs: t0 + CI_WAIT_TIMEOUT_MS,
      enqueuedAtMs: t0,
    }),
    'timeout',
  );
});

void test('skipsCiWait / isExplicitReview: only manual and chatops', () => {
  assert.equal(skipsCiWait('manual'), true);
  assert.equal(skipsCiWait('chatops'), true);
  assert.equal(skipsCiWait('open'), false);
  assert.equal(skipsCiWait('poll'), false);
  assert.equal(isExplicitReview('manual'), true);
  assert.equal(isExplicitReview('chatops'), true);
  assert.equal(isExplicitReview('push'), false);
});

void test('foldCiIntoPromptVersion / ciOutcomeMayChange', () => {
  assert.equal(foldCiIntoPromptVersion('review.v1', undefined), 'review.v1');
  assert.equal(foldCiIntoPromptVersion('review.v1', 'wait'), 'review.v1');
  assert.equal(foldCiIntoPromptVersion('review.v1', 'red'), 'review.v1+ci.red');
  assert.equal(foldCiIntoPromptVersion('review.v1+python@abc', 'green'), 'review.v1+python@abc+ci.green');
  assert.equal(ciOutcomeMayChange('red'), true);
  assert.equal(ciOutcomeMayChange('timeout'), true);
  assert.equal(ciOutcomeMayChange('green'), false);
  assert.equal(ciOutcomeMayChange('wait'), false);
});
