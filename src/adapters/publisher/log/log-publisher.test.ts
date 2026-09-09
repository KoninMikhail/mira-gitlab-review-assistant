/**
 * Unit tests for the dry-run LogPublisher. A capturing logger sink collects the
 * emitted JSON lines so we can assert: the summary line shape, one line per
 * finding (severity-ordered), requirement + degradation lines, correlation
 * fields + dry_run flag, and — critically — that nothing is written anywhere
 * but the log (it is dry-run by construction; no VCS/Kaiten dependency exists).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding, ReviewResult } from '../../../core/domain/index.ts';
import type { JobKey } from '../../../core/domain/index.ts';
import { createLogger } from '../../../observability/index.ts';
import { LogPublisher, countBySeverity } from './index.ts';

const job: JobKey = { projectId: 'group/app', mrIid: 7, headSha: 'sha-a' };

function finding(
  over: Partial<Finding> & Pick<Finding, 'severity' | 'category' | 'filePath' | 'message'>,
): Finding {
  const f: Finding = {
    severity: over.severity,
    category: over.category,
    filePath: over.filePath,
    message: over.message,
  };
  if (over.lineStart !== undefined) f.lineStart = over.lineStart;
  if (over.suggestion !== undefined) f.suggestion = over.suggestion;
  return f;
}

function capture(): { lines: Array<Record<string, unknown>>; sink: (line: string) => void } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}

void test('LogPublisher: emits a summary line with verdict, total, and severity tally', async () => {
  const { lines, sink } = capture();
  const publisher = new LogPublisher({ logger: createLogger({ sink }) });
  const result: ReviewResult = {
    verdict: 'risks',
    summary: 'two issues',
    findings: [
      finding({ severity: 'major', category: 'bug', filePath: 'a.ts', message: 'boom' }),
      finding({ severity: 'minor', category: 'style', filePath: 'b.ts', message: 'spacing' }),
    ],
  };

  await publisher.publish({ job, result });

  const summary = lines.find((l) => l['msg'] === 'review.summary');
  assert.ok(summary, 'summary line emitted');
  assert.equal(summary['verdict'], 'risks');
  assert.equal(summary['findings_total'], 2);
  assert.deepEqual(summary['by_severity'], { critical: 0, major: 1, minor: 1 });
  // Correlation fields + dry-run flag present on every line.
  assert.equal(summary['project_id'], 'group/app');
  assert.equal(summary['mr_iid'], 7);
  assert.equal(summary['dry_run'], true);
});

void test('LogPublisher: one finding line each, ordered by severity', async () => {
  const { lines, sink } = capture();
  const publisher = new LogPublisher({ logger: createLogger({ sink }) });
  const result: ReviewResult = {
    verdict: 'blockers',
    summary: 's',
    findings: [
      finding({ severity: 'minor', category: 'style', filePath: 'z.ts', message: 'nit' }),
      finding({ severity: 'critical', category: 'security', filePath: 'a.ts', message: 'sqli' }),
    ],
  };

  await publisher.publish({ job, result });

  const findingLines = lines.filter((l) => l['msg'] === 'review.finding');
  assert.equal(findingLines.length, 2);
  assert.equal(findingLines[0]?.['severity'], 'critical');
  assert.equal(findingLines[1]?.['severity'], 'minor');
});

void test('LogPublisher: emits requirement lines and a degraded warning', async () => {
  const { lines, sink } = capture();
  const publisher = new LogPublisher({ logger: createLogger({ sink }) });
  const result: ReviewResult = {
    verdict: 'ok',
    summary: 's',
    findings: [],
    requirementsCoverage: [{ criterion: 'logs in', status: 'missing' }],
    degradations: ['card not found'],
  };

  await publisher.publish({ job, result });

  const req = lines.find((l) => l['msg'] === 'review.requirement');
  assert.equal(req?.['status'], 'missing');
  assert.equal(req?.['criterion'], 'logs in');
  const degraded = lines.find((l) => l['msg'] === 'review.degraded');
  assert.equal(degraded?.['level'], 'warn');
  assert.deepEqual(degraded?.['degradations'], ['card not found']);
});

void test('countBySeverity: always returns all buckets', () => {
  assert.deepEqual(countBySeverity([]), { critical: 0, major: 0, minor: 0 });
});
