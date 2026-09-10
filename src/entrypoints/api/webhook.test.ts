/**
 * Unit tests for GitLab webhook parsing, job mapping, and HTTP receiver.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectPolicy } from '../../core/policy/types.ts';
import {
  createWebhookServer,
  mrEventToJob,
  parseWebhookEvent,
  verifyToken,
  type MrWebhookEvent,
} from './index.ts';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const now = (): Date => NOW;

function testPolicy(overrides: Partial<ProjectPolicy['reviewOn']> = {}): ProjectPolicy {
  return {
    reviewOn: {
      open: true,
      ready: true,
      push: false,
      reopen: true,
      manual: true,
      ...overrides,
    },
    strictness: 'balanced',
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 60_000, estimate: 'bytes' },
    decomposition: { mode: 'single' },
    model: 'cursor-grok-4.6-high-fast',
  };
}

function mrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'merge_request',
    project: { id: 42, path_with_namespace: 'group/app' },
    object_attributes: {
      iid: 7,
      action: 'open',
      state: 'opened',
      work_in_progress: false,
      source_branch: 'feature/x',
      target_branch: 'main',
      title: 'Test MR',
      last_commit: { id: 'sha-open-1' },
    },
    ...overrides,
  };
}

void test('verifyToken accepts matching token', () => {
  assert.equal(verifyToken('secret-value', 'secret-value'), true);
});

void test('verifyToken rejects mismatched token', () => {
  assert.equal(verifyToken('wrong', 'secret-value'), false);
  assert.equal(verifyToken(undefined, 'secret-value'), false);
});

void test('verifyToken skips verification when secret is empty', () => {
  assert.equal(verifyToken(undefined, ''), true);
  assert.equal(verifyToken('anything', ''), true);
});

void test('parseWebhookEvent maps MR open (non-draft)', () => {
  const event = parseWebhookEvent('Merge Request Hook', mrPayload());
  assert.ok(event);
  assert.equal(event.kind, 'mr');
  if (event.kind !== 'mr') {
    return;
  }
  assert.equal(event.projectId, 'group/app');
  assert.equal(event.mrIid, 7);
  assert.equal(event.headSha, 'sha-open-1');
  assert.equal(event.action, 'open');
  assert.equal(event.isDraft, false);
  assert.equal(event.draftTransition, false);
  assert.equal(event.hasNewCommits, false);
});

void test('mrEventToJob open non-draft yields open trigger', () => {
  const parsed = parseWebhookEvent('Merge Request Hook', mrPayload());
  assert.ok(parsed && parsed.kind === 'mr');
  const job = mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now);
  assert.deepEqual(job, {
    projectId: 'group/app',
    mrIid: 7,
    headSha: 'sha-open-1',
    trigger: 'open',
    enqueuedAt: NOW.toISOString(),
  });
});

void test('mrEventToJob open draft yields undefined', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'open',
        work_in_progress: true,
        last_commit: { id: 'sha-draft' },
      },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  assert.equal(mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now), undefined);
});

void test('mrEventToJob update draft transition yields ready', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'update',
        work_in_progress: false,
        last_commit: { id: 'sha-ready' },
      },
      changes: { draft: { previous: true, current: false } },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  const job = mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now);
  assert.equal(job?.trigger, 'ready');
});

void test('mrEventToJob update with oldrev yields push when enabled', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'update',
        work_in_progress: false,
        oldrev: 'prev-sha',
        last_commit: { id: 'sha-push' },
      },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  const job = mrEventToJob(parsed as MrWebhookEvent, testPolicy({ push: true }), now);
  assert.equal(job?.trigger, 'push');
});

void test('mrEventToJob update label-only yields undefined', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'update',
        work_in_progress: false,
        last_commit: { id: 'sha-label' },
      },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  assert.equal(mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now), undefined);
});

void test('mrEventToJob reopen yields reopen trigger', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'reopen',
        work_in_progress: false,
        last_commit: { id: 'sha-reopen' },
      },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  const job = mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now);
  assert.equal(job?.trigger, 'reopen');
});

void test('mrEventToJob close yields undefined', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'close',
        last_commit: { id: 'sha-close' },
      },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  assert.equal(mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now), undefined);
});

void test('mrEventToJob respects reviewOn.push=false', () => {
  const parsed = parseWebhookEvent(
    'Merge Request Hook',
    mrPayload({
      object_attributes: {
        iid: 7,
        action: 'update',
        oldrev: 'prev',
        last_commit: { id: 'sha-no-push' },
      },
    }),
  );
  assert.ok(parsed && parsed.kind === 'mr');
  assert.equal(mrEventToJob(parsed as MrWebhookEvent, testPolicy(), now), undefined);
});

void test('parseWebhookEvent extracts MR note with author', () => {
  const event = parseWebhookEvent('Note Hook', {
    object_kind: 'note',
    project: { id: 1, path_with_namespace: 'group/app' },
    object_attributes: {
      id: 88,
      note: '@mira review',
      noteable_type: 'MergeRequest',
      discussion_id: 'disc-1',
      action: 'create',
      system: false,
    },
    merge_request: { iid: 3, last_commit: { id: 'note-sha' } },
    user: { username: 'dev.user' },
  });
  assert.deepEqual(event, {
    kind: 'note',
    projectId: 'group/app',
    mrIid: 3,
    headSha: 'note-sha',
    body: '@mira review',
    action: 'create',
    system: false,
    noteId: 88,
    discussionId: 'disc-1',
    author: 'dev.user',
  });
});

void test('parseWebhookEvent defaults note action and captures discussion id', () => {
  const event = parseWebhookEvent('Note Hook', {
    object_kind: 'note',
    project: { path_with_namespace: 'group/app' },
    object_attributes: {
      note: 'это точно баг?',
      noteable_type: 'MergeRequest',
      discussion_id: 'abc',
    },
    merge_request: { iid: 3, last_commit: { id: 'note-sha' } },
  });
  assert.ok(event && event.kind === 'note');
  assert.equal(event.action, 'create');
  assert.equal(event.system, false);
  assert.equal(event.discussionId, 'abc');
  assert.equal(event.author, undefined);
});

void test('parseWebhookEvent ignores non-MR notes', () => {
  assert.equal(
    parseWebhookEvent('Note Hook', {
      object_kind: 'note',
      project: { id: 1 },
      object_attributes: { note: 'hi', noteable_type: 'Issue' },
    }),
    undefined,
  );
});

void test('parseWebhookEvent returns undefined for malformed payloads', () => {
  assert.equal(parseWebhookEvent('Merge Request Hook', null), undefined);
  assert.equal(parseWebhookEvent('Merge Request Hook', 'bad'), undefined);
  assert.equal(
    parseWebhookEvent('Merge Request Hook', { object_kind: 'merge_request' }),
    undefined,
  );
  assert.equal(parseWebhookEvent(undefined, mrPayload()), undefined);
});

void test('webhook server rejects bad token with 401', async () => {
  const enqueued: unknown[] = [];
  const server = createWebhookServer({
    secret: 'top-secret',
    policyFor: () => testPolicy(),
    enqueue: (job) => {
      enqueued.push(job);
    },
    now,
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;

  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-token': 'wrong',
      },
      body: JSON.stringify(mrPayload()),
    });
    assert.equal(res.status, 401);
    assert.equal(enqueued.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('webhook server enqueues MR job and responds 202', async () => {
  const enqueued: unknown[] = [];
  const server = createWebhookServer({
    secret: 'top-secret',
    policyFor: () => testPolicy(),
    enqueue: (job) => {
      enqueued.push(job);
    },
    now,
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;

  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-token': 'top-secret',
      },
      body: JSON.stringify(mrPayload()),
    });
    assert.equal(res.status, 202);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0], {
      projectId: 'group/app',
      mrIid: 7,
      headSha: 'sha-open-1',
      trigger: 'open',
      enqueuedAt: NOW.toISOString(),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('webhook server healthz returns ok', async () => {
  const server = createWebhookServer({
    secret: '',
    policyFor: () => testPolicy(),
    enqueue: () => {},
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;

  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
