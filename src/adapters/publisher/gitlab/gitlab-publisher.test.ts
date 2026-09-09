/**
 * Unit tests for the idempotent GitLabPublisher. Uses in-memory fakes — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding, JobKey, ReviewResult } from '../../../core/domain/index.ts';
import { findingFingerprint } from '../../../core/idempotency/fingerprint.ts';
import {
  FINDING_MARKER_RE,
  GitLabPublisher,
  SUMMARY_MARKER,
  findingMarker,
  fingerprintFromDiscussion,
} from './index.ts';
import { FakeIgnoreStore, FakeVcsWriter } from '../../../core/ports/fakes.ts';
import { presenceAckResult } from '../../../core/presence/index.ts';
import { unavailableReviewResult } from '../../../core/unavailable-review.ts';

const job: JobKey = { projectId: 'group/app', mrIid: 42, headSha: 'abc123def456' };

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
  if (over.rationale !== undefined) f.rationale = over.rationale;
  if (over.suggestion !== undefined) f.suggestion = over.suggestion;
  return f;
}

function sampleResult(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: over.verdict ?? 'risks',
    summary: over.summary ?? 'two issues found',
    findings: over.findings ?? [
      finding({
        severity: 'major',
        category: 'bug',
        filePath: 'src/a.ts',
        message: 'null deref',
        lineStart: 10,
      }),
      finding({
        severity: 'nit',
        category: 'style',
        filePath: 'src/b.ts',
        message: 'spacing',
        lineStart: 3,
      }),
    ],
    ...(over.requirementsCoverage !== undefined
      ? { requirementsCoverage: over.requirementsCoverage }
      : {}),
    ...(over.degradations !== undefined ? { degradations: over.degradations } : {}),
  };
}

void test('GitLabPublisher: first publish creates summary note and finding discussions', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const result = sampleResult();

  await publisher.publish({ job, result });

  const notes = await writer.listNotes(job.projectId, job.mrIid);
  assert.equal(notes.length, 1);
  assert.ok(notes[0]?.body.includes(SUMMARY_MARKER));
  assert.ok(notes[0]?.body.includes('**Risks**'));
  assert.ok(notes[0]?.body.includes('two issues found'));

  const discussions = await writer.listDiscussions(job.projectId, job.mrIid);
  assert.equal(discussions.length, 2);

  for (const f of result.findings) {
    const fp = findingFingerprint(f);
    const discussion = discussions.find((d) => fingerprintFromDiscussion(d) === fp);
    assert.ok(discussion, `discussion for ${fp}`);
    assert.ok(discussion.notes[0]?.body.includes(findingMarker(fp)));
    assert.equal(discussion.resolved, false);
  }
});

void test('GitLabPublisher: re-publish updates summary and does not duplicate discussions', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const result = sampleResult();

  await publisher.publish({ job, result });
  const notesAfterFirst = await writer.listNotes(job.projectId, job.mrIid);
  const summaryId = notesAfterFirst[0]?.id;
  const discussionsAfterFirst = await writer.listDiscussions(job.projectId, job.mrIid);

  const updated = sampleResult({ summary: 'updated summary text' });
  await publisher.publish({ job, result: updated });

  const notesAfterSecond = await writer.listNotes(job.projectId, job.mrIid);
  assert.equal(notesAfterSecond.length, 1);
  assert.equal(notesAfterSecond[0]?.id, summaryId);
  assert.ok(notesAfterSecond[0]?.body.includes('updated summary text'));

  const discussionsAfterSecond = await writer.listDiscussions(job.projectId, job.mrIid);
  assert.equal(discussionsAfterSecond.length, discussionsAfterFirst.length);
  for (const d of discussionsAfterFirst) {
    assert.ok(
      discussionsAfterSecond.some((x) => x.id === d.id),
      `discussion ${d.id} preserved`,
    );
  }
});

void test('GitLabPublisher: removed finding resolves its discussion', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const first = sampleResult();

  await publisher.publish({ job, result: first });
  const removedFp = findingFingerprint(first.findings[0]!);
  const discussionsAfterFirst = await writer.listDiscussions(job.projectId, job.mrIid);
  const removedDiscussion = discussionsAfterFirst.find(
    (d) => fingerprintFromDiscussion(d) === removedFp,
  );
  assert.ok(removedDiscussion);

  const second = sampleResult({ findings: [first.findings[1]!] });
  await publisher.publish({ job, result: second });

  const discussionsAfterSecond = await writer.listDiscussions(job.projectId, job.mrIid);
  const resolved = discussionsAfterSecond.find((d) => d.id === removedDiscussion.id);
  assert.equal(resolved?.resolved, true);
});

void test('GitLabPublisher: muted finding is skipped and prior discussion is resolved', async () => {
  const writer = new FakeVcsWriter();
  const ignoreStore = new FakeIgnoreStore();
  const publisher = new GitLabPublisher({ writer, ignoreStore });
  const result = sampleResult();
  const mutedFinding = result.findings[0]!;
  const mutedFp = findingFingerprint(mutedFinding);

  await publisher.publish({ job, result });
  const beforeMute = await writer.listDiscussions(job.projectId, job.mrIid);
  const mutedDiscussion = beforeMute.find((d) => fingerprintFromDiscussion(d) === mutedFp);
  assert.ok(mutedDiscussion);

  await ignoreStore.ignore(job.projectId, job.mrIid, mutedFp);
  await publisher.publish({ job, result });

  const discussions = await writer.listDiscussions(job.projectId, job.mrIid);
  assert.equal(
    discussions.filter((d) => fingerprintFromDiscussion(d) === mutedFp).length,
    1,
    'no duplicate for muted fingerprint',
  );
  const after = discussions.find((d) => d.id === mutedDiscussion.id);
  assert.equal(after?.resolved, true);

  const activeFp = findingFingerprint(result.findings[1]!);
  const active = discussions.find((d) => fingerprintFromDiscussion(d) === activeFp);
  assert.equal(active?.resolved, false);
});

void test('GitLabPublisher: inline position when resolvePosition returns one', async () => {
  const writer = new FakeVcsWriter();
  const position = {
    baseSha: 'base',
    startSha: 'start',
    headSha: job.headSha,
    newPath: 'src/a.ts',
    newLine: 10,
  };
  const publisher = new GitLabPublisher({
    writer,
    resolvePosition: (_j, finding) => (finding.filePath === 'src/a.ts' ? position : undefined),
  });
  const result = sampleResult({ findings: [resultFinding()] });

  await publisher.publish({ job, result });

  const discussions = await writer.listDiscussions(job.projectId, job.mrIid);
  assert.equal(discussions.length, 1);
  assert.deepEqual(writer.positions.get(discussions[0]!.id), position);
});

void test('GitLabPublisher: general discussion without inline position', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const result = sampleResult({ findings: [resultFinding()] });

  await publisher.publish({ job, result });

  const discussions = await writer.listDiscussions(job.projectId, job.mrIid);
  assert.equal(discussions.length, 1);
  assert.equal(writer.positions.has(discussions[0]!.id), false);
  assert.ok(discussions[0]?.notes[0]?.body.includes('`src/a.ts:10`'));
});

void test('GitLabPublisher: creates discussions in deterministic order', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const findings = [
    finding({ severity: 'nit', category: 'style', filePath: 'z.ts', message: 'z', lineStart: 1 }),
    finding({
      severity: 'blocker',
      category: 'security',
      filePath: 'a.ts',
      message: 'sqli',
      lineStart: 5,
    }),
    finding({ severity: 'major', category: 'bug', filePath: 'm.ts', message: 'bug', lineStart: 2 }),
  ];
  const result = sampleResult({ findings });

  await publisher.publish({ job, result });

  const discussions = await writer.listDiscussions(job.projectId, job.mrIid);
  const fps = discussions.map((d) => fingerprintFromDiscussion(d));
  const expected = findings
    .slice()
    .sort((a, b) => {
      const order = ['blocker', 'major', 'minor', 'nit'] as const;
      const bySev = order.indexOf(a.severity) - order.indexOf(b.severity);
      if (bySev !== 0) return bySev;
      const byPath = a.filePath.localeCompare(b.filePath);
      if (byPath !== 0) return byPath;
      return (a.lineStart ?? 0) - (b.lineStart ?? 0);
    })
    .map((f) => findingFingerprint(f));
  assert.deepEqual(fps, expected);
});

void test('findingMarker regex round-trips fingerprint', () => {
  const fp = findingFingerprint(
    finding({ severity: 'major', category: 'bug', filePath: 'x.ts', message: 'm' }),
  );
  const body = findingMarker(fp) + '\nbody';
  const match = FINDING_MARKER_RE.exec(body);
  assert.equal(match?.[1], fp);
});

void test('GitLabPublisher: unavailable review is a playful note, not OK / 0 findings', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const summary =
    'Псс, я тут. Хотела всё как следует проревьюить, но ключи меня предали.\n\nКогда ключи обновят — позови меня: `@mira review`.';
  const result: ReviewResult = {
    verdict: 'ok',
    summary,
    findings: [],
    degradations: ['engine-unavailable'],
  };

  await publisher.publish({ job, result });

  const notes = await writer.listNotes(job.projectId, job.mrIid);
  assert.equal(notes.length, 1);
  const body = notes[0]?.body ?? '';
  assert.ok(body.includes(SUMMARY_MARKER));
  assert.ok(body.includes('ключи меня предали'));
  assert.ok(body.includes('@mira review'));
  assert.equal(body.includes('**OK**'), false);
  assert.equal(body.includes('**Findings:**'), false);
  assert.equal(body.includes('### Degradations'), false);
  assert.equal((await writer.listDiscussions(job.projectId, job.mrIid)).length, 0);
});

void test('GitLabPublisher: presence ack is playful, stable on wait retry, updates on kind change', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });
  const wait = presenceAckResult('wait-joke', 'wait');
  const green = presenceAckResult('green-joke', 'green');

  await publisher.publish({ job, result: wait });
  const first = (await writer.listNotes(job.projectId, job.mrIid))[0]?.body ?? '';
  assert.ok(first.includes(SUMMARY_MARKER));
  assert.ok(first.includes('wait-joke'));
  assert.ok(first.includes(`<!-- mira:ack:${job.headSha}:wait -->`));
  assert.equal(first.includes('**OK**'), false);

  await publisher.publish({ job, result: presenceAckResult('wait-joke-2', 'wait') });
  const second = (await writer.listNotes(job.projectId, job.mrIid))[0]?.body ?? '';
  assert.equal(second, first);

  await publisher.publish({ job, result: green });
  const third = (await writer.listNotes(job.projectId, job.mrIid))[0]?.body ?? '';
  assert.ok(third.includes('green-joke'));
  assert.ok(third.includes(`<!-- mira:ack:${job.headSha}:green -->`));
});

void test('GitLabPublisher: verdict ok approves the reviewed SHA', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });

  await publisher.publish({ job, result: sampleResult({ verdict: 'ok', findings: [] }) });

  assert.deepEqual(writer.approvals, [
    { action: 'approve', projectId: job.projectId, mrIid: job.mrIid, sha: job.headSha },
  ]);
});

void test('GitLabPublisher: risks and blockers unapprove the bot', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });

  await publisher.publish({ job, result: sampleResult({ verdict: 'risks' }) });
  await publisher.publish({
    job,
    result: sampleResult({ verdict: 'blockers', findings: [resultFinding()] }),
  });

  assert.deepEqual(
    writer.approvals.map((item) => item.action),
    ['unapprove', 'unapprove'],
  );
});

void test('GitLabPublisher: presence and unavailable reviews skip approval', async () => {
  const writer = new FakeVcsWriter();
  const publisher = new GitLabPublisher({ writer });

  await publisher.publish({ job, result: presenceAckResult('wait-joke', 'wait') });
  await publisher.publish({ job, result: presenceAckResult('green-joke', 'green') });
  await publisher.publish({
    job,
    result: unavailableReviewResult('engine down'),
  });

  assert.equal(writer.approvals.length, 0);
});

void test('GitLabPublisher: approval failure does not fail comment publish', async () => {
  const writer = new FakeVcsWriter();
  writer.approveFail = new Error('HTTP 403');
  const warnings: Array<{ message: string; err?: unknown }> = [];
  const publisher = new GitLabPublisher({
    writer,
    logger: {
      info() {},
      warn(message, fields) {
        warnings.push({ message, err: fields?.['err'] });
      },
      error() {},
    },
  });

  await publisher.publish({ job, result: sampleResult({ verdict: 'ok', findings: [] }) });

  const notes = await writer.listNotes(job.projectId, job.mrIid);
  assert.equal(notes.length, 1);
  assert.equal(writer.approvals.length, 0);
  assert.equal(warnings[0]?.message, 'gitlab.approval_failed');
  assert.equal(warnings[0]?.err, 'HTTP 403');
});

function resultFinding(): Finding {
  return finding({
    severity: 'major',
    category: 'bug',
    filePath: 'src/a.ts',
    message: 'null deref',
    lineStart: 10,
  });
}
