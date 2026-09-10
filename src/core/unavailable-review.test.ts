import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNAVAILABLE_REVIEW_FOOTER,
  UNAVAILABLE_REVIEW_MESSAGES,
  UNAVAILABLE_REVIEW_NOTE,
  classifyUnavailableError,
  isUnavailableReview,
  pickUnavailableReviewSummary,
  unavailableReviewResult,
} from './unavailable-review.ts';

void test('classifyUnavailableError: model / network / auth / output', () => {
  assert.equal(classifyUnavailableError('cursor-agent rejected model:\nCannot use this model'), 'model');
  assert.equal(classifyUnavailableError('cursor-agent timed out after 600000ms'), 'network');
  assert.equal(classifyUnavailableError('cursor-agent-via-proxy: cannot resolve xray'), 'network');
  assert.equal(classifyUnavailableError('cursor-agent rejected api key:\nInvalid User API Key'), 'auth');
  assert.equal(classifyUnavailableError('no parseable findings: no findings.json'), 'output');
});

void test('pickUnavailableReviewSummary: maps 0 and ~1 onto first and last auth messages', () => {
  const first = pickUnavailableReviewSummary('auth', () => 0);
  const last = pickUnavailableReviewSummary('auth', () => 0.999);
  assert.equal(first, `${UNAVAILABLE_REVIEW_MESSAGES[0]}\n\n${UNAVAILABLE_REVIEW_FOOTER}`);
  assert.equal(
    last,
    `${UNAVAILABLE_REVIEW_MESSAGES[UNAVAILABLE_REVIEW_MESSAGES.length - 1]}\n\n${UNAVAILABLE_REVIEW_FOOTER}`,
  );
});

void test('pickUnavailableReviewSummary: output kind does not blame keys and keeps detail', () => {
  const text = pickUnavailableReviewSummary('output', () => 0, 'no parseable findings');
  assert.match(text, /не ключи|findings/i);
  assert.match(text, /Технически: no parseable findings/);
  assert.doesNotMatch(text, /Когда ключи обновят/);
});

void test('isUnavailableReview: only the sentinel degradation counts', () => {
  assert.equal(isUnavailableReview(unavailableReviewResult('x')), true);
  assert.equal(isUnavailableReview({ verdict: 'ok', summary: 'x', findings: [] }), false);
  assert.equal(
    isUnavailableReview({
      verdict: 'ok',
      summary: 'x',
      findings: [],
      degradations: ['Skipped review units: u1'],
    }),
    false,
  );
  assert.equal(UNAVAILABLE_REVIEW_NOTE, 'engine-unavailable');
});
