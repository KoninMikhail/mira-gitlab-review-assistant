import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNAVAILABLE_REVIEW_FOOTER,
  UNAVAILABLE_REVIEW_MESSAGES,
  UNAVAILABLE_REVIEW_NOTE,
  isUnavailableReview,
  pickUnavailableReviewSummary,
  unavailableReviewResult,
} from './unavailable-review.ts';

void test('pickUnavailableReviewSummary: maps 0 and ~1 onto first and last messages', () => {
  const first = pickUnavailableReviewSummary(() => 0);
  const last = pickUnavailableReviewSummary(() => 0.999);
  assert.equal(first, `${UNAVAILABLE_REVIEW_MESSAGES[0]}\n\n${UNAVAILABLE_REVIEW_FOOTER}`);
  assert.equal(
    last,
    `${UNAVAILABLE_REVIEW_MESSAGES[UNAVAILABLE_REVIEW_MESSAGES.length - 1]}\n\n${UNAVAILABLE_REVIEW_FOOTER}`,
  );
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
