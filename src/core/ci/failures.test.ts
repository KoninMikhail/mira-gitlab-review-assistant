import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CiJob } from '../ports/index.ts';
import { FakeVcsCiReader } from '../ports/fakes.ts';
import {
  CI_TRACE_MAX_CHARS,
  ciContextForKind,
  excerptTrace,
  loadCiFailures,
  requiredBlockingFailures,
} from './failures.ts';

function job(overrides: Partial<CiJob>): CiJob {
  return {
    id: 1,
    name: 'test',
    status: 'failed',
    when: 'on_success',
    allowFailure: false,
    ...overrides,
  };
}

void test('requiredBlockingFailures: skips manual and allow_failure', () => {
  assert.deepEqual(
    requiredBlockingFailures([
      job({ id: 1, name: 'test' }),
      job({ id: 2, name: 'lint', allowFailure: true }),
      job({ id: 3, name: 'deploy', when: 'manual' }),
      job({ id: 4, name: 'build', status: 'success' }),
    ]).map((item) => item.name),
    ['test'],
  );
});

void test('excerptTrace: keeps short logs; tails long ones on a line boundary', () => {
  assert.equal(excerptTrace('ok\n'), 'ok');
  const long = `${'a'.repeat(CI_TRACE_MAX_CHARS)}\nTAIL`;
  const excerpt = excerptTrace(long, 8);
  assert.equal(excerpt.startsWith('…\n'), true);
  assert.match(excerpt, /TAIL/);
  assert.ok(excerpt.length <= 8 + 2);
});

void test('loadCiFailures: attaches excerpts; missing trace is not fatal', async () => {
  const reader = new FakeVcsCiReader();
  reader.traces.set(1, 'FAIL boom');
  reader.traceFail = undefined;

  const withLog = await loadCiFailures(reader, 'group/app', [job({ id: 1, name: 'test' })]);
  assert.equal(withLog[0]?.excerpt, 'FAIL boom');

  const failing = new FakeVcsCiReader();
  failing.traceFail = new Error('404');
  const without = await loadCiFailures(failing, 'group/app', [job({ id: 9, name: 'test' })]);
  assert.equal(without[0]?.jobName, 'test');
  assert.equal(without[0]?.excerpt, undefined);
});

void test('ciContextForKind: red keeps failures; green/timeout drop them', () => {
  const failures = [{ jobName: 'test', status: 'failed', excerpt: 'boom' }];
  assert.deepEqual(ciContextForKind('red', failures)?.failures, failures);
  assert.deepEqual(ciContextForKind('green', failures)?.failures, []);
  assert.equal(ciContextForKind('wait', failures), undefined);
});
