/**
 * Unit tests for structured logging, secret redaction, and in-memory metrics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLogger,
  createMetricRegistry,
  METRIC_NAMES,
  redact,
} from './index.ts';

const REAL_TOKEN = 'glpat-abcdefghijklmnopqrstuvwxyz123456';

void test('createLogger: emits one JSON line with ts, level, msg, and merged base fields', () => {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    base: { review_id: 'r-9f3', project_id: 42 },
  });

  logger.info('engine.start', { stage: 'engine.start', run_id: 'run-1' });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  assert.equal(parsed['level'], 'info');
  assert.equal(parsed['msg'], 'engine.start');
  assert.equal(parsed['review_id'], 'r-9f3');
  assert.equal(parsed['project_id'], 42);
  assert.equal(parsed['stage'], 'engine.start');
  assert.equal(parsed['run_id'], 'run-1');
  assert.equal(typeof parsed['ts'], 'string');
});

void test('createLogger: child merges fields into every line', () => {
  const lines: string[] = [];
  const root = createLogger({
    sink: (line) => lines.push(line),
    base: { review_id: 'r-child' },
  });
  const child = root.child({ run_id: 'run-child', agent_id: 'agent-1' });

  child.warn('job.retry', { stage: 'job.retry' });

  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  assert.equal(parsed['level'], 'warn');
  assert.equal(parsed['review_id'], 'r-child');
  assert.equal(parsed['run_id'], 'run-child');
  assert.equal(parsed['agent_id'], 'agent-1');
  assert.equal(parsed['stage'], 'job.retry');
});

void test('redact and logger: mask diff, token fields, oauth2 URLs, and long secrets', () => {
  const diffBody = 'line one\nline two\nline three';
  const oauthUrl = `https://oauth2:${REAL_TOKEN}@gitlab.example.com/group/app.git`;
  const redacted = redact({
    diff: diffBody,
    prompt: 'secret prompt body',
    token: REAL_TOKEN,
    apiKey: REAL_TOKEN,
    authorization: `Bearer ${REAL_TOKEN}`,
    nested: { git_token: REAL_TOKEN },
    message: oauthUrl,
    bareSecret: REAL_TOKEN,
  }) as Record<string, unknown>;

  assert.equal(redacted['diff'], `<diff ${Buffer.byteLength(diffBody, 'utf8')} bytes>`);
  assert.equal(
    redacted['prompt'],
    `<prompt ${Buffer.byteLength('secret prompt body', 'utf8')} bytes>`,
  );
  assert.equal(redacted['token'], '***');
  assert.equal(redacted['apiKey'], '***');
  assert.equal(redacted['authorization'], '***');
  assert.deepEqual(redacted['nested'], { git_token: '***' });
  assert.equal(redacted['message'], `https://oauth2:***@gitlab.example.com/group/app.git`);
  assert.equal(redacted['bareSecret'], '***');

  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });
  logger.info('context.built', {
    diff: diffBody,
    token: REAL_TOKEN,
    repoUrl: oauthUrl,
  });

  const output = lines[0] ?? '';
  assert.ok(!output.includes(REAL_TOKEN));
  assert.ok(!output.includes(diffBody));
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.equal(parsed['diff'], `<diff ${Buffer.byteLength(diffBody, 'utf8')} bytes>`);
  assert.equal(parsed['token'], '***');
  assert.equal(parsed['repoUrl'], `https://oauth2:***@gitlab.example.com/group/app.git`);
});

void test('createMetricRegistry: counter increments and appears in snapshot', () => {
  const registry = createMetricRegistry();
  const counter = registry.counter(METRIC_NAMES.reviewsTotal, { trigger: 'poll', result: 'ok' });

  counter.inc();
  counter.inc(2);

  const snap = registry.snapshot();
  const entry = snap.counters.find(
    (item) =>
      item.name === METRIC_NAMES.reviewsTotal &&
      item.labels['trigger'] === 'poll' &&
      item.labels['result'] === 'ok',
  );
  assert.ok(entry !== undefined);
  assert.equal(entry?.value, 3);
});

void test('createMetricRegistry: histogram observe aggregates in snapshot', () => {
  const registry = createMetricRegistry();
  const histogram = registry.histogram(METRIC_NAMES.reviewDurationSeconds);

  histogram.observe(1);
  histogram.observe(2);
  histogram.observe(3);

  const snap = registry.snapshot();
  const entry = snap.histograms.find((item) => item.name === METRIC_NAMES.reviewDurationSeconds);
  assert.ok(entry !== undefined);
  assert.equal(entry?.count, 3);
  assert.equal(entry?.sum, 6);
  assert.equal(entry?.min, 1);
  assert.equal(entry?.max, 3);
});
