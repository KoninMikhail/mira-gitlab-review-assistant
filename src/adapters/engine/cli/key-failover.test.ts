/**
 * Unit tests for Cursor key failover. Fake engines only; no cursor-agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewContext, ReviewResult } from '../../../core/domain/index.ts';
import type { AssistantEngine, AssistantRequest, ReviewEngine } from '../../../core/ports/index.ts';
import { isRetryableCursorKeyError, KeyFailoverEngine } from './key-failover.ts';

const OK: ReviewResult = { verdict: 'ok', summary: 'fine', findings: [] };

function context(): ReviewContext {
  return {
    job: { projectId: 'g/p', mrIid: 1, headSha: 'abc' },
    title: 't',
    description: 'd',
    sourceBranch: 's',
    targetBranch: 'main',
    changedFiles: [],
    diff: '',
  };
}

function fakeEngine(
  onReview: (key: string) => Promise<ReviewResult>,
  apiKey: string,
): ReviewEngine & AssistantEngine {
  return {
    review: () => onReview(apiKey),
    reply: () => Promise.resolve('ok'),
  };
}

void test('isRetryableCursorKeyError: non-zero exit yes, timeout and bad JSON no', () => {
  assert.equal(
    isRetryableCursorKeyError(new Error('cursor-agent exited with code 1:\nunauthorized')),
    true,
  );
  assert.equal(
    isRetryableCursorKeyError(new Error('cursor-agent timed out after 600000ms')),
    false,
  );
  assert.equal(
    isRetryableCursorKeyError(
      new Error('Review degraded after retry: cursor-agent output could not be validated.'),
    ),
    false,
  );
});

void test('KeyFailoverEngine uses the second key after a dead first key', async () => {
  const used: string[] = [];
  const engine = new KeyFailoverEngine({
    keys: () => ['dead', 'live'],
    create: (apiKey) =>
      fakeEngine((key) => {
        used.push(key);
        if (key === 'dead') {
          return Promise.reject(new Error('cursor-agent exited with code 1:\ninvalid api key'));
        }
        return Promise.resolve(OK);
      }, apiKey),
  });

  const result = await engine.review(context());
  assert.equal(result.summary, 'fine');
  assert.deepEqual(used, ['dead', 'live']);
});

void test('KeyFailoverEngine does not fail over on timeout', async () => {
  const used: string[] = [];
  const engine = new KeyFailoverEngine({
    keys: () => ['slow', 'other'],
    create: (apiKey) =>
      fakeEngine((key) => {
        used.push(key);
        return Promise.reject(new Error('cursor-agent timed out after 600000ms'));
      }, apiKey),
  });

  await assert.rejects(engine.review(context()), /timed out/);
  assert.deepEqual(used, ['slow']);
});

void test('KeyFailoverEngine starts the next job on the last good key', async () => {
  const used: string[] = [];
  const sticky = { lastGood: 0 };
  let firstDead = true;
  const engine = new KeyFailoverEngine({
    keys: () => ['a', 'b'],
    sticky,
    create: (apiKey) =>
      fakeEngine((key) => {
        used.push(key);
        if (key === 'a' && firstDead) {
          firstDead = false;
          return Promise.reject(new Error('cursor-agent exited with code 1:\n401'));
        }
        return Promise.resolve(OK);
      }, apiKey),
  });

  await engine.review(context());
  await engine.review(context());
  assert.deepEqual(used, ['a', 'b', 'b']);
  assert.equal(sticky.lastGood, 1);
});

void test('KeyFailoverEngine throws when every key fails', async () => {
  const engine = new KeyFailoverEngine({
    keys: () => ['a', 'b'],
    create: () =>
      fakeEngine(
        () => Promise.reject(new Error('cursor-agent exited with code 1:\nunauthorized')),
        'x',
      ),
  });
  await assert.rejects(engine.review(context()), /exited with code 1/);
});

void test('KeyFailoverEngine.reply failovers the same way', async () => {
  const used: string[] = [];
  const engine = new KeyFailoverEngine({
    keys: () => ['dead', 'live'],
    create: (apiKey) => ({
      review: () => Promise.resolve(OK),
      reply: () => {
        used.push(apiKey);
        if (apiKey === 'dead') {
          return Promise.reject(new Error('cursor-agent exited with code 1:\nunauthorized'));
        }
        return Promise.resolve('hello');
      },
    }),
  });
  const request: AssistantRequest = {
    kind: 'thread',
    context: context(),
    thread: [],
    userMessage: 'hi',
  };
  assert.equal(await engine.reply(request), 'hello');
  assert.deepEqual(used, ['dead', 'live']);
});
